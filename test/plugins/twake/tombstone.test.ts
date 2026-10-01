import { EventEmitter } from 'node:events';

import { expect } from 'chai';
import type { Request } from 'express';
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
import TwakeInstances from '../../../src/plugins/twake/instances';
import TwakeTombstone from '../../../src/plugins/twake/tombstone';
import { waitFor } from '../../helpers/waitFor';

const LDAP_BASE = process.env.DM_LDAP_BASE as string;
const USERS = `ou=users,${LDAP_BASE}`;
const ORG = `ou=ts-org,${USERS}`;
const GROUPS = process.env.DM_LDAP_GROUP_BASE as string;

class StubRabbitMq {
  name = 'rabbitmq';
  published: { routingKey: string; message: Record<string, string> }[] = [];
  async getRawClient(): Promise<object> {
    return {};
  }
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
  let raw: DM;
  let handled: { dn: string; done: Promise<unknown> }[] = [];
  /** What ldapaddafter subscribers are handed, as core/twake/instances is */
  let added: { dn: string; entry: AttributesList }[] = [];

  const flat = (name: string): string => `uid=${name},${USERS}`;
  const nested = (name: string): string => `uid=${name},${ORG}`;

  const count = (dn: string): number =>
    handled.filter(h => h.dn.toLowerCase() === dn.toLowerCase()).length;

  /**
   * Wait until the events plugin has handled `n` changes of `dn` since the
   * test began, and finished publishing for them.
   */
  async function seen(dn: string, n = 1): Promise<void> {
    await waitFor(() => count(dn) >= n, { what: `${n} change(s) of ${dn}` });
    await Promise.all(
      handled
        .filter(h => h.dn.toLowerCase() === dn.toLowerCase())
        .map(h => h.done)
    );
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
      rabbitmq_url: 'amqp://stub',
      scim_user_base: USERS,
      scim_user_lock_attribute: 'carLicense',
      scim_user_lock_value: 'L',
      group_schema: '',
    });
    await dm.ready;
    raw = new DM();
    await raw.ready;
    await dm.ldap
      .add(ORG, { objectClass: ['top', 'organizationalUnit'], ou: 'ts-org' })
      .catch(() => undefined);
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const events = new TwakeLifecycleEvents(dm);
    // Count the events plugin's work, so a test waits for it rather than for
    // a guessed delay.
    for (const name of ['onLdapEntryChange', 'twakedeletionreplay']) {
      const hook = events.hooks[name] as (
        dn: string,
        ...a: unknown[]
      ) => unknown;
      events.hooks[name] = (dn: string, ...args: unknown[]) => {
        const done = Promise.resolve(hook(dn, ...args));
        handled.push({ dn, done });
        return done;
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
    (dm.hooks.ldapaddafter ||= []).push(
      ([dn, entry]: [string, AttributesList]) => {
        added.push({ dn, entry });
      }
    );
  });

  beforeEach(() => {
    rabbit.published = [];
    handled = [];
    added = [];
  });

  // Cleanup through a server that loads no plugin: it deletes for real and
  // nothing hears it.
  const cleanup = async (...dns: string[]): Promise<void> => {
    for (const dn of dns) await raw.ldap.delete(dn).catch(() => undefined);
  };

  afterEach(async () => {
    await cleanup(
      `cn=ts-group,${GROUPS}`,
      flat('ts-alice'),
      flat('ts-dave'),
      flat('plain-bob'),
      nested('carol')
    );
  });

  after(async () => {
    await cleanup(ORG);
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
      const dn = flat('ts-alice');
      await add(dn);
      await seen(dn);
      rabbit.published = [];
      await dm.ldap.delete(dn);
      await seen(dn, 2);
      const first = (await read(dn))?.roomNumber;
      await dm.ldap.delete(dn);
      await seen(dn, 3);
      expect(rabbit.published.map(p => p.routingKey)).to.deep.equal([
        'deleted',
        'deleted',
      ]);
      expect(rabbit.published[1].message).to.deep.equal({
        id: 'ts-alice',
        reason: 'deleted',
        deletedAt: new Date(first as string).toISOString(),
      });
      expect((await read(dn))?.roomNumber).to.equal(first);
    });

    it('keeps the tombstone in its groups', async () => {
      await add(flat('ts-alice'));
      await add(flat('plain-bob'));
      await groups.addGroup('ts-group', [flat('ts-alice'), flat('plain-bob')]);
      await dm.ldap.delete(flat('ts-alice'));
      await seen(flat('ts-alice'), 2);
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
      await seen(flat('ts-alice'), 2);
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
      await seen(flat('ts-alice'), 4);
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
      await seen(flat('ts-alice'), 3);
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
      await seen(flat('ts-alice'), 2);
      rabbit.published = [];
    });

    it('writes a tombstone on delete', async () => {
      await add(flat('ts-dave'));
      await supertest(dm.app).delete('/scim/v2/Users/ts-dave').expect(204);
      expect(await read(flat('ts-dave'))).to.include({
        employeeType: 'deleted',
        businessCategory: 'deleted',
      });
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
      await supertest(dm.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'ts-alice',
          name: { familyName: 'Alice' },
        })
        .expect(201);
      // add, tombstone, erase, new entry
      await seen(flat('ts-alice'), 4);
      const entry = await read(flat('ts-alice'));
      expect(entry).not.to.have.property('employeeType');
      expect(entry).not.to.have.property('roomNumber');
      expect(rabbit.published.map(p => p.routingKey)).to.deep.equal([
        'created',
      ]);
    });

    it('puts the tombstone and its memberships back when the directory refuses the create', async () => {
      await add(flat('plain-bob'));
      await groups.addGroup('ts-group', [flat('ts-alice'), flat('plain-bob')]);
      await seen(flat('plain-bob'));
      rabbit.published = [];
      const before = (await read(flat('ts-alice')))?.roomNumber;
      const res = await supertest(dm.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'ts-alice',
          name: { familyName: 'Alice' },
          // Not IA5: the directory refuses the mail
          emails: [{ value: 'aliçe@example.org', primary: true }],
        });
      expect(res.status).to.be.at.least(400);
      await waitFor(
        async () => (await read(flat('ts-alice')))?.employeeType === 'deleted',
        { what: 'the tombstone to be put back' }
      );
      expect((await read(flat('ts-alice')))?.roomNumber).to.equal(before);
      await waitFor(async () => (await members()).includes(flat('ts-alice')), {
        what: 'the memberships to be put back',
      });
      expect(rabbit.published).to.deep.equal([]);
      // core/twake/instances gives no instance to the tombstone put back
      const restored = added.filter(a => a.dn === flat('ts-alice')).pop();
      const instances = new TwakeInstances(
        Object.assign(Object.create(dm) as DM, {
          config: {
            ...dm.config,
            twake_instance_dn: [`^uid=ts-[^,]+,${USERS}$`],
            twake_instance_provider: 'cloudery',
            twake_instance_cloudery_url: 'http://cloudery.invalid',
            twake_instance_cloudery_domain: 'example.org',
          },
        })
      ) as unknown as {
        account: (dn: string, entry: AttributesList) => unknown;
      };
      expect(restored?.entry).to.include({ employeeType: 'deleted' });
      expect(instances.account(flat('ts-alice'), restored!.entry)).to.equal(
        undefined
      );
      const { employeeType: _, ...alive } = restored!.entry;
      expect(instances.account(flat('ts-alice'), alive)).not.to.equal(
        undefined
      );
    });

    it('takes the placeholder out of a group the tombstone is put back in', async () => {
      const solo = `cn=ts-solo,${GROUPS}`;
      await dm.ldap.add(solo, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'ts-solo',
        member: flat('ts-alice'),
      });
      try {
        const res = await supertest(dm.app)
          .post('/scim/v2/Users')
          .set('Content-Type', 'application/scim+json')
          .send({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'ts-alice',
            name: { familyName: 'Alice' },
            emails: [{ value: 'aliçe@example.org', primary: true }],
          });
        expect(res.status).to.be.at.least(400);
        await waitFor(
          async () => (await read(solo))?.member === flat('ts-alice'),
          { what: 'the membership alone to be put back' }
        );
      } finally {
        await dm.ldap.delete(solo).catch(() => undefined);
      }
    });

    it('waits for the response to end, not for the client to leave', async () => {
      // Time for a restore to run, if anything started one
      const pause = (): Promise<void> =>
        new Promise(resolve => setTimeout(resolve, 200));
      const res = new EventEmitter() as EventEmitter & { end: () => void };
      let ended = 0;
      res.end = () => {
        ended++;
      };
      const req = {
        originalUrl: '/scim/v2/Users',
        headers: {},
        res,
      } as unknown as Request;
      await plugin.hooks.ldapaddrequest!([flat('ts-alice'), {}, req]);
      expect(await read(flat('ts-alice'))).to.equal(undefined);
      // The client goes away before the add is issued
      res.emit('close');
      await pause();
      await add(flat('ts-alice'));
      res.end();
      expect(ended).to.equal(1);
      await pause();
      const entry = await read(flat('ts-alice'));
      expect(entry).to.have.property('uid', 'ts-alice');
      expect(entry).not.to.have.property('employeeType');
    });
  });

  describe('lock', () => {
    const withLock = (
      settings: Record<string, string>,
      check: () => void
    ): void => {
      const saved = { ...dm.config };
      Object.assign(dm.config, settings);
      try {
        check();
      } finally {
        Object.assign(dm.config, saved);
      }
    };

    it('refuses a lock attribute other than the ppolicy one without its value', () => {
      withLock(
        {
          twake_lifecycle_lock_attribute: 'nsAccountLock',
          twake_lifecycle_lock_value: '',
          scim_user_lock_attribute: '',
          scim_user_lock_value: '',
        },
        () =>
          expect(() => new TwakeTombstone(dm)).to.throw(
            /--twake-lifecycle-lock-value must say what marks an account locked/
          )
      );
    });

    it("does not borrow SCIM's lock value for another attribute", () => {
      withLock(
        {
          twake_lifecycle_lock_attribute: 'nsAccountLock',
          twake_lifecycle_lock_value: '',
          scim_user_lock_attribute: 'carLicense',
          scim_user_lock_value: 'L',
        },
        () => expect(() => new TwakeTombstone(dm)).to.throw(/nsAccountLock/)
      );
    });
  });

  describe('with core/ldap/trash', () => {
    const composed = (watched: string): TwakeTombstone => {
      dm.config.trash_watched_bases = watched;
      return new TwakeTombstone(dm);
    };

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dm.loadedPlugins['trash'] = { name: 'trash' } as any;
    });

    afterEach(() => {
      delete dm.loadedPlugins['trash'];
      delete dm.config.trash_watched_bases;
    });

    it('refuses to start when the trash watches a tombstone branch', () => {
      expect(() => composed(USERS).assertComposition()).to.throw(
        /core\/ldap\/trash watches the branch/
      );
    });

    it('refuses to start when the trash watches everything', () => {
      expect(() => composed('').assertComposition()).to.throw(
        /core\/ldap\/trash watches the branch/
      );
    });

    it('starts when the trash watches other branches', () => {
      expect(() =>
        composed(
          'ou=elsewhere,dc=example,dc=com;ou=groups,dc=example,dc=com'
        ).assertComposition()
      ).not.to.throw();
    });

    it('refuses to start when one of the watched bases is a tombstone branch', () => {
      expect(() =>
        composed(`ou=elsewhere,dc=example,dc=com;${USERS}`).assertComposition()
      ).to.throw(/core\/ldap\/trash watches the branch/);
    });

    it('refuses to start when a watched base differs from a tombstone branch in case or spacing only', () => {
      expect(() =>
        composed(USERS.toUpperCase().replace(/,/g, ', ')).assertComposition()
      ).to.throw(/core\/ldap\/trash watches the branch/);
    });

    it('refuses to start when the trash watches a branch under a tombstone branch', () => {
      const patterns = dm.config.twake_tombstone_dn;
      dm.config.twake_tombstone_dn = [`${USERS}$`];
      try {
        expect(() => composed(`ou=sub,${USERS}`).assertComposition()).to.throw(
          /core\/ldap\/trash watches the branch/
        );
      } finally {
        dm.config.twake_tombstone_dn = patterns;
      }
    });
  });
});
