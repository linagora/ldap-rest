import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import ClouderyProvision from '../../../src/plugins/twake/clouderyProvision';
import type { ScimUser } from '../../../src/plugins/scim/types';

const CLOUDERY = 'http://cloudery.test';
const B2B_BRANCH = 'ou=b2b,dc=twake,dc=local';
const USER_BASE = 'ou=users,ou=b2b,dc=twake,dc=local';

interface PublishCall {
  exchange: string;
  routingKey: string;
  message: Record<string, unknown>;
}

class StubRabbitMq {
  name = 'rabbitmq';
  calls: PublishCall[] = [];
  isAvailable(): boolean {
    return true;
  }
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>
  ): Promise<void> {
    this.calls.push({ exchange, routingKey, message });
  }
}

interface ModifyCall {
  dn: string;
  changes: Record<string, unknown>;
}

/** Minimal stand-in for this.server.ldap used by the plugin. */
class StubLdap {
  modifyCalls: ModifyCall[] = [];
  // entry returned by a base-scope search keyed by dn
  entries: Record<string, Record<string, unknown>> = {};
  async modify(dn: string, changes: Record<string, unknown>): Promise<boolean> {
    this.modifyCalls.push({ dn, changes });
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(_opts: any, base: string): Promise<any> {
    const entry = this.entries[base];
    return { searchEntries: entry ? [entry] : [] };
  }
}

// Express-like request stub: carries the org id / base headers and the token.
function makeReq(orgId?: string, orgBase?: string): unknown {
  const headers: Record<string, string> = {};
  if (orgId) headers['x-cloudery-org-id'] = orgId;
  if (orgBase) headers['x-cloudery-org-base'] = orgBase;
  return {
    user: 'b2b-token',
    headers,
    query: {},
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  };
}

function configure(dm: DM): void {
  dm.config.cloudery_manager_url = CLOUDERY;
  dm.config.cloudery_manager_token = 'tok';
  dm.config.cloudery_offer = 'b2b_twake_default';
  dm.config.cloudery_domain = 'twake.app';
  dm.config.cloudery_user_branch = B2B_BRANCH;
  dm.config.cloudery_fqdn_attribute = 'twakeWorkspaceUrl';
  dm.config.cloudery_default_locale = 'en';
  dm.config.cloudery_workflow_poll_interval_ms = 1;
  dm.config.cloudery_workflow_max_attempts = 5;
  dm.config.scim_user_base = USER_BASE;
  dm.config.scim_user_base_header = 'x-cloudery-org-base';
  dm.config.scim_base_header_root = B2B_BRANCH;
  dm.config.scim_user_rdn_attribute = 'uid';
  dm.config.rabbitmq_url = 'amqp://x';
}

describe('ClouderyProvision plugin', () => {
  let dm: DM;
  let plugin: ClouderyProvision;
  let rabbit: StubRabbitMq;
  let ldap: StubLdap;

  before(() => nock.disableNetConnect());
  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    configure(dm);
    await dm.ready;
    rabbit = new StubRabbitMq();
    ldap = new StubLdap();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.ldap = ldap as any;
    plugin = new ClouderyProvision(dm);
  });

  afterEach(() => nock.cleanAll());

  // Drive a full create: awaited pre-hook then the (normally fire-and-forget)
  // done hook, both awaited here so assertions see the finished work.
  async function create(user: ScimUser, req: unknown): Promise<void> {
    const pre = plugin.hooks?.scimusercreate as (
      a: [ScimUser, unknown]
    ) => Promise<unknown>;
    await pre([user, req]);
    const done = plugin.hooks?.scimusercreatedone as (
      u: ScimUser
    ) => Promise<void>;
    await done(user);
  }

  async function remove(id: string, req: unknown): Promise<void> {
    const pre = plugin.hooks?.scimuserdelete as (
      a: [string, unknown]
    ) => Promise<unknown>;
    await pre([id, req]);
    const done = plugin.hooks?.scimuserdeletedone as (
      i: string
    ) => Promise<void>;
    await done(id);
  }

  const user: ScimUser = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'john.doe',
    emails: [{ value: 'john.doe@acme.com', primary: true }],
    phoneNumbers: [{ value: '+33600000000', primary: true }],
    displayName: 'John Doe',
  };

  describe('create', () => {
    it('provisions via Cloudery, writes the fqdn, and publishes user.created', async () => {
      let body: Record<string, unknown> = {};
      const scope = nock(CLOUDERY)
        .post('/api/v1/instances', b => {
          body = b as Record<string, unknown>;
          return true;
        })
        .matchHeader('authorization', 'Bearer tok')
        .reply(200, {
          id: 'inst-1',
          fqdn: 'johndoeacme123.twake.app',
          workflow: 'wf-1',
        })
        .get('/api/v1/workflows/wf-1')
        .reply(200, { status: 'succeeded' });

      await create(user, makeReq('acme123'));

      expect(scope.isDone(), 'cloudery POST + workflow poll').to.equal(true);

      // slug = oidc = normalizeNickname(userName) + orgId (dots stripped)
      expect(body.slug).to.equal('johndoeacme123');
      expect(body.oidc).to.equal('johndoeacme123');
      expect(body.org_id).to.equal('acme123');
      expect(body.org_domain).to.equal('acme.com');
      expect(body.offer).to.equal('b2b_twake_default');
      expect(body.domain).to.equal('twake.app');
      expect(body.email).to.equal('john.doe@acme.com');

      // fqdn written back to the dedicated attribute on the user entry
      expect(ldap.modifyCalls).to.have.length(1);
      expect(ldap.modifyCalls[0].dn).to.equal(`uid=john.doe,${USER_BASE}`);
      expect(ldap.modifyCalls[0].changes).to.deep.equal({
        replace: {
          twakeWorkspaceUrl: 'johndoeacme123.twake.app',
          twakeOrganizationId: 'acme123',
        },
      });

      // published on the same contract as cozyProvision (+ organizationId)
      expect(rabbit.calls).to.have.length(1);
      const call = rabbit.calls[0];
      expect(call.exchange).to.equal('auth');
      expect(call.routingKey).to.equal('user.created');
      expect(call.message).to.deep.equal({
        twakeId: 'john.doe',
        domain: 'acme.com',
        organizationDomain: 'acme.com',
        workplaceFqdn: 'johndoeacme123.twake.app',
        organizationId: 'acme123',
        internalEmail: 'john.doe@acme.com',
        mobile: '+33600000000',
      });
    });

    it('trims whitespace in the email and org id before use', async () => {
      let body: Record<string, unknown> = {};
      const scope = nock(CLOUDERY)
        .post('/api/v1/instances', b => {
          body = b as Record<string, unknown>;
          return true;
        })
        .reply(200, {
          id: 'inst-1',
          fqdn: 'johndoeacme123.twake.app',
          workflow: 'wf-1',
        })
        .get('/api/v1/workflows/wf-1')
        .reply(200, { status: 'succeeded' });

      const spacedUser: ScimUser = {
        ...user,
        emails: [{ value: '  john.doe@acme.com  ', primary: true }],
      };
      await create(spacedUser, makeReq('  acme123  '));

      expect(scope.isDone()).to.equal(true);
      expect(body.email).to.equal('john.doe@acme.com');
      expect(body.internal_email).to.equal('john.doe@acme.com');
      expect(body.org_domain).to.equal('acme.com');
      expect(body.org_id).to.equal('acme123');
      expect(body.slug).to.equal('johndoeacme123');
      expect(ldap.modifyCalls[0].changes).to.deep.equal({
        replace: {
          twakeWorkspaceUrl: 'johndoeacme123.twake.app',
          twakeOrganizationId: 'acme123',
        },
      });
    });

    it('inserts under the org branch supplied by the base header', async () => {
      const orgBase = `ou=users,ou=acme123,${B2B_BRANCH}`;
      nock(CLOUDERY)
        .post('/api/v1/instances')
        .reply(200, {
          id: 'inst-1',
          fqdn: 'johndoeacme123.twake.app',
          workflow: 'wf-1',
        })
        .get('/api/v1/workflows/wf-1')
        .reply(200, { status: 'succeeded' });

      await create(user, makeReq('acme123', orgBase));

      expect(ldap.modifyCalls).to.have.length(1);
      expect(ldap.modifyCalls[0].dn).to.equal(`uid=john.doe,${orgBase}`);
    });

    it('publishes with a configured routing key', async () => {
      dm.config.cozy_user_created_routing_key = 'custom.user.created';
      const p = new ClouderyProvision(dm);
      nock(CLOUDERY)
        .post('/api/v1/instances')
        .reply(200, {
          id: 'inst-1',
          fqdn: 'johndoeacme123.twake.app',
          workflow: 'wf-1',
        })
        .get('/api/v1/workflows/wf-1')
        .reply(200, { status: 'succeeded' });

      const pre = p.hooks?.scimusercreate as (
        a: [ScimUser, unknown]
      ) => Promise<unknown>;
      await pre([user, makeReq('acme123')]);
      const done = p.hooks?.scimusercreatedone as (u: ScimUser) => Promise<void>;
      await done(user);

      expect(rabbit.calls).to.have.length(1);
      expect(rabbit.calls[0].exchange).to.equal('auth');
      expect(rabbit.calls[0].routingKey).to.equal('custom.user.created');
    });

    it('is inert for users outside the configured B2B branch', async () => {
      dm.config.scim_user_base = 'ou=users,dc=twake,dc=local'; // not under b2b
      const p = new ClouderyProvision(dm);
      const pre = p.hooks?.scimusercreate as (
        a: [ScimUser, unknown]
      ) => Promise<unknown>;
      await pre([user, makeReq('acme123')]);
      const done = p.hooks?.scimusercreatedone as (
        u: ScimUser
      ) => Promise<void>;
      await done(user);
      // No HTTP intercept registered → a call would throw; none happens.
      expect(rabbit.calls).to.have.length(0);
      expect(ldap.modifyCalls).to.have.length(0);
    });

    it('skips provisioning when the org id header is missing', async () => {
      await create(user, makeReq(undefined));
      expect(rabbit.calls).to.have.length(0);
      expect(ldap.modifyCalls).to.have.length(0);
    });

    it('does not write fqdn or publish when the workflow fails', async () => {
      const scope = nock(CLOUDERY)
        .post('/api/v1/instances')
        .reply(200, { id: 'inst-1', fqdn: 'x.twake.app', workflow: 'wf-2' })
        .get('/api/v1/workflows/wf-2')
        .reply(200, { status: 'failed' });

      await create(user, makeReq('acme123'));

      expect(scope.isDone()).to.equal(true);
      expect(ldap.modifyCalls).to.have.length(0);
      expect(rabbit.calls).to.have.length(0);
    });
  });

  describe('delete', () => {
    it('deletes the Cloudery instance and publishes domain.user.deleted', async () => {
      const dn = `uid=john.doe,${USER_BASE}`;
      ldap.entries[dn] = {
        twakeWorkspaceUrl: 'johndoeacme123.twake.app',
        mail: 'john.doe@acme.com',
      };

      const scope = nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(q => q.fqdn === 'johndoeacme123.twake.app')
        .reply(200, { items: [{ _id: 'uuid-1' }] })
        .delete('/api/v1/instances/uuid-1')
        .query(q => q.user_request === 'true')
        .reply(200, { workflow: 'wf-del' });

      await remove('john.doe', makeReq('acme123'));

      expect(scope.isDone(), 'search + delete').to.equal(true);
      expect(rabbit.calls).to.have.length(1);
      const call = rabbit.calls[0];
      expect(call.exchange).to.equal('b2b');
      expect(call.routingKey).to.equal('domain.user.deleted');
      expect(call.message).to.deep.equal({
        workplaceFqdn: 'johndoeacme123.twake.app',
        domain: 'acme.com',
      });
    });

    it('does not publish when the Cloudery instance is not found', async () => {
      const dn = `uid=john.doe,${USER_BASE}`;
      ldap.entries[dn] = {
        twakeWorkspaceUrl: 'johndoeacme123.twake.app',
        mail: 'john.doe@acme.com',
      };

      const scope = nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(q => q.fqdn === 'johndoeacme123.twake.app')
        .reply(200, { items: [] });

      await remove('john.doe', makeReq('acme123'));

      expect(scope.isDone(), 'lookup attempted').to.equal(true);
      // teardown did not happen → downstream must not be told it did
      expect(rabbit.calls).to.have.length(0);
    });

    it('strips a protocol from a stored workspace url before lookup', async () => {
      const dn = `uid=john.doe,${USER_BASE}`;
      ldap.entries[dn] = {
        twakeWorkspaceUrl: 'https://johndoeacme123.twake.app',
        mail: 'john.doe@acme.com',
      };

      const scope = nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(q => q.fqdn === 'johndoeacme123.twake.app')
        .reply(200, { items: [{ _id: 'uuid-1' }] })
        .delete('/api/v1/instances/uuid-1')
        .query(q => q.user_request === 'true')
        .reply(200, { workflow: 'wf-del' });

      await remove('john.doe', makeReq('acme123'));

      expect(scope.isDone(), 'bare fqdn used for lookup').to.equal(true);
      expect(rabbit.calls[0].message).to.deep.equal({
        workplaceFqdn: 'johndoeacme123.twake.app',
        domain: 'acme.com',
      });
    });

    it('skips when the entry has no stored fqdn (not ours)', async () => {
      await remove('jane.doe', makeReq('acme123'));
      expect(rabbit.calls).to.have.length(0);
    });
  });
});
