import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import CozyProvision from '../../../src/plugins/twake/cozyProvision';
import type { ScimUser } from '../../../src/plugins/scim/types';

interface PublishCall {
  exchange: string;
  routingKey: string;
  message: Record<string, unknown>;
}

class StubPublisher {
  calls: PublishCall[] = [];
  closed = false;
  async init(): Promise<void> {}
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>
  ): Promise<void> {
    this.calls.push({ exchange, routingKey, message });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class TestableCozyProvision extends CozyProvision {
  stub = new StubPublisher();
  protected async getPublisher(): Promise<StubPublisher> {
    return this.stub;
  }
}

const COZY_URL = 'http://cozyt:6060';

describe('CozyProvision plugin', () => {
  let dm: DM;
  let plugin: TestableCozyProvision;

  before(() => {
    nock.disableNetConnect();
  });

  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    dm.config.cozy_admin_url = COZY_URL;
    dm.config.cozy_admin_user = 'admin';
    dm.config.cozy_admin_passphrase = 'admin';
    dm.config.cozy_org_id = 'twp-test';
    dm.config.cozy_org_domain = 'twake.local';
    dm.config.cozy_default_locale = 'fr';
    // Non-empty url just so the lazy-init path is exercised; the stub
    // overrides actual broker access.
    dm.config.rabbitmq_url = 'amqp://guest:guest@rabbitmq:5672/';
    await dm.ready;
    plugin = new TestableCozyProvision(dm);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('scimusercreatedone', () => {
    it('POSTs /instances on cozy admin and publishes user.created', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query({
          Domain: 'alice.twake.local',
          Locale: 'fr',
          Email: 'alice@twake.local',
          PublicName: 'alice',
          OrgID: 'twp-test',
          OrgDomain: 'twake.local',
          ContextName: 'default',
        })
        .matchHeader('authorization', /^Basic /)
        .reply(201, { ok: true })
        .patch('/instances/alice.twake.local')
        .query({ OnboardingFinished: 'true' })
        .reply(200, { ok: true });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: 'alice',
        userName: 'alice',
        emails: [{ value: 'alice@twake.local', primary: true }],
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(scope.isDone(), 'cozy admin POST + PATCH').to.be.true;
      expect(plugin.stub.calls).to.have.length(1);
      const call = plugin.stub.calls[0];
      expect(call.exchange).to.equal('auth');
      expect(call.routingKey).to.equal('user.created');
      expect(call.message).to.deep.include({
        twakeId: 'alice',
        domain: 'twake.local',
        internalEmail: 'alice@twake.local',
        organizationDomain: 'twake.local',
        workplaceFqdn: 'alice.twake.local',
      });
    });

    it('uses SCIM displayName / name as PublicName when provided', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query(q => q.PublicName === 'Khaled Ferjani' && q.Phone === '+33600000000')
        .reply(201, { ok: true })
        .patch('/instances/khaled.twake.local')
        .query({ OnboardingFinished: 'true' })
        .reply(200, { ok: true });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'khaled',
        displayName: 'Khaled Ferjani',
        phoneNumbers: [{ value: '+33600000000', primary: true }],
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);
      expect(scope.isDone()).to.be.true;
    });

    it('forwards primary phoneNumber as mobile when provided', async () => {
      nock(COZY_URL)
        .post('/instances')
        .query(true)
        .reply(201, { ok: true })
        .patch('/instances/grace.twake.local')
        .query({ OnboardingFinished: 'true' })
        .reply(200, { ok: true });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'grace',
        phoneNumbers: [
          { value: '+33600000000', primary: true },
          { value: '+33700000000' },
        ],
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(plugin.stub.calls).to.have.length(1);
      expect(plugin.stub.calls[0].message).to.deep.include({
        twakeId: 'grace',
        mobile: '+33600000000',
      });
    });

    it('treats 409 as success and still publishes', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query(true)
        .reply(409, { error: 'already exists' });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'bob',
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(scope.isDone()).to.be.true;
      expect(plugin.stub.calls).to.have.length(1);
      expect(plugin.stub.calls[0].routingKey).to.equal('user.created');
    });

    it('does not fail the hook when the onboarding PATCH errors', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query(true)
        .reply(201, { ok: true })
        .patch('/instances/heidi.twake.local')
        .query({ OnboardingFinished: 'true' })
        .reply(500, { error: 'boom' });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'heidi',
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(scope.isDone()).to.be.true;
      // Publish still happens — PATCH failure must not abort the flow.
      expect(plugin.stub.calls).to.have.length(1);
      expect(plugin.stub.calls[0].routingKey).to.equal('user.created');
    });

    it('skips publish when cozy admin returns a hard error', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query(true)
        .reply(500, { error: 'boom' });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'carol',
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(scope.isDone()).to.be.true;
      expect(plugin.stub.calls).to.have.length(0);
    });

    it('uses user.locale when present', async () => {
      const scope = nock(COZY_URL)
        .post('/instances')
        .query(q => q.Locale === 'en')
        .reply(201, { ok: true })
        .patch('/instances/dave.twake.local')
        .query({ OnboardingFinished: 'true' })
        .reply(200, { ok: true });

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'dave',
        locale: 'en',
      };

      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      expect(scope.isDone()).to.be.true;
    });

    it('skips when user has no userName/id', async () => {
      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      };
      const hook = plugin.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);
      // No HTTP call expected, no publish either
      expect(plugin.stub.calls).to.have.length(0);
    });
  });

  describe('scimuserdeletedone', () => {
    it('publishes domain.user.deleted with composed workplaceFqdn', async () => {
      const hook = plugin.hooks?.scimuserdeletedone as (
        id: string
      ) => Promise<void>;
      await hook('eve');

      expect(plugin.stub.calls).to.have.length(1);
      const call = plugin.stub.calls[0];
      expect(call.exchange).to.equal('b2b');
      expect(call.routingKey).to.equal('domain.user.deleted');
      expect(call.message).to.deep.equal({
        workplaceFqdn: 'eve.twake.local',
        domain: 'twake.local',
      });
    });
  });

  describe('configuration safety', () => {
    it('does not call cozy admin when cozy_admin_url is empty', async () => {
      const dm2 = new DM();
      dm2.config.cozy_admin_url = '';
      dm2.config.cozy_org_domain = 'twake.local';
      dm2.config.rabbitmq_url = 'amqp://x';
      await dm2.ready;
      const p = new TestableCozyProvision(dm2);

      const user: ScimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'frank',
      };
      const hook = p.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await hook(user);

      // No nock expectation set, no HTTP call attempted; no publish either.
      expect(p.stub.calls).to.have.length(0);
    });
  });
});
