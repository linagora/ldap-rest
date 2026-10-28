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
  const dn = 'uid=alice,ou=users,dc=example,dc=com';
  const user = { objectClass: ['top', 'inetOrgPerson'], uid: 'alice' };
  let dm: DM;
  let plugin: MigrationProxy;
  let logs: Log[];

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
    dm.config.migration_proxy_retry_attempts = 3;
    dm.config.migration_proxy_retry_delay = 10;
    plugin = new MigrationProxy(dm);
    logs = [];
    capture(plugin, logs);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  const at = (level: string): Log[] => logs.filter(l => l.level === level);
  const entryChange = (
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null
  ): Promise<void> =>
    Promise.resolve(
      plugin.hooks.onLdapEntryChange!(dn, before as never, after as never, {})
    );

  describe('configuration', () => {
    it('refuses to start without the proxy URL', () => {
      delete dm.config.migration_proxy_url;
      expect(() => new MigrationProxy(dm)).to.throw(/migration_proxy_url/);
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

  describe('an account gaining a mail', () => {
    it('is put on the migrated list when created, with the token', async () => {
      const scope = nock(url, {
        reqheaders: { authorization: 'Bearer secret' },
      })
        .put('/migratedUsers/alice%40example.com')
        .reply(204);

      await entryChange(null, { ...user, mail: 'alice@example.com' });

      expect(scope.isDone()).to.equal(true);
      expect(at('error')).to.have.length(0);
      expect(
        at('info').map(l => [l.entry.event, l.entry.result])
      ).to.deep.equal([['onLdapEntryChange:add', 'success']]);
    });

    it('is put on the list when the mail comes later', async () => {
      const scope = nock(url)
        .put('/migratedUsers/alice%40example.com')
        .reply(204);

      await entryChange(user, { ...user, mail: 'alice@example.com' });

      expect(scope.isDone()).to.equal(true);
    });

    it('takes the first mail value only', async () => {
      const scope = nock(url).put('/migratedUsers/a%40example.com').reply(204);

      await entryChange(null, {
        ...user,
        mail: ['a@example.com', 'b@example.com'],
      });

      expect(scope.isDone()).to.equal(true);
    });

    it('leaves a group alone', async () => {
      await entryChange(null, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'list',
        mail: 'list@example.com',
        member: [dn],
      });

      expect(logs).to.have.length(0);
    });

    it('is left alone when nothing but another attribute changed', async () => {
      const before = { ...user, mail: 'alice@example.com', sn: 'A' };
      await entryChange(before, { ...before, sn: 'B' });

      expect(logs).to.have.length(0);
    });

    it('retries the call while the proxy answers 503, then logs the error', async () => {
      const scope = nock(url)
        .put('/migratedUsers/alice%40example.com')
        .times(3)
        .reply(503);

      await entryChange(null, { ...user, mail: 'alice@example.com' });

      expect(scope.isDone()).to.equal(true);
      expect(at('warn').map(l => l.entry.attempt)).to.deep.equal([1, 2]);
      expect(at('error')).to.have.length(1);
      expect(at('error')[0].entry).to.include({
        event: 'onLdapEntryChange:add',
        http_status: 503,
        attempts: 3,
      });
    });

    it('logs a refusal without retrying it', async () => {
      const scope = nock(url)
        .put('/migratedUsers/alice%40example.com')
        .reply(400, { message: 'Invalid username' });

      await entryChange(null, { ...user, mail: 'alice@example.com' });

      expect(scope.isDone()).to.equal(true);
      expect(at('warn')).to.have.length(0);
      expect(at('error')).to.have.length(1);
    });

    it('logs an unreachable proxy, the call counted', async () => {
      const before = await outboundCalls('migrationProxy', 'error');
      nock(url)
        .put('/migratedUsers/alice%40example.com')
        .replyWithError('connection refused');

      await entryChange(null, { ...user, mail: 'alice@example.com' });

      expect(at('error')).to.have.length(1);
      expect(await outboundCalls('migrationProxy', 'error')).to.equal(
        before + 1
      );
    });
  });

  describe('an account changing its mail', () => {
    const before = { ...user, mail: 'alice@example.com' };
    const after = { ...user, mail: 'alice@new.example.com' };

    it('follows a migrated user: the new address put first, the old one taken off', async () => {
      const calls: string[] = [];
      const scope = nock(url)
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/alice%40new.example.com')
        .reply(204)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);
      scope.on('request', req => calls.push(`${req.method} ${req.path}`));

      await entryChange(before, after);

      expect(scope.isDone()).to.equal(true);
      expect(calls).to.deep.equal([
        'HEAD /migratedUsers/alice%40example.com',
        'PUT /migratedUsers/alice%40new.example.com',
        'DELETE /migratedUsers/alice%40example.com',
      ]);
      expect(at('error')).to.have.length(0);
    });

    it('leaves a user of the old system to the migration', async () => {
      const scope = nock(url)
        .head('/migratedUsers/alice%40example.com')
        .reply(404);

      await entryChange(before, after);

      expect(scope.isDone()).to.equal(true);
      expect(nock.pendingMocks()).to.have.length(0);
      expect(at('debug').map(l => l.entry.result)).to.deep.equal(['ignored']);
      expect(at('error')).to.have.length(0);
    });

    it('changes nothing when the proxy cannot say, and logs it', async () => {
      nock(url).head('/migratedUsers/alice%40example.com').reply(500);

      await entryChange(before, after);

      expect(at('error')).to.have.length(1);
      expect(at('error')[0].entry).to.include({
        event: 'onLdapEntryChange:rename',
        oldmail: 'alice@example.com',
        newmail: 'alice@new.example.com',
      });
    });

    it('ignores a change of case alone as the proxy does not', async () => {
      // James usernames are case-insensitive, the list is keyed by the
      // string: the proxy is told, so that the key follows the directory
      const scope = nock(url)
        .head('/migratedUsers/alice%40example.com')
        .reply(204)
        .put('/migratedUsers/Alice%40example.com')
        .reply(204)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);

      await entryChange(before, { ...user, mail: 'Alice@example.com' });

      expect(scope.isDone()).to.equal(true);
    });
  });

  describe('an account losing its mail', () => {
    it('is taken off the list when deleted', async () => {
      const scope = nock(url)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);

      await entryChange({ ...user, mail: 'alice@example.com' }, null);

      expect(scope.isDone()).to.equal(true);
      expect(at('info').map(l => l.entry.event)).to.deep.equal([
        'onLdapEntryChange:delete',
      ]);
    });

    it('is taken off the list when the mail is removed', async () => {
      const scope = nock(url)
        .delete('/migratedUsers/alice%40example.com')
        .reply(204);

      await entryChange({ ...user, mail: 'alice@example.com' }, user);

      expect(scope.isDone()).to.equal(true);
    });

    it('does nothing for a deleted group', async () => {
      await entryChange(
        { objectClass: ['groupOfNames'], mail: 'list@example.com' },
        null
      );

      expect(logs).to.have.length(0);
    });
  });

  describe('health', () => {
    it('is ok when the proxy says so', async () => {
      const scope = nock(url, {
        reqheaders: { authorization: 'Bearer secret' },
      })
        .get('/healthcheck')
        .reply(200, { status: 'healthy' });
      expect(await plugin.health()).to.equal('ok');
      expect(scope.isDone()).to.equal(true);
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
      await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
      await dm.registerPlugin('migrationProxy', plugin);
    });

    afterEach(async () => {
      for (const target of [aliceDn, bobDn])
        try {
          await dm.ldap.delete(target);
        } catch {
          // not there
        }
    });

    it('tells the proxy about an account written, renamed and deleted', async () => {
      const calls: string[] = [];
      const scope = nock(url)
        .persist()
        .put(/^\/migratedUsers\//)
        .reply(204)
        .head(/^\/migratedUsers\//)
        .reply(204)
        .delete(/^\/migratedUsers\//)
        .reply(204);
      scope.on('request', req => calls.push(`${req.method} ${req.path}`));

      await dm.ldap.add(aliceDn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'migalice',
        cn: 'Alice',
        sn: 'A',
        mail: 'migalice@test.org',
      });
      await waitFor(() => calls.length === 1, { what: 'the PUT' });
      expect(calls).to.deep.equal(['PUT /migratedUsers/migalice%40test.org']);

      await dm.ldap.modify(aliceDn, {
        replace: { mail: 'alice.m@test.org' },
      });
      await waitFor(() => calls.length === 4, { what: 'the rename calls' });
      expect(calls.slice(1)).to.deep.equal([
        'HEAD /migratedUsers/migalice%40test.org',
        'PUT /migratedUsers/alice.m%40test.org',
        'DELETE /migratedUsers/migalice%40test.org',
      ]);

      await dm.ldap.delete(aliceDn);
      await waitFor(() => calls.length === 5, { what: 'the DELETE' });
      expect(calls[4]).to.equal('DELETE /migratedUsers/alice.m%40test.org');
      scope.persist(false);
    });

    it('says nothing of an account without mail', async () => {
      await dm.ldap.add(bobDn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'migbob',
        cn: 'Bob',
        sn: 'B',
      });
      await dm.ldap.modify(bobDn, { replace: { sn: 'C' } });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(nock.pendingMocks()).to.have.length(0);
      expect(at('error')).to.have.length(0);
      expect(at('info')).to.have.length(0);
    });

    describe('GET /api/v1/users/:user/mail-migration', () => {
      beforeEach(async () => {
        const added = nock(url)
          .put('/migratedUsers/migalice%40test.org')
          .reply(204);
        await dm.ldap.add(aliceDn, {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'migalice',
          cn: 'Alice',
          sn: 'A',
          mail: 'migalice@test.org',
        });
        await dm.ldap.add(bobDn, {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'migbob',
          cn: 'Bob',
          sn: 'B',
        });
        await waitFor(() => added.isDone(), { what: 'the PUT of the add' });
      });

      it('answers true for a migrated user', async () => {
        nock(url).head('/migratedUsers/migalice%40test.org').reply(204);
        const res = await request(dm.app)
          .get('/api/v1/users/migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status, JSON.stringify(res.body)).to.equal(200);
        expect(res.body).to.deep.equal({ migrated: true });
      });

      it('answers false for a user of the old system', async () => {
        nock(url).head('/migratedUsers/migalice%40test.org').reply(404);
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

      it('answers 502 when the proxy fails', async () => {
        nock(url).head('/migratedUsers/migalice%40test.org').reply(500);
        const res = await request(dm.app)
          .get('/api/v1/users/migalice/mail-migration')
          .set('Accept', 'application/json');
        expect(res.status).to.equal(502);
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
