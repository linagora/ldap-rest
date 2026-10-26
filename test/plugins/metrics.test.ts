import { expect } from 'chai';
import supertest from 'supertest';
import { Router } from 'express';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';
import Metrics from '../../src/plugins/metrics';
import { launchHooks } from '../../src/lib/utils';

describe('metrics', function () {
  this.timeout(20000);
  let dm: DM;
  let plugin: Metrics;

  const scrape = async (): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${plugin.port()!}/metrics`);
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.match(/^text\/plain/);
    return res.text();
  };

  /** The value of a sample line, `name{labels} value` */
  const sample = (text: string, name: string, labels: string): number => {
    const line = text
      .split('\n')
      .find(l =>
        labels ? l.startsWith(`${name}{${labels}} `) : l.startsWith(`${name} `)
      );
    expect(line, `${name}{${labels}}`).to.not.equal(undefined);
    return Number(line!.slice(line!.lastIndexOf(' ') + 1));
  };

  let cacheTtl: string | undefined;

  before(async () => {
    // The search cache is off by default; the counter needs it on
    cacheTtl = process.env.DM_LDAP_CACHE_TTL;
    process.env.DM_LDAP_CACHE_TTL = '60';
    dm = new DM();
    await dm.ready;
    dm.config.metrics_port = 0;
    plugin = new Metrics(dm);
    await dm.registerPlugin('metrics', plugin);
    dm.app.get('/things/:id', (_req, res) => {
      res.json({});
    });
    const mounted = Router();
    mounted.get('/x', (_req, res) => {
      res.json({});
    });
    dm.app.use('/t/:tenant', mounted);
    dm.setupErrorMiddleware();
  });

  after(async () => {
    if (cacheTtl === undefined) delete process.env.DM_LDAP_CACHE_TTL;
    else process.env.DM_LDAP_CACHE_TTL = cacheTtl;
    await plugin.close();
  });

  it('serves the process metrics and the pool on its own port', async () => {
    const text = await scrape();
    expect(text).to.include('process_cpu_seconds_total');
    expect(text).to.match(
      /^ldap_rest_ldap_pool_connections\{state="idle"\} \d/m
    );
    expect(text).to.match(/^ldap_rest_ldap_pool_waiting 0$/m);
    expect(text).to.match(/^ldap_rest_ldap_pool_max \d/m);
    expect(text).to.match(/^ldap_rest_unhandled_rejections_total 0$/m);
  });

  it('answers nothing else', async () => {
    const port = plugin.port()!;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).to.equal(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' }))
        .status
    ).to.equal(404);
  });

  it('times each request by route template and status, never by URL', async () => {
    // The instruments are the process's: what other suites counted stays
    const http = (text: string, suffix: string, labels: string): number =>
      text.includes(`{${labels}}`)
        ? sample(
            text,
            `ldap_rest_http_request_duration_seconds_${suffix}`,
            labels
          )
        : 0;
    const count = (text: string, labels: string): number =>
      http(text, 'count', labels);
    const before = await scrape();
    await supertest(dm.app).get('/things/42').expect(200);
    await supertest(dm.app).get('/things/43').expect(200);
    await supertest(dm.app).get('/nowhere/at/all').expect(404);
    await supertest(dm.app).get('/t/acme/x').expect(200);
    await supertest(dm.app).get('/T/other/x').expect(200);
    const text = await scrape();
    const matched = 'method="GET",route="/things/:id",status="200"';
    const unmatched = 'method="GET",route="none",status="404"';
    const mounted = 'method="GET",route="*/x",status="200"';
    expect(count(text, matched) - count(before, matched)).to.equal(2);
    expect(count(text, unmatched) - count(before, unmatched)).to.equal(1);
    expect(count(text, mounted) - count(before, mounted)).to.equal(2);
    expect(
      http(text, 'sum', matched) - http(before, 'sum', matched),
      'the time taken'
    ).to.be.above(0);
    expect(text).to.not.include('/things/42');
    expect(text).to.not.include('/nowhere');
    expect(text).to.not.include('acme');
  });

  it('times the directory operations and counts the cache', async () => {
    const before = await scrape();
    const read = (): Promise<unknown> =>
      dm.ldap.search({ scope: 'base', paged: false, attributes: ['1.1'] });
    await read();
    await read();
    const after = await scrape();
    const ok = 'operation="search",result="ok"';
    expect(
      operations(after, ok) - operations(before, ok),
      'one search sent, the second served by the cache'
    ).to.equal(1);
    expect(operations(after, 'operation="bind",result="ok"')).to.be.at.least(1);
    expect(
      sample(after, 'ldap_rest_ldap_search_cache_total', 'result="miss"')
    ).to.be.at.least(1);
    expect(
      sample(after, 'ldap_rest_ldap_search_cache_total', 'result="hit"')
    ).to.be.at.least(1);
    expect(after).to.match(/^ldap_rest_ldap_pool_wait_seconds_count [1-9]/m);
    await dm.ldap
      .search({ scope: 'base', paged: false }, 'cn=nothing,dc=nowhere')
      .then(() => undefined)
      .catch(() => undefined);
    const failed = await scrape();
    expect(
      operations(failed, 'operation="search",result="32"'),
      'a refusal is the directory answering, by its code'
    ).to.be.at.least(1);
    const error = 'operation="search",result="error"';
    expect(operations(failed, error) - operations(before, error)).to.equal(0);
  });

  /** The operation count under `labels`, 0 before the first sample */
  const operations = (text: string, labels: string): number =>
    text.includes(`{${labels}}`)
      ? sample(text, 'ldap_rest_ldap_operation_duration_seconds_count', labels)
      : 0;

  it('times each write by operation, a refusal by its code', async () => {
    const base = dm.config.ldap_base as string;
    const dn = `cn=metrics-probe,${base}`;
    const moved = `cn=metrics-probe-2,${base}`;
    const gone = `cn=metrics-probe-3,${base}`;
    const before = await scrape();
    await dm.ldap.add(dn, {
      objectClass: ['organizationalRole'],
      cn: 'metrics-probe',
    });
    await dm.ldap.modify(dn, { replace: { description: 'probe' } });
    await dm.ldap.rename(dn, 'cn=metrics-probe-2');
    await dm.ldap.move(moved, gone);
    await dm.ldap.delete(gone);
    await dm.ldap.delete(gone).then(
      () => expect.fail('deleted twice'),
      () => undefined
    );
    const after = await scrape();
    const expected = { add: 1, modify: 1, rename: 2, delete: 1 };
    for (const [operation, times] of Object.entries(expected)) {
      const labels = `operation="${operation}",result="ok"`;
      expect(
        operations(after, labels) - operations(before, labels),
        operation
      ).to.equal(times);
    }
    const refused = 'operation="delete",result="32"';
    expect(operations(after, refused) - operations(before, refused)).to.equal(
      1
    );
  });

  it('times a paged search by its pages, walked through or left early', async () => {
    const before = await scrape();
    const busy = dm.ldap.poolStats().busy;
    const left = (await dm.ldap.search({
      scope: 'sub',
      paged: { pageSize: 1 },
      attributes: ['1.1'],
    })) as AsyncGenerator<unknown>;
    for await (const page of left) {
      expect(page).to.not.equal(undefined);
      break;
    }
    expect(dm.ldap.poolStats().busy, 'released on the break').to.equal(busy);
    const walked = (await dm.ldap.search({
      scope: 'one',
      paged: { pageSize: 2 },
      attributes: ['1.1'],
    })) as AsyncGenerator<unknown>;
    let pages = 0;
    for await (const page of walked) {
      expect(page).to.not.equal(undefined);
      pages++;
    }
    expect(pages).to.be.at.least(1);
    expect(dm.ldap.poolStats().busy, 'released at the end').to.equal(busy);
    const after = await scrape();
    const ok = 'operation="search",result="ok"';
    expect(operations(after, ok) - operations(before, ok)).to.equal(2);
    const error = 'operation="search",result="error"';
    expect(operations(after, error) - operations(before, error)).to.equal(0);
  });

  it('reads the pool at scrape time, full and with a waiter', async () => {
    const max = dm.ldap.poolStats().max;
    expect(max).to.equal(dm.config.ldap_pool_size);
    const page = {
      scope: 'base' as const,
      paged: { pageSize: 1 },
      attributes: ['1.1'],
    };
    const held: AsyncGenerator<unknown>[] = [];
    for (let i = 0; i < max; i++) {
      const walk = (await dm.ldap.search(page)) as AsyncGenerator<unknown>;
      await walk.next();
      held.push(walk);
    }
    const waiting = dm.ldap.search(page);
    await new Promise(resolve => setImmediate(resolve));
    const full = await scrape();
    const pool = (text: string, name: string, labels = ''): number =>
      sample(text, `ldap_rest_ldap_pool_${name}`, labels);
    expect(pool(full, 'connections', 'state="busy"')).to.equal(max);
    expect(pool(full, 'connections', 'state="idle"')).to.equal(0);
    expect(pool(full, 'waiting')).to.equal(1);
    expect(pool(full, 'max')).to.equal(max);
    for (const walk of held) await walk.return(undefined);
    // A walk never started holds its connection: the generator's own
    // release runs only once it ran
    const served = (await waiting) as AsyncGenerator<unknown>;
    await served.next();
    await served.return(undefined);
    const after = await scrape();
    expect(pool(after, 'waiting')).to.equal(0);
    expect(pool(after, 'connections', 'state="busy"')).to.equal(0);
  });

  it('counts a hook that throws, by plugin and hook', async () => {
    class Broken extends DmPlugin {
      name = 'broken';
      hooks = {
        ldapadddone: (): void => {
          throw new Error('nothing to do with it');
        },
      };
    }
    await dm.registerPlugin('broken', new Broken(dm));
    await launchHooks(dm.hooks.ldapadddone, ['cn=x', {}]);
    const text = await scrape();
    expect(
      sample(
        text,
        'ldap_rest_hook_failures_total',
        'hook="ldapadddone",plugin="broken"'
      )
    ).to.equal(1);
  });

  it('refuses to start on a port in use', async () => {
    const other = new Metrics(dm);
    dm.config.metrics_port = plugin.port();
    await other.api(dm.app).then(
      () => expect.fail('two listeners on one port'),
      (err: NodeJS.ErrnoException) => expect(err.code).to.equal('EADDRINUSE')
    );
    dm.config.metrics_port = 0;
  });

  it('stops listening on close', async () => {
    const port = plugin.port()!;
    await plugin.close();
    await fetch(`http://127.0.0.1:${port}/metrics`).then(
      () => expect.fail('still listening'),
      () => undefined
    );
    expect(plugin.port()).to.equal(undefined);
  });
});
