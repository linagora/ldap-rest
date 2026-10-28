import { expect } from 'chai';
import nock from 'nock';
import request from 'supertest';
import type winston from 'winston';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import MigrationProxy from '../../../src/plugins/twake/migrationProxy';
import { LDAP_ENV_VARS, skipIfMissingEnvVars } from '../../helpers/env';
import { outboundCalls } from '../../helpers/metrics';
import { waitFor } from '../../helpers/waitFor';

type Log = { level: string; entry: Record<string, unknown> };

const capture = (plugin: MigrationProxy, logs: Log[]): void => {
  const at =
    (level: string) =>
    (entry: unknown): void => {
      logs.push({
        level,
        entry:
          typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>)
            : { message: entry },
      });
    };
  plugin.logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as winston.Logger;
};

describe('Migration proxy plugin', () => {
  const url = 'http://migration-proxy.test:8000';
  const users = 'ou=users,dc=example,dc=com';
  const dn = `uid=alice,${users}`;
  const user = { objectClass: ['top', 'inetOrgPerson'], uid: 'alice' };
  const alice = { ...user, mail: 'alice@example.com' };
  let dm: DM;
  let plugin: MigrationProxy;
  let logs: Log[];
  /** The calls the proxy received, in order */
  let calls: string[];

  before(() => {
    nock.disableNetConnect();
  });

  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    dm.config.migration_proxy_url = `${url}/`;
    dm.config.migration_proxy_token = 'secret';
    dm.config.migration_proxy_branch = [users];
    dm.config.migration_proxy_retry_attempts = 3;
    dm.config.migration_proxy_retry_delay = 10;
    plugin = new MigrationProxy(dm);
    logs = [];
    calls = [];
    capture(plugin, logs);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  const at = (level: string): Log[] => logs.filter(l => l.level === level);
  const proxy = (): nock.Scope => {
    const scope = nock(url, { reqheaders: { authorization: 'Bearer secret' } });
    scope.on('request', req => calls.push(`${req.method} ${req.path}`));
    return scope;
  };
  const change = (
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    at = dn
  ): Promise<void> =>
    Promise.resolve(
      plugin.hooks.onLdapEntryChange!(at, before as never, after as never, {})
    );

  describe('configuration', () => {
    it('refuses to start without the proxy URL or a branch', () => {
      delete dm.config.migration_proxy_url;
      expect(() => new MigrationProxy(dm)).to.throw(/migration_proxy_url/);
      dm.config.migration_proxy_url = url;
      dm.config.migration_proxy_branch = [];
      expect(() => new MigrationProxy(dm)).to.throw(/--migration-proxy-branch/);
    });

    it('reads its defaults: 5 attempts, 1 s apart and growing', () => {
      delete dm.config.migration_proxy_retry_attempts;
      delete dm.config.migration_proxy_retry_delay;
      const p = new MigrationProxy(dm) as unknown as {
        retryAttempts: number;
        retryDelay: number;
      };
      expect(p.retryAttempts).to.equal(5);
      expect(p.retryDelay).to.equal(1000);
    });
  });

  describe('an entry gaining its address', () => {
    it('is put on the list when created, with the token', async () => {
      proxy().put('/migratedUsers/alice%40example.com').reply(204);

      await change(null, alice);

      expect(calls).to.deep.equal(['PUT /migratedUsers/alice%40example.com']);
      expect(at('error')).to.have.length(0);
      expect(
        at('info').map(l => [l.entry.event, l.entry.result])
      ).to.deep.equal([['onLdapEntryChange:add', 'success']]);
    });

    it('is put on the list when the mail comes later', async () => {
      proxy().put('/migratedUsers/alice%40example.com').reply(204);

      await change(user, alice);

      expect(calls).to.have.length(1);
    });

    it('is put on the list with every address: other mails and aliases', async () => {
      proxy()
        .put('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/a%40example.com')
        .reply(204)
        .put('/migratedUsers/alias%40example.com')
        .reply(204);

      await change(null, {
        ...user,
        mail: ['alice@example.com', 'a@example.com'],
        mailAlternateAddress: 'smtp:alias@example.com',
      });

      expect(calls.sort()).to.deep.equal([
        'PUT /migratedUsers/a%40example.com',
        'PUT /migratedUsers/alias%40example.com',
        'PUT /migratedUsers/alice%40example.com',
      ]);
    });

    it('sends an address once, however many attributes carry it', async () => {
      proxy()
        .put('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/alias%40example.com')
        .reply(204);

      await change(null, {
        ...user,
        mail: ['smtp:alice@example.com', 'Alice@example.com'],
        mailAlternateAddress: ['alice@example.com', 'alias@example.com'],
      });

      expect(calls.sort()).to.deep.equal([
        'PUT /migratedUsers/alias%40example.com',
        'PUT /migratedUsers/alice%40example.com',
      ]);
    });

    it('is left alone outside the branches', async () => {
      await change(null, alice, 'uid=alice,ou=applicative,dc=example,dc=com');

      expect(logs).to.have.length(0);
    });

    it('is left alone when nothing but another attribute changed', async () => {
      await change({ ...alice, sn: 'A' }, { ...alice, sn: 'B' });

      expect(logs).to.have.length(0);
    });

    it('retries the call while the proxy answers 503, then logs the error', async () => {
      proxy().put('/migratedUsers/alice%40example.com').times(3).reply(503);

      await change(null, alice);

      expect(calls).to.have.length(3);
      expect(at('warn').map(l => l.entry.attempt)).to.deep.equal([1, 2]);
      expect(at('error')).to.have.length(1);
      expect(at('error')[0].entry).to.include({
        event: 'onLdapEntryChange:add',
        http_status: 503,
        attempts: 3,
      });
    });

    it('logs a refusal without retrying it', async () => {
      proxy()
        .put('/migratedUsers/alice%40example.com')
        .reply(400, { message: 'Invalid username' });

      await change(null, alice);

      expect(calls).to.have.length(1);
      expect(at('warn')).to.have.length(0);
      expect(at('error')).to.have.length(1);
    });

    it('logs an unreachable proxy, the call counted', async () => {
      const before = await outboundCalls('migrationProxy', 'error');
      proxy()
        .put('/migratedUsers/alice%40example.com')
        .replyWithError('connection refused');

      await change(null, alice);

      expect(at('error')).to.have.length(1);
      expect(await outboundCalls('migrationProxy', 'error')).to.equal(
        before + 1
      );
    });
  });

  describe('an entry keeping its address', () => {
    const renamed = { ...user, mail: 'alice@new.example.com' };

    it('follows a migrated user: the new address put first, the old one taken off', async () => {
      proxy()
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/alice%40new.example.com')
        .reply(204)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);

      await change(alice, renamed);

      expect(calls).to.deep.equal([
        'HEAD /migratedUsers/alice%40example.com',
        'PUT /migratedUsers/alice%40new.example.com',
        'DELETE /migratedUsers/alice%40example.com',
      ]);
      expect(at('error')).to.have.length(0);
    });

    it('keeps the old address when the new one could not be put', async () => {
      proxy()
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/alice%40new.example.com')
        .reply(400);

      await change(alice, renamed);

      expect(calls).to.deep.equal([
        'HEAD /migratedUsers/alice%40example.com',
        'PUT /migratedUsers/alice%40new.example.com',
      ]);
      expect(at('error')).to.have.length(1);
    });

    it('leaves a user of the old system to the migration', async () => {
      proxy().head('/migratedUsers/alice%40example.com').reply(404);

      await change(alice, renamed);

      expect(calls).to.deep.equal(['HEAD /migratedUsers/alice%40example.com']);
      expect(at('debug').map(l => l.entry.result)).to.deep.equal(['ignored']);
      expect(at('error')).to.have.length(0);
    });

    it('asks again while the proxy answers 503, and changes nothing once it has not said', async () => {
      proxy().head('/migratedUsers/alice%40example.com').times(3).reply(503);

      await change(alice, renamed);

      expect(calls).to.have.length(3);
      expect(at('error')).to.have.length(1);
      expect(at('error')[0].entry).to.include({
        event: 'onLdapEntryChange:update',
        mail: 'alice@example.com',
      });
      expect(at('error')[0].entry.added).to.deep.equal([
        'alice@new.example.com',
      ]);
    });

    it('takes a change of case alone as no change', async () => {
      await change(alice, { ...user, mail: 'Alice@Example.com' });

      expect(calls).to.have.length(0);
      expect(logs).to.have.length(0);
    });

    it('neither puts nor takes off an alias equal to the mail', async () => {
      await change(alice, {
        ...alice,
        mailAlternateAddress: 'ALICE@example.com',
      });
      await change(
        { ...alice, mailAlternateAddress: 'alice@example.com' },
        alice
      );

      expect(calls).to.have.length(0);
      expect(logs).to.have.length(0);
    });

    it('puts an alias gained by a migrated user, takes off one lost', async () => {
      proxy()
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/new%40example.com')
        .reply(204)
        .delete('/migratedUsers/old%40example.com')
        .reply(204);

      await change(
        { ...alice, mailAlternateAddress: ['old@example.com'] },
        { ...alice, mailAlternateAddress: ['new@example.com'] }
      );

      expect(calls).to.deep.equal([
        'HEAD /migratedUsers/alice%40example.com',
        'PUT /migratedUsers/new%40example.com',
        'DELETE /migratedUsers/old%40example.com',
      ]);
    });

    it('handles the writes of one entry one after the other', async () => {
      // The add's PUT is slow: the rename's HEAD must still come after it
      proxy()
        .put('/migratedUsers/alice%40example.com')
        .delay(50)
        .reply(204)
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/alice%40new.example.com')
        .reply(204)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);

      await Promise.all([change(null, alice), change(alice, renamed)]);

      expect(calls).to.deep.equal([
        'PUT /migratedUsers/alice%40example.com',
        'HEAD /migratedUsers/alice%40example.com',
        'PUT /migratedUsers/alice%40new.example.com',
        'DELETE /migratedUsers/alice%40example.com',
      ]);
    });
  });

  describe('an entry losing its address', () => {
    it('is taken off the list when deleted, every address', async () => {
      proxy()
        .delete('/migratedUsers/alice%40example.com')
        .reply(204)
        .delete('/migratedUsers/alias%40example.com')
        .reply(204);

      await change(
        { ...alice, mailAlternateAddress: 'alias@example.com' },
        null
      );

      expect(calls.sort()).to.deep.equal([
        'DELETE /migratedUsers/alias%40example.com',
        'DELETE /migratedUsers/alice%40example.com',
      ]);
      expect(at('info').map(l => l.entry.event)).to.deep.equal([
        'onLdapEntryChange:delete',
        'onLdapEntryChange:delete',
      ]);
    });

    it('is taken off the list when the mail is removed', async () => {
      proxy().delete('/migratedUsers/alice%40example.com').reply(204);

      await change(alice, user);

      expect(calls).to.deep.equal([
        'DELETE /migratedUsers/alice%40example.com',
      ]);
    });
  });

  describe('health', () => {
    it('is ok when the proxy says so', async () => {
      proxy().get('/healthcheck').reply(200, { status: 'healthy' });
      expect(await plugin.health()).to.equal('ok');
      expect(calls).to.deep.equal(['GET /healthcheck']);
    });

    it('is degraded when the proxy says so or does not answer', async () => {
      nock(url).get('/healthcheck').reply(503);
      expect(await plugin.health()).to.equal('degraded');
      nock(url).get('/healthcheck').replyWithError('connection refused');
      expect(await plugin.health()).to.equal('degraded');
    });

    it('is degraded when the proxy takes too long', async () => {
      nock(url).get('/healthcheck').delayConnection(2500).reply(200);
      const started = Date.now();
      expect(await plugin.health()).to.equal('degraded');
      expect(Date.now() - started).to.be.below(2000);
    });
  });

  describe('with the directory', function () {
    let base: string;
    let aliceDn: string;
    let bobDn: string;
    let scope: nock.Scope;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
      base = process.env.DM_LDAP_BASE as string;
      aliceDn = `uid=migalice,${base}`;
      bobDn = `uid=migbob,${base}`;
      nock.enableNetConnect('127.0.0.1');
    });

    after(() => {
      nock.disableNetConnect();
    });

    beforeEach(async () => {
      dm.config.migration_proxy_branch = [base];
      plugin = new MigrationProxy(dm);
      capture(plugin, logs);
      await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
      await dm.registerPlugin('migrationProxy', plugin);
      // Every write of the tests reaches the proxy, the teardown's included
      scope = proxy()
        .persist()
        .put(/^\/migratedUsers\//)
        .reply(204)
        .delete(/^\/migratedUsers\//)
        .reply(204);
    });

    afterEach(async () => {
      for (const target of [aliceDn, bobDn])
        try {
          await dm.ldap.delete(target);
        } catch {
          // not there
        }
      await waitFor(
        () =>
          (plugin as unknown as { queues: Map<string, unknown> }).queues
            .size === 0,
        { what: 'the teardown calls' }
      );
      scope.persist(false);
    });

    const add = (target: string, attributes: Record<string, unknown>) =>
      dm.ldap.add(target, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Someone',
        sn: 'S',
        ...attributes,
      });

    it('tells the proxy about an account written, renamed and deleted', async () => {
      scope.head(/^\/migratedUsers\//).reply(204);

      await add(aliceDn, { uid: 'migalice', mail: 'migalice@test.org' });
      await waitFor(() => calls.length === 1, { what: 'the PUT' });
      expect(calls).to.deep.equal(['PUT /migratedUsers/migalice%40test.org']);

      await dm.ldap.modify(aliceDn, { replace: { mail: 'alice.m@test.org' } });
      await waitFor(() => calls.length === 4, { what: 'the rename calls' });
      expect(calls.slice(1)).to.deep.equal([
        'HEAD /migratedUsers/migalice%40test.org',
        'PUT /migratedUsers/alice.m%40test.org',
        'DELETE /migratedUsers/migalice%40test.org',
      ]);

      await dm.ldap.delete(aliceDn);
      await waitFor(() => calls.length === 5, { what: 'the DELETE' });
      expect(calls[4]).to.equal('DELETE /migratedUsers/alice.m%40test.org');
    });

    it('says nothing of an account without mail', async () => {
      await add(bobDn, { uid: 'migbob' });
      await dm.ldap.modify(bobDn, { replace: { sn: 'C' } });
      await dm.ldap.delete(bobDn);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(calls).to.have.length(0);
      expect(logs).to.have.length(0);
    });

    describe('GET /api/v1/users/:user/mail-migration', () => {
      beforeEach(async () => {
        await add(aliceDn, { uid: 'migalice', mail: 'migalice@test.org' });
        await add(bobDn, { uid: 'migbob' });
        await waitFor(() => calls.length === 1, { what: 'the PUT of the add' });
      });

      it('answers true for a migrated user', async () => {
        scope.head('/migratedUsers/migalice%40test.org').reply(204);
        const res = await request(dm.app)
          .get('/api/v1/users/migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status, JSON.stringify(res.body)).to.equal(200);
        expect(res.body).to.deep.equal({ migrated: true });
      });

      it('answers false for a user of the old system', async () => {
        scope.head('/migratedUsers/migalice%40test.org').reply(404);
        const res = await request(dm.app)
          .get('/api/v1/users/migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ migrated: false });
      });

      it('answers 404 for an unknown user, 400 for one without mail', async () => {
        const unknown = await request(dm.app)
          .get('/api/v1/users/nobody/mail-migration')
          .set('Accept', 'application/json');
        expect(unknown.status).to.equal(404);
        const noMail = await request(dm.app)
          .get('/api/v1/users/migbob/mail-migration')
          .set('Accept', 'application/json');
        expect(noMail.status).to.equal(400);
      });

      it('answers 502 when the proxy fails, without asking again', async () => {
        scope.head('/migratedUsers/migalice%40test.org').reply(503);
        const res = await request(dm.app)
          .get('/api/v1/users/migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status).to.equal(502);
        expect(calls.filter(c => c.startsWith('HEAD'))).to.have.length(1);
        expect(at('error').map(l => l.entry.event)).to.deep.equal([
          'getMigrationStatus',
        ]);
      });

      it('refuses a filter in the user name', async () => {
        const res = await request(dm.app)
          .get('/api/v1/users/*)(uid=migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status).to.equal(404);
      });
    });
  });
});
