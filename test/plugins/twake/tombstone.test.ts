import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import LdapGroups from '../../../src/plugins/ldap/groups';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import Scim from '../../../src/plugins/scim/scim';
import TwakeLifecycleEvents from '../../../src/plugins/twake/lifecycleEvents';
import TwakeTombstone from '../../../src/plugins/twake/tombstone';

const LDAP_BASE = process.env.DM_LDAP_BASE as string;
const USERS = `ou=users,${LDAP_BASE}`;
const ORG = `ou=ts-org,${USERS}`;
const GROUPS = process.env.DM_LDAP_GROUP_BASE as string;

class StubRabbitMq {
  name = 'rabbitmq';
  published: { routingKey: string; message: Record<string, string> }[] = [];
  async publish(
    _exchange: string,
    routingKey: string,
    message: Record<string, string>
  ): Promise<void> {
    this.published.push({ routingKey, message });
  }
}

describe('Twake tombstone plugin', function () {
  let dm: DM;
  let plugin: TwakeTombstone;
  let groups: LdapGroups;
  let rabbit: StubRabbitMq;
  let pending: Promise<unknown>[] = [];

  const flat = (name: string): string => `uid=${name},${USERS}`;
  const nested = (name: string): string => `uid=${name},${ORG}`;

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++)
      await new Promise(resolve => setImmediate(resolve));
    await Promise.all(pending);
  }

  async function add(
    dn: string,
    extra: Record<string, string> = {}
  ): Promise<void> {
    const uid = dn.split(',')[0].slice(4);
    await dm.ldap.add(dn, {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: uid,
      sn: uid,
      uid,
      mail: `${uid}@example.org`,
      mobile: '+33600000000',
      ...extra,
    });
  }

  async function read(dn: string): Promise<AttributesList | undefined> {
    try {
      const res = (await dm.ldap.search(
        { scope: 'base', paged: false, attributes: ['*', 'carLicense'] },
        dn
      )) as SearchResult;
      return res.searchEntries[0] as AttributesList;
    } catch {
      return undefined;
    }
  }

  async function members(): Promise<string[]> {
    const group = (await groups.searchGroupsByName('ts-group'))['ts-group'];
    return ([] as string[]).concat((group?.member as string[]) || []);
  }

  before(async () => {
    dm = new DM();
    Object.assign(dm.config, {
      twake_lifecycle_lock_attribute: 'carLicense',
      twake_lifecycle_lock_value: 'L',
      twake_lifecycle_deleted_attribute: 'employeeType',
      twake_lifecycle_deleted_value: 'deleted',
      twake_lifecycle_deleted_at_attribute: 'roomNumber',
      twake_lifecycle_reason_attribute: 'businessCategory',
      twake_lifecycle_rules: JSON.stringify([
        {
          dn: `^uid=(?<id>[^,]+),(?:ou=(?<org>ts-org),)?${USERS}$`,
          exchange: 'accounts',
          payload: {
            id: '$dn.id',
            org: '$dn.org',
            reason: '$businessCategory',
            deletedAt: '$roomNumber',
          },
          events: { created: 'created', deleted: 'deleted' },
        },
      ]),
      twake_tombstone_dn: [`^uid=ts-[^,]+,${USERS}$`, `^uid=[^,]+,${ORG}$`],
      twake_tombstone_reasons: ['deleted', 'user_request', 'violation'],
      twake_tombstone_clear_attributes: ['mobile', 'telephoneNumber'],
      twake_tombstone_erase_min_age: 3600,
      scim_user_base: USERS,
      scim_user_lock_attribute: 'carLicense',
      scim_user_lock_value: 'L',
      group_schema: '',
    });
    await dm.ready;
    await dm.ldap
      .add(ORG, { objectClass: ['top', 'organizationalUnit'], ou: 'ts-org' })
      .catch(() => undefined);
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const events = new TwakeLifecycleEvents(dm);
    for (const name of ['ldapadddone', 'onLdapChange'] as const) {
      const hook = events.hooks[name] as (...a: unknown[]) => unknown;
      events.hooks[name] = async (...args: unknown[]): Promise<void> => {
        const p = Promise.resolve(hook(...args));
        pending.push(p);
        await p;
      };
    }
    await dm.registerPlugin('core/twake/lifecycleEvents', events);
    plugin = new TwakeTombstone(dm);
    await dm.registerPlugin('core/twake/tombstone', plugin);
    // Registered after the tombstone on purpose: afterLoad has to put the
    // tombstone back at the end of the delete chain.
    groups = new LdapGroups(dm);
    await dm.registerPlugin('core/ldap/groups', groups);
    await dm.registerPlugin('core/scim', new Scim(dm));
    plugin.afterLoad();
  });

  beforeEach(() => {
    rabbit.published = [];
    pending = [];
  });

  afterEach(async () => {
    await settle();
    await groups.deleteGroup('ts-group').catch(() => undefined);
    for (const dn of [flat('ts-alice'), flat('plain-bob'), nested('carol')]) {
      if (!(await read(dn))) continue;
      // A live entry becomes a tombstone first, then goes.
      await dm.ldap.delete(dn);
      await plugin.erase(dn, { force: true }).catch(() => undefined);
    }
    await settle();
  });

  after(async () => {
    await dm.ldap.delete(ORG).catch(() => undefined);
  });

  describe('delete', () => {
    for (const [layout, dnOf] of [
      ['flat', () => flat('ts-alice')],
      ['nested', () => nested('carol')],
    ] as const) {
      it(`writes a tombstone for a ${layout} entry`, async () => {
        const dn = dnOf();
        await add(dn);
        await dm.ldap.delete(dn);
        const entry = await read(dn);
        expect(entry).to.include({
          employeeType: 'deleted',
          businessCategory: 'deleted',
          carLicense: 'L',
        });
        expect(entry).not.to.have.property('mobile');
        const at = Date.parse(entry?.roomNumber as string);
        expect(Date.now() - at).to.be.below(60000);
      });
    }

    it('deletes an entry no pattern matches', async () => {
      await add(flat('plain-bob'));
      await dm.ldap.delete(flat('plain-bob'));
      expect(await read(flat('plain-bob'))).to.equal(undefined);
    });

    it('records the reason given in the header', async () => {
      await add(flat('ts-alice'));
      await dm.ldap.delete(flat('ts-alice'), {
        headers: { 'x-deletion-reason': 'violation' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      expect(await read(flat('ts-alice'))).to.have.property(
        'businessCategory',
        'violation'
      );
    });

    it('refuses a reason it does not know', async () => {
      await add(flat('ts-alice'));
      let error: unknown;
      await dm.ldap
        .delete(flat('ts-alice'), {
          headers: { 'x-deletion-reason': 'boredom' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .catch(e => (error = e));
      expect(error).to.have.property('statusCode', 400);
      expect(await read(flat('ts-alice'))).not.to.have.property('employeeType');
    });

    it('records the reason given to tombstone()', async () => {
      await add(flat('ts-alice'));
      await plugin.tombstone(flat('ts-alice'), 'user_request');
      expect(await read(flat('ts-alice'))).to.have.property(
        'businessCategory',
        'user_request'
      );
    });

    it('publishes deleted once, and again on a second delete with the same date', async () => {
      await add(flat('ts-alice'));
      await settle();
      rabbit.published = [];
      await dm.ldap.delete(flat('ts-alice'));
      await settle();
      const first = (await read(flat('ts-alice')))?.roomNumber;
      await dm.ldap.delete(flat('ts-alice'));
      await settle();
      expect(rabbit.published.map(p => p.routingKey)).to.deep.equal([
        'deleted',
        'deleted',
      ]);
      expect(rabbit.published[1].message).to.deep.equal({
        id: 'ts-alice',
        reason: 'deleted',
        deletedAt: new Date(first as string).toISOString(),
      });
      expect((await read(flat('ts-alice')))?.roomNumber).to.equal(first);
    });

    it('keeps the tombstone in its groups', async () => {
      await add(flat('ts-alice'));
      await add(flat('plain-bob'));
      await groups.addGroup('ts-group', [flat('ts-alice'), flat('plain-bob')]);
      await dm.ldap.delete(flat('ts-alice'));
      await settle();
      expect(await members()).to.include(flat('ts-alice'));
    });

    it('does not tombstone a delete another plugin refuses', async () => {
      await add(flat('ts-alice'));
      const refuse = async (): Promise<never> => {
        throw new Error('refused');
      };
      dm.hooks.ldapdeleterequest!.unshift(refuse);
      try {
        await dm.ldap.delete(flat('ts-alice')).catch(() => undefined);
      } finally {
        dm.hooks.ldapdeleterequest!.shift();
      }
      expect(await read(flat('ts-alice'))).not.to.have.property('employeeType');
    });
  });

  describe('erase', () => {
    beforeEach(async () => {
      await add(flat('ts-alice'));
      await add(flat('plain-bob'));
      await groups.addGroup('ts-group', [flat('ts-alice'), flat('plain-bob')]);
      await dm.ldap.delete(flat('ts-alice'));
      await settle();
      rabbit.published = [];
    });

    it('refuses a recent deletion unless forced', async () => {
      let error: unknown;
      await plugin.erase(flat('ts-alice')).catch(e => (error = e));
      expect(error).to.have.property('statusCode', 409);
      expect(await read(flat('ts-alice'))).to.not.equal(undefined);
    });

    it('erases an old enough deletion, with its memberships, publishing nothing', async () => {
      await dm.ldap.modify(flat('ts-alice'), {
        replace: { roomNumber: '2020-01-01T00:00:00.000Z' },
      });
      await plugin.erase(flat('ts-alice'));
      await settle();
      expect(await read(flat('ts-alice'))).to.equal(undefined);
      expect(await members()).to.deep.equal([flat('plain-bob')]);
      expect(rabbit.published).to.deep.equal([]);
    });

    it('erases the last member of a group, leaving the placeholder', async () => {
      const solo = `cn=ts-solo,${GROUPS}`;
      await dm.ldap.add(solo, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'ts-solo',
        member: flat('ts-alice'),
      });
      try {
        await plugin.erase(flat('ts-alice'), { force: true });
        expect(await read(flat('ts-alice'))).to.equal(undefined);
        expect((await read(solo))?.member).to.equal(dm.config.group_dummy_user);
      } finally {
        await dm.ldap.delete(solo).catch(() => undefined);
      }
    });

    it('erases through the API when forced', async () => {
      await supertest(dm.app)
        .post('/api/v1/twake/tombstones/erase')
        .send({ dn: flat('ts-alice') })
        .expect(409);
      await supertest(dm.app)
        .post('/api/v1/twake/tombstones/erase')
        .send({ dn: flat('ts-alice'), force: true })
        .expect(200);
      await settle();
      expect(await read(flat('ts-alice'))).to.equal(undefined);
      expect(rabbit.published).to.deep.equal([]);
    });

    it('answers 404 for an entry that is not a tombstone', async () => {
      await supertest(dm.app)
        .post('/api/v1/twake/tombstones/erase')
        .send({ dn: flat('plain-bob'), force: true })
        .expect(404);
    });
  });

  describe('SCIM', () => {
    beforeEach(async () => {
      await add(flat('ts-alice'));
      await dm.ldap.delete(flat('ts-alice'));
    });

    it('writes a tombstone on delete', async () => {
      await add(flat('ts-dave'));
      try {
        await supertest(dm.app).delete('/scim/v2/Users/ts-dave').expect(204);
        expect(await read(flat('ts-dave'))).to.include({
          employeeType: 'deleted',
          businessCategory: 'deleted',
        });
      } finally {
        await plugin.erase(flat('ts-dave'), { force: true });
      }
    });

    it('answers 404 for a tombstone', async () => {
      await supertest(dm.app).get('/scim/v2/Users/ts-alice').expect(404);
    });

    it('leaves a tombstone out of lists', async () => {
      const res = await supertest(dm.app)
        .get('/scim/v2/Users')
        .query({ filter: 'userName sw "ts-"' })
        .expect(200);
      expect(res.body.totalResults).to.equal(0);
    });

    it('replaces a tombstone with a new entry on create', async () => {
      await settle();
      rabbit.published = [];
      await supertest(dm.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'ts-alice',
          name: { familyName: 'Alice' },
        })
        .expect(201);
      await settle();
      const entry = await read(flat('ts-alice'));
      expect(entry).not.to.have.property('employeeType');
      expect(entry).not.to.have.property('roomNumber');
      expect(rabbit.published.map(p => p.routingKey)).to.deep.equal([
        'created',
      ]);
    });
  });
});
