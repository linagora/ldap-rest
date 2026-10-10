import { expect } from 'chai';
import nock from 'nock';
import type winston from 'winston';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';

/**
 * James reads its users from an LDAP replica that can lag behind the write
 * ldap-rest just made: a call about a user created or renamed a moment ago
 * fails until the replica catches up.
 */
describe('James Plugin - replication lag', () => {
  const url = 'http://james.retry.test:8000';
  const dn = 'uid=lag,ou=users,dc=example,dc=com';
  let dm: DM;
  let james: James;
  let logs: { level: string; entry: Record<string, unknown> }[];

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
    dm.config.james_webadmin_url = url;
    dm.config.james_retry_attempts = 3;
    dm.config.james_retry_delay = 10;
    james = new James(dm);
    logs = [];
    const capture =
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
    james.logger = {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    } as unknown as winston.Logger;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  const at = (level: string) => logs.filter(l => l.level === level);

  it('reads its defaults: 5 attempts, 1 s apart and growing', () => {
    const d = new DM();
    d.config.james_webadmin_url = url;
    delete d.config.james_retry_attempts;
    delete d.config.james_retry_delay;
    const plugin = new James(d) as unknown as {
      retryAttempts: number;
      retryDelay: number;
    };
    expect(plugin.retryAttempts).to.equal(5);
    expect(plugin.retryDelay).to.equal(1000);
  });

  it('retries a rename James refuses until it knows the new address', async () => {
    const scope = nock(url)
      .post('/users/old@test.org/rename/new@test.org')
      .query(true)
      .times(2)
      .reply(400, { message: 'new@test.org does not exist' })
      .post('/users/old@test.org/rename/new@test.org')
      .query(true)
      .reply(201, { taskId: 'task-1' });

    await james.hooks.onLdapMailChange!(dn, 'old@test.org', 'new@test.org');

    expect(scope.isDone()).to.be.true;
    expect(at('warn').map(l => l.entry.attempt)).to.deep.equal([1, 2]);
    expect(at('warn').every(l => l.entry.result === 'retry')).to.be.true;
    expect(at('error')).to.have.length(0);
    expect(
      at('info').some(
        l =>
          l.entry.event === 'onLdapMailChange' && l.entry.result === 'success'
      )
    ).to.be.true;
  });

  it('gives up after the last attempt, and only then logs an error', async () => {
    const scope = nock(url)
      .put('/quota/users/lag@test.org/size', '1000')
      .times(3)
      .reply(404, { message: 'User not found' });

    await james.hooks.onLdapQuotaChange!(dn, 'lag@test.org', 0, 1000);

    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(2);
    expect(at('error')).to.have.length(1);
    expect(at('error')[0].entry).to.include({
      event: 'onLdapQuotaChange',
      http_status: 404,
      attempts: 3,
    });
  });

  it('does not retry a failure the lag does not explain', async () => {
    const scope = nock(url)
      .put('/quota/users/lag@test.org/size', '1000')
      .reply(401);

    await james.hooks.onLdapQuotaChange!(dn, 'lag@test.org', 0, 1000);

    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(0);
    expect(at('error')).to.have.length(1);
    expect(at('error')[0].entry).to.include({ http_status: 401 });
    expect(at('error')[0].entry).to.not.have.property('attempts');
  });

  it('does not retry a server error', async () => {
    const scope = nock(url)
      .put('/address/aliases/lag@test.org/sources/a@test.org')
      .reply(500);

    await james.hooks.onLdapAliasChange!(
      dn,
      'lag@test.org',
      [],
      ['a@test.org']
    );

    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(0);
    expect(at('error')).to.have.length(1);
  });

  it('retries an alias added before James knows the user', async () => {
    const scope = nock(url)
      .put('/address/aliases/lag@test.org/sources/a@test.org')
      .reply(404)
      .put('/address/aliases/lag@test.org/sources/a@test.org')
      .reply(204);

    await james.hooks.onLdapAliasChange!(
      dn,
      'lag@test.org',
      [],
      ['a@test.org']
    );

    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(1);
    expect(at('error')).to.have.length(0);
  });

  it('does not retry a deletion', async () => {
    const scope = nock(url)
      .delete('/address/aliases/lag@test.org/sources/a@test.org')
      .reply(404);

    await james.hooks.onLdapAliasChange!(
      dn,
      'lag@test.org',
      ['a@test.org'],
      []
    );

    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(0);
  });

  it('leaves the other plugins of the Twake family without retries', async () => {
    // A bare TwakePlugin call, as calendar and drive make them: no
    // statuses to retry on, so one attempt whatever the answer
    const scope = nock(url).put('/some/resource').reply(404);
    await (
      james as unknown as {
        callWebAdminApi: (...args: unknown[]) => Promise<void>;
      }
    ).callWebAdminApi('test', `${url}/some/resource`, 'PUT', dn, null, {});
    expect(scope.isDone()).to.be.true;
    expect(at('warn')).to.have.length(0);
    expect(at('error')).to.have.length(1);
  });

  it('frees its concurrency slot while it waits', async () => {
    dm.config.james_concurrency = 1;
    dm.config.james_retry_delay = 300;
    james = Object.assign(new James(dm), { logger: james.logger });
    const order: string[] = [];
    nock(url)
      .put('/quota/users/slow@test.org/size')
      .reply(() => {
        order.push('slow:404');
        return [404, ''];
      })
      .put('/quota/users/slow@test.org/size')
      .reply(() => {
        order.push('slow:204');
        return [204, ''];
      })
      .put('/quota/users/other@test.org/size')
      .reply(() => {
        order.push('other:204');
        return [204, ''];
      });

    const slow = james.hooks.onLdapQuotaChange!(dn, 'slow@test.org', 0, 1);
    // Queued behind the first attempt of the slow one
    await new Promise(resolve => setTimeout(resolve, 50));
    const other = james.hooks.onLdapQuotaChange!(dn, 'other@test.org', 0, 1);
    await Promise.all([slow, other]);

    expect(order).to.deep.equal(['slow:404', 'other:204', 'slow:204']);
  });

  it('retries the identity of a user James does not know yet', async () => {
    const saved = dm.config.james_signature_template;
    dm.config.james_signature_template = '';
    try {
      const scope = nock(url)
        // Unknown user: the read says 404, like a user without identity
        .get('/users/lag@test.org/identities')
        .query({ default: 'true' })
        .reply(404)
        .post('/users/lag@test.org/identities')
        .reply(404, { message: 'User not found' })
        .get('/users/lag@test.org/identities')
        .query({ default: 'true' })
        .reply(200, [])
        .post('/users/lag@test.org/identities')
        .reply(201, { id: 'new-id' });

      await james.updateJamesIdentity(dn, 'lag@test.org', 'Lag User');

      expect(scope.isDone()).to.be.true;
      expect(at('warn')).to.have.length(1);
      expect(at('warn')[0].entry).to.include({
        step: 'create_identity',
        attempt: 1,
      });
      expect(at('error')).to.have.length(0);
    } finally {
      dm.config.james_signature_template = saved;
    }
  });
});
