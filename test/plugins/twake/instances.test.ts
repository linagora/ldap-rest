import { expect } from 'chai';
import type { Request } from 'express';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import { ForbiddenError } from '../../../src/lib/errors';
import { outboundCalls } from '../../helpers/metrics';
import {
  ClouderyProvider,
  CozyStackProvider,
} from '../../../src/lib/instanceProviders';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import TwakeInstances, {
  type WorkplaceCreated,
} from '../../../src/plugins/twake/instances';

const USERS = `ou=users,${process.env.DM_LDAP_BASE}`;
const ORGS = `ou=in-orgs,${process.env.DM_LDAP_BASE}`;
const CLOUDERY = 'http://cloudery.test';
const COZY = 'http://cozy.test';

class StubRabbitMq {
  name = 'rabbitmq';
  up = true;
  published: { key: string; message: Record<string, unknown> }[] = [];
  handler?: (message: unknown) => Promise<void>;
  async getRawClient(): Promise<unknown> {
    return this.up ? {} : null;
  }
  async subscribe(
    _exchange: string,
    _key: string,
    _queue: string,
    handler: (message: unknown) => Promise<void>
  ): Promise<void> {
    this.handler = handler;
  }
  async publish(
    _exchange: string,
    key: string,
    message: Record<string, unknown>
  ): Promise<void> {
    this.published.push({ key, message });
  }
}

const dnOf = (uid: string): string => `uid=${uid},${USERS}`;
const orgDnOf = (org: string, uid: string): string =>
  `uid=${uid},ou=users,ou=${org},${ORGS}`;

const BASE_CONFIG = {
  twake_instance_dn: [
    `^uid=in-[^,]+,${USERS}$`,
    `^uid=[^,]+,ou=users,ou=(?<org>[^,]+),${ORGS}$`,
  ],
  twake_instance_fqdn_attribute: 'description',
  twake_instance_sent_attribute: 'businessCategory',
  twake_instance_skip_attribute: 'employeeType',
  twake_instance_skip_value: 'technical',
  twake_lifecycle_deleted_attribute: 'carLicense',
};

async function server(
  config: Record<string, unknown>
): Promise<{ dm: DM; rabbit: StubRabbitMq }> {
  const dm = new DM();
  Object.assign(dm.config, BASE_CONFIG, config);
  await dm.ready;
  const rabbit = new StubRabbitMq();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dm.loadedPlugins['rabbitmq'] = rabbit as any;
  await dm.registerPlugin('core/twake/instances', new TwakeInstances(dm));
  return { dm, rabbit };
}

const person = (uid: string, extra: Record<string, string> = {}) => ({
  objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
  cn: uid,
  sn: uid,
  uid,
  mail: `${uid}@example.org`,
  ...extra,
});

async function read(dm: DM, dn: string): Promise<AttributesList | undefined> {
  try {
    const res = (await dm.ldap.search(
      { scope: 'base', paged: false },
      dn
    )) as SearchResult;
    return res.searchEntries[0] as AttributesList;
  } catch {
    return undefined;
  }
}

const plugin = (dm: DM): TwakeInstances =>
  dm.loadedPlugins['twakeInstances'] as TwakeInstances;

const rest = (): Request => ({ user: 'admin' }) as unknown as Request;

const search = (fqdn: string) =>
  nock(CLOUDERY).get('/api/v2/instances').query({ fqdn, limit: '1' });

const link = (id: string, fqdn: string) =>
  nock(CLOUDERY)
    .patch(`/api/v2/organizations/${id}`, { instance_fqdn: fqdn })
    .reply(200, {});

async function refusal(work: Promise<unknown>): Promise<unknown> {
  let error: unknown;
  await work.catch(e => (error = e));
  return error;
}

describe('Twake instances plugin', function () {
  before(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });
  after(() => nock.enableNetConnect());
  afterEach(() => nock.cleanAll());

  describe('with the Cloudery', () => {
    let dm: DM;
    let rabbit: StubRabbitMq;

    const CLOUDERY_CONFIG = {
      twake_instance_provider: 'cloudery',
      twake_instance_cloudery_url: CLOUDERY,
      twake_instance_cloudery_token: 'tok',
      twake_instance_cloudery_domain: 'example.org',
      twake_instance_cloudery_offer: 'standard',
      twake_instance_cloudery_organization_offer: 'organization',
      twake_instance_id: '{uid}{org}',
      twake_instance_organization_base: ORGS,
      twake_instance_organization_domain_attribute: 'l',
      twake_instance_organization_name_attribute: 'st',
      twake_instance_organization_fqdn_attribute: 'description',
    };

    before(async () => {
      ({ dm, rabbit } = await server(CLOUDERY_CONFIG));
      await dm.ldap
        .add(ORGS, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'in-orgs',
        })
        .catch(() => undefined);
    });

    after(async () => {
      for (const dn of [
        orgDnOf('acme1', 'in.dave'),
        `ou=users,ou=acme1,${ORGS}`,
        `ou=acme1,${ORGS}`,
        `ou=in-alice,${ORGS}`,
        ORGS,
      ])
        await dm.ldap.delete(dn).catch(() => undefined);
    });

    beforeEach(() => {
      rabbit.published = [];
      rabbit.up = true;
    });

    afterEach(async () => {
      for (const uid of ['in-alice', 'in-bot', 'out-carol'])
        await dm.ldap.delete(dnOf(uid)).catch(() => undefined);
    });

    it('reduces the slug to what the Cloudery takes', async () => {
      let asked: Record<string, unknown> = {};
      const scope = search('in-janedoestg.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances', body => {
          asked = body as Record<string, unknown>;
          return true;
        })
        .reply(202, {});
      try {
        await dm.ldap.add(
          dnOf('in-Jane.Doe_stg'),
          person('in-Jane.Doe_stg'),
          rest()
        );
        expect(scope.isDone()).to.equal(true);
        expect(asked).to.include({
          oidc: 'in-janedoestg',
          slug: 'in-janedoestg',
        });
      } finally {
        await dm.ldap.delete(dnOf('in-Jane.Doe_stg')).catch(() => undefined);
      }
    });

    it('refuses an instance another uid reducing to the same slug holds', async () => {
      // Asked by the creation, then by the ensure
      search('in-janedoe.example.org')
        .times(2)
        .reply(200, {
          items: [
            {
              _id: 'taken',
              fqdn: 'in-janedoe.example.org',
              internal_email: 'in-janedoe@example.org',
              oidc: 'in-janedoe',
              instantiated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
      const create = nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
      try {
        await dm.ldap.add(dnOf('in-jane_doe'), person('in-jane_doe'));
        expect(
          String(await refusal(plugin(dm).ensureInstance(dnOf('in-jane_doe'))))
        ).to.match(/belongs to another user/);
        expect(create.isDone()).to.equal(false);
      } finally {
        nock.cleanAll();
        await dm.ldap.delete(dnOf('in-jane_doe')).catch(() => undefined);
      }
    });

    it('looks the instance up, asks for it, and waits for its address', async () => {
      let asked: Record<string, unknown> = {};
      const scope = search('in-alice.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances', body => {
          asked = body as Record<string, unknown>;
          return true;
        })
        .reply(202, {});
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(asked).to.include({
        oidc: 'in-alice',
        slug: 'in-alice',
        internal_email: 'in-alice@example.org',
        offer: 'standard',
        domain: 'example.org',
      });
      expect(await read(dm, dnOf('in-alice'))).not.to.have.property(
        'description'
      );
      expect(rabbit.published).to.deep.equal([]);
    });

    it('does not ask again for an instance a re-created account already has', async () => {
      const scope = search('in-alice.example.org').reply(200, {
        items: [
          {
            fqdn: 'in-alice.example.org',
            internal_email: 'in-alice@example.org',
            oidc: 'in-alice',
            instantiated_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(await read(dm, dnOf('in-alice'))).to.have.property(
        'description',
        'in-alice.example.org'
      );
      expect(rabbit.published.map(p => p.key)).to.deep.equal(['user.created']);
    });

    it('announces an account whose mail has no domain without a Matrix ID', async () => {
      search('in-alice.example.org').reply(200, {
        items: [
          {
            fqdn: 'in-alice.example.org',
            internal_email: 'in-alice',
            oidc: 'in-alice',
            instantiated_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
      await dm.ldap.add(
        dnOf('in-alice'),
        person('in-alice', { mail: 'in-alice' }),
        rest()
      );
      expect(rabbit.published).to.have.length(1);
      expect(rabbit.published[0].message).to.include({ twakeId: 'in-alice' });
      expect(rabbit.published[0].message).not.to.have.property('matrixId');
    });

    it('answers the add when the Cloudery refuses, the entry left pending', async () => {
      const refusals = await outboundCalls('cloudery', '500');
      search('in-alice.example.org').reply(200, { items: [] });
      nock(CLOUDERY).post('/api/v1/instances').reply(500, 'down');
      expect(await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest())).to
        .be.true;
      expect(await outboundCalls('cloudery', '500')).to.equal(refusals + 1);
      const entry = await read(dm, dnOf('in-alice'));
      expect(entry).to.have.property('uid', 'in-alice');
      expect(entry).not.to.have.property('description');
    });

    it('ignores an address or a mark supplied with the add', async () => {
      const scope = search('in-alice.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances')
        .reply(202, {});
      await dm.ldap.add(
        dnOf('in-alice'),
        person('in-alice', {
          description: 'evil.example.net',
          businessCategory: '2026-01-01T00:00:00Z',
        }),
        rest()
      );
      expect(scope.isDone()).to.equal(true);
      const entry = await read(dm, dnOf('in-alice'));
      expect(entry).not.to.have.property('description');
      expect(entry).not.to.have.property('businessCategory');
    });

    it('takes an account under a respelled branch for one', async () => {
      // The directory stores this entry at its canonical DN, which the
      // expressions match; the DN as sent does not
      const respelled = `uid=in-q2 , OU=USERS , ${process.env.DM_LDAP_BASE}`;
      const scope = search('in-q2.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances')
        .reply(202, {});
      try {
        await dm.ldap.add(
          respelled,
          person('in-q2', {
            description: 'evil.example.net',
            businessCategory: '2026-01-01T00:00:00Z',
          }),
          rest()
        );
        expect(scope.isDone()).to.equal(true);
        const entry = await read(dm, dnOf('in-q2'));
        expect(entry).not.to.have.property('description');
        expect(entry).not.to.have.property('businessCategory');
      } finally {
        await dm.ldap.delete(dnOf('in-q2')).catch(() => undefined);
      }
    });

    it('asks nothing for a tombstone put back', async () => {
      await dm.ldap.add(
        dnOf('in-alice'),
        person('in-alice', { carLicense: 'TRUE' }),
        rest()
      );
      expect(nock.pendingMocks()).to.deep.equal([]);
      expect(await read(dm, dnOf('in-alice'))).not.to.have.property(
        'description'
      );
      expect(rabbit.published).to.deep.equal([]);
    });

    it('refuses to start when the directory lacks its attributes', async () => {
      const dm2 = new DM();
      Object.assign(dm2.config, dm.config, {
        twake_instance_sent_attribute: 'twakeNoSuchMark',
      });
      await dm2.ready;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dm2.loadedPlugins['rabbitmq'] = new StubRabbitMq() as any;
      expect(
        String(
          await refusal(
            dm2.registerPlugin('core/twake/instances', new TwakeInstances(dm2))
          )
        )
      ).to.match(/defines no twakeNoSuchMark/);
    });

    it('refuses to start when an organization’s name and address share an attribute', async () => {
      const dm2 = new DM();
      Object.assign(dm2.config, dm.config, {
        twake_instance_organization_name_attribute: 'description',
      });
      await dm2.ready;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dm2.loadedPlugins['rabbitmq'] = new StubRabbitMq() as any;
      expect(
        String(
          await refusal(
            dm2.registerPlugin('core/twake/instances', new TwakeInstances(dm2))
          )
        )
      ).to.match(/cannot share the attribute description/);
    });

    it('asks nothing for a technical account or an entry outside the rules', async () => {
      await dm.ldap.add(
        dnOf('in-bot'),
        person('in-bot', { employeeType: 'technical' }),
        rest()
      );
      await dm.ldap.add(dnOf('out-carol'), person('out-carol'), rest());
      expect(nock.pendingMocks()).to.deep.equal([]);
    });

    it('writes the address on workplace.created, announces the account once', async () => {
      search('in-alice.example.org').reply(200, { items: [] });
      nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
      await dm.ldap.add(
        dnOf('in-alice'),
        person('in-alice', { mobile: '+33600000000' }),
        rest()
      );
      const created: WorkplaceCreated = {
        twakeId: 'in-alice',
        internalEmail: 'in-alice@example.org',
        workplaceFqdn: 'in-alice.example.org',
      };
      await Promise.all([rabbit.handler!(created), rabbit.handler!(created)]);
      await rabbit.handler!(created);
      const entry = await read(dm, dnOf('in-alice'));
      expect(entry).to.have.property('description', 'in-alice.example.org');
      expect(Date.parse(entry?.businessCategory as string)).to.be.a('number');
      expect(rabbit.published).to.deep.equal([
        {
          key: 'user.created',
          message: {
            twakeId: 'in-alice',
            internalEmail: 'in-alice@example.org',
            workplaceFqdn: 'in-alice.example.org',
            matrixId: '@in-alice:example.org',
            mobile: '+33600000000',
          },
        },
      ]);
    });

    it('sends user.created again after a failed send, not marked in between', async () => {
      search('in-alice.example.org').reply(200, { items: [] });
      nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      const created: WorkplaceCreated = {
        twakeId: 'in-alice',
        internalEmail: 'in-alice@example.org',
        workplaceFqdn: 'in-alice.example.org',
      };
      rabbit.up = false;
      expect(String(await refusal(rabbit.handler!(created)))).to.match(
        /unreachable/
      );
      const entry = await read(dm, dnOf('in-alice'));
      expect(entry).to.have.property('description', 'in-alice.example.org');
      expect(entry).not.to.have.property('businessCategory');
      expect(rabbit.published).to.deep.equal([]);
      // The redelivered message finds the address written, not the mark
      rabbit.up = true;
      await rabbit.handler!(created);
      expect(rabbit.published.map(p => p.key)).to.deep.equal(['user.created']);
    });

    it('ignores workplace.created for an account it does not hold', async () => {
      await rabbit.handler!({
        twakeId: 'nobody',
        internalEmail: 'nobody@example.org',
        workplaceFqdn: 'nobody.example.org',
      });
      expect(rabbit.published).to.deep.equal([]);
    });

    it('gives an account whose uid is an organization id its own address', async () => {
      await dm.ldap.add(`ou=in-alice,${ORGS}`, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'in-alice',
        l: 'alice-org.example',
      });
      search('in-alice.example.org').reply(200, { items: [] });
      nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      await rabbit.handler!({
        twakeId: 'in-alice',
        internalEmail: 'in-alice@example.org',
        workplaceFqdn: 'in-alice.example.org',
      });
      expect(await read(dm, dnOf('in-alice'))).to.have.property(
        'description',
        'in-alice.example.org'
      );
      expect(await read(dm, `ou=in-alice,${ORGS}`)).not.to.have.property(
        'description'
      );
      expect(rabbit.published.map(p => p.key)).to.deep.equal(['user.created']);
    });

    it('names an organization member by its uid, its slug by uid and organization', async () => {
      await dm.ldap.add(`ou=acme1,${ORGS}`, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'acme1',
        l: 'acme.example',
      });
      await dm.ldap.modify(`ou=acme1,${ORGS}`, {
        replace: { businessCategory: '2026-01-01T00:00:00.000Z' },
      });
      await dm.ldap.add(`ou=users,ou=acme1,${ORGS}`, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'users',
      });
      let asked: Record<string, unknown> = {};
      search('indaveacme1.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances', body => {
          asked = body as Record<string, unknown>;
          return true;
        })
        .reply(202, {});
      await dm.ldap.add(
        orgDnOf('acme1', 'in.dave'),
        { ...person('in.dave'), mail: 'in.dave@acme.example' },
        rest()
      );
      expect(asked).to.include({
        slug: 'indaveacme1',
        oidc: 'indaveacme1',
        org_id: 'acme1',
        org_domain: 'acme.example',
        offer: 'standard',
      });
      await rabbit.handler!({
        twakeId: 'indaveacme1',
        internalEmail: 'in.dave@acme.example',
        workplaceFqdn: 'indaveacme1.example.org',
      });
      for (const dn of [
        orgDnOf('acme1', 'in.dave'),
        `ou=users,ou=acme1,${ORGS}`,
        `ou=acme1,${ORGS}`,
      ])
        await dm.ldap.delete(dn);
      expect(rabbit.published).to.deep.equal([
        {
          key: 'user.created',
          message: {
            twakeId: 'in.dave',
            internalEmail: 'in.dave@acme.example',
            workplaceFqdn: 'indaveacme1.example.org',
            matrixId: '@in.dave:acme.example',
            organizationId: 'acme1',
            domain: 'acme.example',
            organizationDomain: 'acme.example',
          },
        },
      ]);
    });

    it('reads an organization id from its entry, whatever case the branch is spelled', async () => {
      const org = `ou=InAcme,${ORGS}`;
      await dm.ldap.add(org, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'InAcme',
        l: 'acme.example',
      });
      await dm.ldap.add(`ou=users,${org}`, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'users',
      });
      let asked: Record<string, unknown> = {};
      search('inyinacme.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances', body => {
          asked = body as Record<string, unknown>;
          return true;
        })
        .reply(202, {});
      try {
        await dm.ldap.add(
          `uid=in.y , ou=users , ou=INACME,${ORGS}`,
          { ...person('in.y'), mail: 'in.y@acme.example' },
          rest()
        );
        expect(asked).to.include({ slug: 'inyinacme', org_id: 'InAcme' });
      } finally {
        for (const dn of [
          `uid=in.y,ou=users,ou=InAcme,${ORGS}`,
          `ou=users,${org}`,
          org,
        ])
          await dm.ldap.delete(dn).catch(() => undefined);
      }
    });

    describe('making sure an account has its instance', () => {
      beforeEach(async () => {
        search('in-alice.example.org').reply(200, { items: [] });
        nock(CLOUDERY).post('/api/v1/instances').reply(500, 'down');
        await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      });

      it('asks again for an instance the Cloudery does not have', async () => {
        search('in-alice.example.org').reply(200, { items: [] });
        const create = nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
        const res = await supertest(dm.app)
          .post('/api/v1/twake/instances/ensure')
          .send({ dn: dnOf('in-alice') })
          .expect(200);
        expect(res.body).to.deep.equal({ state: 'pending' });
        expect(create.isDone()).to.equal(true);
      });

      it('asks once when two callers make sure at the same time', async () => {
        search('in-alice.example.org').reply(200, { items: [] });
        const create = nock(CLOUDERY)
          .post('/api/v1/instances')
          .once()
          .reply(202, {});
        search('in-alice.example.org').reply(200, {
          items: [{ fqdn: 'in-alice.example.org', instantiated_at: null }],
        });
        const states = await Promise.all([
          plugin(dm).ensureInstance(dnOf('in-alice')),
          plugin(dm).ensureInstance(dnOf('in-alice')),
        ]);
        expect(states).to.deep.equal(['pending', 'pending']);
        expect(create.isDone()).to.equal(true);
        expect(nock.pendingMocks()).to.deep.equal([]);
      });

      it('asks once when two spellings of one DN make sure at the same time', async () => {
        // The second spelling may only read once the first creation has
        // landed: a queue per spelling lets it read before
        let created = false;
        let readsAfterCreate = 0;
        search('in-alice.example.org')
          .twice()
          .reply(200, () => {
            if (created) readsAfterCreate++;
            return {
              items: created
                ? [{ fqdn: 'in-alice.example.org', instantiated_at: null }]
                : [],
            };
          });
        nock(CLOUDERY)
          .post('/api/v1/instances')
          .twice()
          .delay(100)
          .reply(202, () => {
            created = true;
            return {};
          });
        const respelled = `uid=in-alice , ${USERS.toUpperCase().replace(/,/g, ' , ')}`;
        const states = await Promise.all([
          plugin(dm).ensureInstance(dnOf('in-alice')),
          plugin(dm).ensureInstance(respelled),
        ]);
        expect(states).to.deep.equal(['pending', 'pending']);
        expect(readsAfterCreate).to.equal(1);
      });

      it('asks no organization about an instance at another address than the account’s', async () => {
        search('in-alice.example.org').reply(200, {
          items: [
            {
              _id: 'taken',
              fqdn: 'in-alice.example.org',
              internal_email: 'someone@example.org',
              instantiated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
        let asked = false;
        nock(CLOUDERY)
          .get('/api/v2/organizations/in-alice')
          .optionally()
          .reply(200, () => {
            asked = true;
            return { instance_id: 'taken' };
          });
        expect(
          String(await refusal(plugin(dm).ensureInstance(dnOf('in-alice'))))
        ).to.match(/belongs to another user/);
        expect(asked).to.equal(false);
        nock.cleanAll();
      });

      it('finds the account by mail', async () => {
        search('in-alice.example.org').reply(200, { items: [] });
        nock(CLOUDERY).post('/api/v1/instances').reply(202, {});
        const res = await supertest(dm.app)
          .post('/api/v1/twake/instances/ensure')
          .send({ mail: 'in-alice@example.org' })
          .expect(200);
        expect(res.body).to.deep.equal({ state: 'pending' });
        await supertest(dm.app)
          .post('/api/v1/twake/instances/ensure')
          .send({ mail: 'nobody@example.org' })
          .expect(404);
      });

      it('answers 400 to a request naming no account, or a malformed one', async () => {
        const ensure = () =>
          supertest(dm.app).post('/api/v1/twake/instances/ensure');
        await ensure().expect(400);
        await ensure().send({}).expect(400);
        await ensure().send({ mail: '' }).expect(400);
        await ensure().send({ dn: 'not a dn' }).expect(400);
        const wrong = await ensure().send({ dn: 5 }).expect(400);
        expect(wrong.body.error).to.equal(
          'Invalid request: body.dn: Expected string'
        );
      });

      it('reads and writes the account with the caller’s rights', async () => {
        const denied = (req?: Request) => req?.headers?.['x-test'] === 'denied';
        const filter = ([result, req, opts]: [
          SearchResult,
          Request?,
          unknown?,
        ]) => [
          denied(req) ? { ...result, searchEntries: [] } : result,
          req,
          opts,
        ];
        const readOnly = (args: unknown[]) => {
          const req = args[args.length - 1] as Request | undefined;
          if (req?.headers?.['x-test'] === 'read-only')
            throw new ForbiddenError('read only');
          return args;
        };
        dm.hookBus.subscribe('ldapsearchfilter', filter as never);
        dm.hookBus.subscribe('ldapmodifyrequest', readOnly as never);
        try {
          const ensure = (who: string, body: object) =>
            supertest(dm.app)
              .post('/api/v1/twake/instances/ensure')
              .set('x-test', who)
              .send(body);
          await ensure('denied', { mail: 'in-alice@example.org' }).expect(404);
          await ensure('denied', { dn: dnOf('in-alice') }).expect(404);
          // No provider mock: reaching the Cloudery would fail otherwise
          await ensure('read-only', { dn: dnOf('in-alice') }).expect(403);
          expect(rabbit.published).to.deep.equal([]);
          expect(await read(dm, dnOf('in-alice'))).not.to.have.property(
            'description'
          );
        } finally {
          dm.hookBus.unsubscribe('ldapsearchfilter', filter as never);
          dm.hookBus.unsubscribe('ldapmodifyrequest', readOnly as never);
        }
      });

      it('announces again when the mark could not be written', async () => {
        const refuseMark = (args: unknown[]) => {
          const changes = args[1] as { replace?: Record<string, unknown> };
          if (changes.replace?.businessCategory)
            throw new Error('mark refused');
          return args;
        };
        dm.hookBus.subscribe('ldapmodifyrequest', refuseMark as never);
        const built = () =>
          search('in-alice.example.org').reply(200, {
            items: [
              {
                fqdn: 'in-alice.example.org',
                instantiated_at: '2026-01-01T00:00:00Z',
              },
            ],
          });
        try {
          built();
          expect(
            String(await refusal(plugin(dm).ensureInstance(dnOf('in-alice'))))
          ).to.match(/mark refused/);
          expect(await read(dm, dnOf('in-alice'))).to.have.property(
            'description',
            'in-alice.example.org'
          );
          expect(rabbit.published).to.have.lengthOf(1);
        } finally {
          dm.hookBus.unsubscribe('ldapmodifyrequest', refuseMark as never);
        }
        // At least once: the next call announces again, then marks
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'ready'
        );
        expect(rabbit.published).to.have.lengthOf(2);
        expect(await read(dm, dnOf('in-alice'))).to.have.property(
          'businessCategory'
        );
      });

      it('takes an address a modify wrote only once the provider confirms it', async () => {
        await dm.ldap.modify(dnOf('in-alice'), {
          replace: { description: 'evil.example.net' },
        });
        const asked = search('evil.example.net')
          .reply(200, { items: [] })
          .get('/api/v2/instances')
          .query({ fqdn: 'in-alice.example.org', limit: '1' })
          .reply(200, { items: [] })
          .post('/api/v1/instances')
          .reply(202, {});
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'pending'
        );
        expect(asked.isDone()).to.equal(true);
        expect(rabbit.published).to.deep.equal([]);

        // The address the provider gives this account needs no asking
        await dm.ldap.modify(dnOf('in-alice'), {
          replace: { description: 'in-alice.example.org' },
        });
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'ready'
        );
        expect(rabbit.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });

      it('waits for an instance still being built', async () => {
        search('in-alice.example.org').reply(200, {
          items: [{ fqdn: 'in-alice.example.org', instantiated_at: null }],
        });
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'pending'
        );
        expect(rabbit.published).to.deep.equal([]);
      });

      it('refuses an instance at its address that is someone else’s', async () => {
        search('in-alice.example.org').reply(200, {
          items: [
            {
              fqdn: 'in-alice.example.org',
              internal_email: 'mallory@example.org',
              instantiated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
        expect(
          await refusal(plugin(dm).ensureInstance(dnOf('in-alice')))
        ).to.have.property('statusCode', 409);
        expect(rabbit.published).to.deep.equal([]);
      });

      it('writes the address of a built instance and announces the account', async () => {
        search('in-alice.example.org').reply(200, {
          items: [
            {
              fqdn: 'in-alice.example.org',
              instantiated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'ready'
        );
        expect(await read(dm, dnOf('in-alice'))).to.have.property(
          'description',
          'in-alice.example.org'
        );
        expect(rabbit.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
        // Announced once: a second call finds the entry marked
        expect(await plugin(dm).ensureInstance(dnOf('in-alice'))).to.equal(
          'ready'
        );
        expect(rabbit.published).to.have.lengthOf(1);
      });
    });

    describe('with an address the entry’s classes do not allow', () => {
      const GINA = {
        twakeId: 'in-gina',
        internalEmail: 'in-gina@example.org',
        workplaceFqdn: 'in-gina.example.org',
      };

      const classesOf = async (dm: DM): Promise<string[]> =>
        [(await read(dm, dnOf('in-gina')))?.objectClass]
          .flat()
          .map(c => String(c).toLowerCase())
          .sort();

      // Written without this plugin, as another tool writes it
      const foreign = async (
        classes: string[],
        extra: Record<string, string> = {}
      ): Promise<void> => {
        const other = new DM();
        await other.ready;
        await other.ldap.add(dnOf('in-gina'), {
          objectClass: classes,
          cn: 'in-gina',
          sn: 'in-gina',
          uid: 'in-gina',
          mail: 'in-gina@example.org',
          ...extra,
        });
      };

      const withCozyDomain = (config: Record<string, unknown> = {}) =>
        server({
          ...CLOUDERY_CONFIG,
          twake_instance_fqdn_attribute: 'twakeCozyDomain',
          ...config,
        });

      afterEach(async () => {
        await dm.ldap.delete(dnOf('in-gina')).catch(() => undefined);
      });

      it('gives an entry another tool created the classes its address needs', async () => {
        const { dm: dm2, rabbit: rabbit2 } = await withCozyDomain();
        await foreign(['top', 'inetOrgPerson']);
        await rabbit2.handler!(GINA);
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain',
          'in-gina.example.org'
        );
        expect(await classesOf(dm2)).to.include('twakewhitepages');
        expect(rabbit2.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });

      it('gives them when making sure of its instance', async () => {
        const { dm: dm2, rabbit: rabbit2 } = await withCozyDomain();
        await foreign(['top', 'inetOrgPerson']);
        search('in-gina.example.org').reply(200, {
          items: [
            {
              fqdn: 'in-gina.example.org',
              instantiated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
        expect(await plugin(dm2).ensureInstance(dnOf('in-gina'))).to.equal(
          'ready'
        );
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain',
          'in-gina.example.org'
        );
        expect(await classesOf(dm2)).to.include('twakewhitepages');
        expect(rabbit2.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });

      it('adds no class to an entry whose classes already allow the address', async () => {
        const { dm: dm2, rabbit: rabbit2 } = await withCozyDomain();
        await foreign(['top', 'inetOrgPerson', 'twakeWhitePages']);
        const before = await classesOf(dm2);
        await rabbit2.handler!(GINA);
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain',
          'in-gina.example.org'
        );
        expect(await classesOf(dm2)).to.deep.equal(before);
      });

      it('adds only the classes the address needs', async function () {
        const { dm: dm2, rabbit: rabbit2 } = await withCozyDomain({
          user_class: [
            'top',
            'twakeAccount',
            'twakeWhitePages',
            'posixAccount',
          ],
        });
        const index = await dm2.ldap.schemaIndex();
        if (index.getObjectClass('posixAccount')?.kind !== 'AUXILIARY')
          return this.skip();
        await foreign(['top', 'inetOrgPerson']);
        await rabbit2.handler!(GINA);
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain',
          'in-gina.example.org'
        );
        const classes = await classesOf(dm2);
        expect(classes).to.include('twakewhitepages');
        // Its uidNumber, gidNumber and homeDirectory would refuse the write
        expect(classes).not.to.include('posixaccount');
        expect(rabbit2.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });

      it('gives the classes the sent mark needs, so the account is announced once', async () => {
        const { dm: dm2, rabbit: rabbit2 } = await server({
          ...CLOUDERY_CONFIG,
          twake_instance_sent_attribute: 'twakeCozyDomain',
        });
        await foreign(['top', 'inetOrgPerson'], {
          description: 'in-gina.example.org',
        });
        await rabbit2.handler!(GINA);
        await rabbit2.handler!(GINA);
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain'
        );
        expect(rabbit2.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });

      it('writes the address without the schema when the entry’s classes allow it', async () => {
        const { dm: dm2, rabbit: rabbit2 } = await withCozyDomain();
        await foreign(['top', 'inetOrgPerson', 'twakeWhitePages']);
        (dm2.ldap as unknown as Record<string, unknown>).schemaIndex =
          async () => {
            throw new Error('cn=Subschema unreadable');
          };
        await rabbit2.handler!(GINA);
        expect(await read(dm2, dnOf('in-gina'))).to.have.property(
          'twakeCozyDomain',
          'in-gina.example.org'
        );
        expect(rabbit2.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
      });
    });

    describe('with one offer per DN expression', () => {
      let dm2: DM;
      const orgDn = `ou=acme3,${ORGS}`;

      before(async () => {
        ({ dm: dm2 } = await server({
          ...CLOUDERY_CONFIG,
          twake_instance_cloudery_offer: 'personal;business',
        }));
        await dm2.ldap.add(orgDn, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'acme3',
          l: 'acme.example',
        });
      });

      after(async () => {
        for (const dn of [
          dnOf('in-erin'),
          orgDnOf('acme3', 'in.frank'),
          `ou=users,${orgDn}`,
          orgDn,
        ])
          await dm2.ldap.delete(dn).catch(() => undefined);
      });

      const offerAsked = async (
        fqdn: string,
        add: () => Promise<unknown>
      ): Promise<unknown> => {
        let asked: Record<string, unknown> = {};
        search(fqdn)
          .reply(200, { items: [] })
          .post('/api/v1/instances', body => {
            asked = body as Record<string, unknown>;
            return true;
          })
          .reply(202, {});
        await add();
        return asked.offer;
      };

      it('keeps the organization’s own offer', async () => {
        nock(CLOUDERY).post('/api/v2/organizations').reply(201, {});
        expect(
          await offerAsked('acme3.example.org', () =>
            plugin(dm2).ensureOrganization({
              id: 'acme3',
              name: 'Acme',
              domain: 'acme.example',
            })
          )
        ).to.equal('organization');
      });

      it('asks for the offer of the expression the account matches', async () => {
        await dm2.ldap.modify(orgDn, {
          replace: { businessCategory: '2026-01-01T00:00:00.000Z' },
        });
        await dm2.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });
        expect(
          await offerAsked('in-erin.example.org', () =>
            dm2.ldap.add(dnOf('in-erin'), person('in-erin'), rest())
          )
        ).to.equal('personal');
        expect(
          await offerAsked('infrankacme3.example.org', () =>
            dm2.ldap.add(
              orgDnOf('acme3', 'in.frank'),
              { ...person('in.frank'), mail: 'in.frank@acme.example' },
              rest()
            )
          )
        ).to.equal('business');
      });
    });

    describe('organizations', () => {
      const orgDn = `ou=acme1,${ORGS}`;

      beforeEach(async () => {
        await dm.ldap.delete(`ou=users,${orgDn}`).catch(() => undefined);
        await dm.ldap.delete(orgDn).catch(() => undefined);
        await dm.ldap.add(orgDn, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'acme1',
          l: 'acme.example',
          st: 'Acme',
        });
      });

      // The parent is compared as the directory compares DNs: a base spelled
      // with other spaces or case, or an RDN holding an escaped comma, still
      // names this branch.
      it('recognises an organization under another spelling of its branch', async () => {
        const respelled = `ou=acme9,${ORGS.toUpperCase().replace(/,/g, ' , ')}`;
        const escaped = `ou=a\\,b,${ORGS}`;
        try {
          for (const [dn, ou] of [
            [respelled, 'acme9'],
            [escaped, 'a,b'],
          ])
            await dm.ldap.add(
              dn,
              {
                objectClass: ['top', 'organizationalUnit'],
                ou,
                description: 'evil.example.net',
              },
              rest()
            );
          expect(await read(dm, `ou=acme9,${ORGS}`)).not.to.have.property(
            'description'
          );
          expect(await read(dm, escaped)).not.to.have.property('description');
        } finally {
          for (const dn of [`ou=acme9,${ORGS}`, escaped])
            await dm.ldap.delete(dn).catch(() => undefined);
        }
      });

      it('creates the Cloudery organization and its instance', async () => {
        let asked: Record<string, unknown> = {};
        const scope = search('acme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v2/organizations', {
            ldap_branch: 'acme1',
            name: 'Acme',
            custom_domain: 'acme.example',
          })
          .reply(201, {})
          .post('/api/v1/instances', body => {
            asked = body as Record<string, unknown>;
            return true;
          })
          .reply(202, {});
        expect(
          await plugin(dm).ensureOrganization({
            id: 'acme1',
            name: 'Acme',
            domain: 'acme.example',
          })
        ).to.equal('pending');
        expect(scope.isDone()).to.equal(true);
        expect(asked).to.include({
          oidc: 'acme1',
          email: 'acme1@acme.example',
          offer: 'organization',
          org_id: 'acme1',
        });
      });

      it('knows an organization by its id and own mail without a domain on its entry', async () => {
        const bare = `ou=acme2,${ORGS}`;
        await dm.ldap.add(bare, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'acme2',
        });
        try {
          link('acme2', 'acme2.example.org');
          await rabbit.handler!({
            twakeId: 'acme2',
            internalEmail: 'acme2@acme2.example',
            workplaceFqdn: 'acme2.example.org',
          });
          expect(rabbit.published).to.deep.equal([
            {
              key: 'organization.created',
              message: {
                organizationId: 'acme2',
                workplaceFqdn: 'acme2.example.org',
              },
            },
          ]);
        } finally {
          await dm.ldap.delete(bare);
        }
      });

      const ORG_CREATED = {
        key: 'organization.created',
        message: {
          organizationId: 'acme1',
          workplaceFqdn: 'acme1.example.org',
          organization: 'Acme',
          domain: 'acme.example',
        },
      };
      const orgWorkplace = {
        twakeId: 'acme1',
        internalEmail: 'acme1@acme.example',
        workplaceFqdn: 'acme1.example.org',
      };
      const ORG_INSTANCE = {
        fqdn: 'acme1.example.org',
        internal_email: 'acme1@acme.example',
        oidc: 'acme1',
        instantiated_at: null,
      };
      const erin = orgDnOf('acme1', 'in.erin');
      const erinWorkplace = {
        twakeId: 'inerinacme1',
        internalEmail: 'in.erin@acme.example',
        workplaceFqdn: 'inerinacme1.example.org',
      };
      const ERIN_CREATED = {
        key: 'user.created',
        message: {
          twakeId: 'in.erin',
          internalEmail: 'in.erin@acme.example',
          workplaceFqdn: 'inerinacme1.example.org',
          matrixId: '@in.erin:acme.example',
          organizationId: 'acme1',
          domain: 'acme.example',
          organizationDomain: 'acme.example',
        },
      };

      const addErin = async (): Promise<void> => {
        await dm.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });
        search('acme1.example.org').reply(200, { items: [ORG_INSTANCE] });
        search('inerinacme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v1/instances')
          .reply(202, {});
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: 'in.erin@acme.example' },
          rest()
        );
      };

      afterEach(async () => {
        await dm.ldap.delete(erin).catch(() => undefined);
      });

      it('announces organization.created when its instance is built', async () => {
        const linked = link('acme1', 'acme1.example.org');
        await rabbit.handler!(orgWorkplace);
        expect(linked.isDone()).to.equal(true);
        expect(await read(dm, orgDn)).to.have.property(
          'description',
          'acme1.example.org'
        );
        expect(rabbit.published).to.deep.equal([ORG_CREATED]);
      });

      it('announces nothing while the Cloudery refuses to link the organization', async () => {
        nock(CLOUDERY).patch('/api/v2/organizations/acme1').reply(500, 'down');
        expect(await refusal(rabbit.handler!(orgWorkplace))).to.be.an('error');
        expect(rabbit.published).to.deep.equal([]);
        expect(await read(dm, orgDn)).not.to.have.property('businessCategory');
      });

      it('holds a member’s user.created until its organization is announced', async () => {
        await addErin();
        await rabbit.handler!(erinWorkplace);
        expect(rabbit.published).to.deep.equal([]);
        expect(await read(dm, erin)).to.include({
          description: 'inerinacme1.example.org',
        });
        expect(await read(dm, erin)).not.to.have.property('businessCategory');
        expect(await plugin(dm).ensureInstance(erin, rest())).to.equal('ready');
        expect(rabbit.published).to.deep.equal([]);

        link('acme1', 'acme1.example.org');
        await rabbit.handler!(orgWorkplace);
        expect(rabbit.published).to.deep.equal([ORG_CREATED, ERIN_CREATED]);
        expect(await read(dm, erin)).to.have.property('businessCategory');

        await rabbit.handler!(erinWorkplace);
        link('acme1', 'acme1.example.org');
        await rabbit.handler!(orgWorkplace);
        expect(rabbit.published).to.have.length(2);
      });

      it('holds a respelled member’s user.created too', async () => {
        await addErin();
        await rabbit.handler!(erinWorkplace);
        expect(rabbit.published).to.deep.equal([]);
        const respelled = erin.replace(/,/g, ' , ');
        expect(await plugin(dm).ensureInstance(respelled, rest())).to.equal(
          'ready'
        );
        expect(rabbit.published).to.deep.equal([]);
      });

      it('sends each event once, the organization’s first, when both instances arrive together', async () => {
        await addErin();
        link('acme1', 'acme1.example.org');
        await Promise.all([
          rabbit.handler!(erinWorkplace),
          rabbit.handler!(orgWorkplace),
        ]);
        expect(rabbit.published).to.deep.equal([ORG_CREATED, ERIN_CREATED]);
      });

      it('links an already marked organization and sends its held user.created on a replay', async () => {
        await addErin();
        await rabbit.handler!(erinWorkplace);
        await dm.ldap.modify(orgDn, {
          replace: { businessCategory: '2026-01-01T00:00:00.000Z' },
        });
        const linked = link('acme1', 'acme1.example.org');
        await rabbit.handler!(orgWorkplace);
        expect(linked.isDone()).to.equal(true);
        expect(rabbit.published).to.deep.equal([ERIN_CREATED]);
      });

      it('releases the other members when one fails, and a changed address only once confirmed', async () => {
        await addErin();
        await rabbit.handler!(erinWorkplace);
        const frank = orgDnOf('acme1', 'in.frank');
        search('infrankacme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v1/instances')
          .reply(202, {});
        await dm.ldap.add(
          frank,
          { ...person('in.frank'), mail: 'in.frank@acme.example' },
          rest()
        );
        try {
          await dm.ldap.modify(frank, {
            replace: { description: 'elsewhere.example.org' },
          });
          link('acme1', 'acme1.example.org');
          search('elsewhere.example.org').reply(500, 'down');
          expect(await refusal(rabbit.handler!(orgWorkplace))).to.match(
            /1 member\(s\) of .* not released/
          );
          expect(rabbit.published).to.deep.equal([ORG_CREATED, ERIN_CREATED]);
          expect(await read(dm, frank)).not.to.have.property(
            'businessCategory'
          );
        } finally {
          await dm.ldap.delete(frank).catch(() => undefined);
        }
      });

      const warnings = (): { warned: string[]; restore: () => void } => {
        const warned: string[] = [];
        const logger = plugin(dm).logger;
        const { warn } = logger;
        logger.warn = ((m: string) => {
          warned.push(m);
          return logger;
        }) as typeof warn;
        return { warned, restore: () => (logger.warn = warn) };
      };

      it('warns when a member stays held for an address it cannot confirm', async () => {
        await addErin();
        await rabbit.handler!(erinWorkplace);
        await dm.ldap.modify(erin, {
          replace: { description: 'elsewhere.example.org' },
        });
        link('acme1', 'acme1.example.org');
        search('elsewhere.example.org').reply(200, { items: [] });
        const { warned, restore } = warnings();
        try {
          await rabbit.handler!(orgWorkplace);
        } finally {
          restore();
        }
        expect(rabbit.published).to.deep.equal([ORG_CREATED]);
        expect(warned.join('\n')).to.match(/in\.erin.* stays held/);
      });

      it('writes the name it is given to an organization entry without one', async () => {
        await dm.ldap.modify(orgDn, { delete: ['st'] });
        search('acme1.example.org').reply(200, {
          items: [{ ...ORG_INSTANCE, instantiated_at: '2026-01-01T00:00:00Z' }],
        });
        link('acme1', 'acme1.example.org');
        expect(
          await plugin(dm).ensureOrganization({
            id: 'acme1',
            name: 'Acme',
            domain: 'acme.example',
          })
        ).to.equal('ready');
        expect(await read(dm, orgDn)).to.include({ st: 'Acme' });
        expect(rabbit.published).to.deep.equal([ORG_CREATED]);
      });

      it('announces a member outside its organization entry, with a warning', async () => {
        const outside = `ou=outside,${ORGS}`;
        const gus = `uid=out.gus,ou=acme1,${outside}`;
        const other = await server({
          ...CLOUDERY_CONFIG,
          twake_instance_dn: [
            `^uid=[^,]+,ou=(?<org>[^,]+),ou=outside,${ORGS}$`,
          ],
        });
        await dm.ldap.add(outside, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'outside',
        });
        await dm.ldap.add(`ou=acme1,${outside}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'acme1',
        });
        const warned: string[] = [];
        const logger = plugin(other.dm).logger;
        const { warn } = logger;
        logger.warn = ((m: string) => {
          warned.push(m);
          return logger;
        }) as typeof warn;
        try {
          search('acme1.example.org').reply(200, { items: [ORG_INSTANCE] });
          search('outgusacme1.example.org')
            .reply(200, { items: [] })
            .post('/api/v1/instances')
            .reply(202, {});
          await other.dm.ldap.add(
            gus,
            { ...person('out.gus'), mail: 'out.gus@acme.example' },
            rest()
          );
          await other.rabbit.handler!({
            twakeId: 'outgusacme1',
            internalEmail: 'out.gus@acme.example',
            workplaceFqdn: 'outgusacme1.example.org',
          });
        } finally {
          logger.warn = warn;
          for (const dn of [gus, `ou=acme1,${outside}`, outside])
            await dm.ldap.delete(dn).catch(() => undefined);
        }
        expect(other.rabbit.published.map(p => p.key)).to.deep.equal([
          'user.created',
        ]);
        expect(warned.join('\n')).to.match(/not below its organization entry/);
      });

      it('refuses to start when the schema defines no name attribute', async () => {
        expect(
          await refusal(
            server({
              ...CLOUDERY_CONFIG,
              twake_instance_organization_name_attribute: 'noSuchAttribute',
            })
          )
        ).to.match(/schema defines no noSuchAttribute/);
      });

      it('warns, and asks for no organization, when its entry has no name', async () => {
        await dm.ldap.modify(orgDn, { delete: ['st'] });
        await dm.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });
        const warned: string[] = [];
        const logger = plugin(dm).logger;
        const { warn } = logger;
        logger.warn = ((m: string) => {
          warned.push(m);
          return logger;
        }) as typeof warn;
        try {
          const scope = search('inerinacme1.example.org')
            .reply(200, { items: [] })
            .post('/api/v1/instances', body => body.slug === 'inerinacme1')
            .reply(202, {});
          await dm.ldap.add(
            erin,
            { ...person('in.erin'), mail: 'in.erin@acme.example' },
            rest()
          );
          expect(scope.isDone()).to.equal(true);
        } finally {
          logger.warn = warn;
        }
        expect(warned.join('\n')).to.match(/organization acme1 has no st or l/);
      });

      it('takes the organization’s instance another member asked for first', async () => {
        await dm.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });
        const scope = search('acme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v2/organizations')
          .reply(201, {})
          .post('/api/v1/instances', body => body.slug === 'acme1')
          .reply(409, 'taken')
          .get('/api/v2/instances')
          .query({ fqdn: 'acme1.example.org', limit: '1' })
          .reply(200, { items: [ORG_INSTANCE] })
          .get('/api/v2/instances')
          .query({ fqdn: 'inerinacme1.example.org', limit: '1' })
          .reply(200, { items: [] })
          .post('/api/v1/instances', body => body.slug === 'inerinacme1')
          .reply(202, {});
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: 'in.erin@acme.example' },
          rest()
        );
        expect(scope.isDone()).to.equal(true);
      });

      it('asks for a missing organization before a member’s instance', async () => {
        await dm.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });
        const scope = search('acme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v2/organizations', {
            ldap_branch: 'acme1',
            name: 'Acme',
            custom_domain: 'acme.example',
          })
          .reply(201, {})
          .post('/api/v1/instances', body => body.slug === 'acme1')
          .reply(202, {})
          .get('/api/v2/instances')
          .query({ fqdn: 'inerinacme1.example.org', limit: '1' })
          .reply(200, { items: [] })
          .post('/api/v1/instances', body => body.slug === 'inerinacme1')
          .reply(202, {});
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: 'in.erin@acme.example' },
          rest()
        );
        expect(scope.isDone()).to.equal(true);
        expect(rabbit.published).to.deep.equal([]);
      });

      const PLATFORM_ORG_INSTANCE = {
        ...ORG_INSTANCE,
        _id: 'acme1-instance',
        internal_email: 'acme1@example.org',
        instantiated_at: '2026-03-13T12:33:17Z',
      };
      const clouderyOrg = (instanceId: string, times = 1) =>
        nock(CLOUDERY)
          .get('/api/v2/organizations/acme1')
          .times(times)
          .reply(200, { ldap_branch: 'acme1', instance_id: instanceId });
      const addUsersOu = () =>
        dm.ldap.add(`ou=users,${orgDn}`, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'users',
        });

      it('announces an organization whose built instance is owned at the platform domain, then its members', async () => {
        await addUsersOu();
        search('acme1.example.org')
          .times(2)
          .reply(200, { items: [PLATFORM_ORG_INSTANCE] });
        clouderyOrg('acme1-instance', 2);
        const asked = search('inerinacme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v1/instances', body => body.slug === 'inerinacme1')
          .reply(202, {});
        const linked = link('acme1', 'acme1.example.org');
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: ERIN_CREATED.message.internalEmail },
          rest()
        );
        expect(asked.isDone()).to.equal(true);
        expect(linked.isDone()).to.equal(true);
        expect(rabbit.published).to.deep.equal([ORG_CREATED]);
        expect(await read(dm, orgDn)).to.have.property('businessCategory');

        await rabbit.handler!(erinWorkplace);
        expect(rabbit.published).to.deep.equal([ORG_CREATED, ERIN_CREATED]);
      });

      // A member added while the organization's instance was still built
      const addHeldMember = async () => {
        await addUsersOu();
        search('acme1.example.org').reply(200, {
          items: [{ ...PLATFORM_ORG_INSTANCE, instantiated_at: null }],
        });
        clouderyOrg('acme1-instance');
        search('inerinacme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v1/instances')
          .reply(202, {});
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: ERIN_CREATED.message.internalEmail },
          rest()
        );
        expect(rabbit.published).to.deep.equal([]);
      };

      it('announces the organization when a caller who may write it makes sure of a member', async () => {
        await addHeldMember();
        search('acme1.example.org')
          .times(2)
          .reply(200, { items: [PLATFORM_ORG_INSTANCE] });
        clouderyOrg('acme1-instance', 2);
        const asked = search('inerinacme1.example.org')
          .reply(200, { items: [] })
          .post('/api/v1/instances')
          .reply(202, {});
        const linked = link('acme1', 'acme1.example.org');
        expect(await plugin(dm).ensureInstance(erin, rest())).to.equal(
          'pending'
        );
        expect(asked.isDone()).to.equal(true);
        expect(linked.isDone()).to.equal(true);
        expect(rabbit.published).to.deep.equal([ORG_CREATED]);
        expect(await read(dm, orgDn)).to.have.property('businessCategory');

        await rabbit.handler!(erinWorkplace);
        expect(rabbit.published).to.deep.equal([ORG_CREATED, ERIN_CREATED]);
      });

      it('keeps the mark the organization’s workplace.created sets while a caller makes sure of a member', async () => {
        await addHeldMember();
        search('inerinacme1.example.org')
          .reply(200, {
            items: [
              {
                fqdn: 'inerinacme1.example.org',
                internal_email: ERIN_CREATED.message.internalEmail,
                instantiated_at: null,
              },
            ],
          })
          .persist();
        nock(CLOUDERY)
          .patch('/api/v2/organizations/acme1', {
            instance_fqdn: 'acme1.example.org',
          })
          .reply(200, {})
          .persist();
        clouderyOrg('acme1-instance');
        // nock 15 no longer types the reply callback: its parameters are
        // named here rather than read from the overload nock 14 carried
        search('acme1.example.org').reply(
          (
            _uri: string,
            _body: string | Record<string, unknown>,
            answer: (
              err: NodeJS.ErrnoException | null,
              result: [number, string | Record<string, unknown>]
            ) => void
          ) => {
            rabbit.handler!(orgWorkplace).then(
              () => answer(null, [200, { items: [PLATFORM_ORG_INSTANCE] }]),
              (err: Error) => answer(err, [500, {}])
            );
          }
        );
        try {
          expect(await plugin(dm).ensureInstance(erin, rest())).to.equal(
            'pending'
          );
          expect(rabbit.published).to.deep.equal([ORG_CREATED]);
          expect(await read(dm, orgDn)).to.have.property('businessCategory');
        } finally {
          nock.cleanAll();
        }
      });

      const memberOnlyCaller = async (work: (caller: Request) => unknown) => {
        const memberOnly = (args: unknown[]) => {
          const req = args[args.length - 1] as Request | undefined;
          if (args[0] === orgDn && req?.headers?.['x-test'] === 'member-only')
            throw new ForbiddenError('organization read only');
          return args;
        };
        dm.hookBus.subscribe('ldapmodifyrequest', memberOnly as never);
        try {
          await work({
            user: 'admin',
            headers: { 'x-test': 'member-only' },
          } as unknown as Request);
        } finally {
          dm.hookBus.unsubscribe('ldapmodifyrequest', memberOnly as never);
          nock.cleanAll();
        }
      };

      it('refuses a caller who may not write the organization, and leaves it unannounced', async () => {
        await addHeldMember();
        await memberOnlyCaller(async caller => {
          search('acme1.example.org').reply(200, {
            items: [PLATFORM_ORG_INSTANCE],
          });
          clouderyOrg('acme1-instance');
          const linked = link('acme1', 'acme1.example.org');
          expect(
            await refusal(plugin(dm).ensureInstance(erin, caller))
          ).to.be.instanceOf(ForbiddenError);
          expect(linked.isDone()).to.equal(false);
          expect(rabbit.published).to.deep.equal([]);
          expect(await read(dm, orgDn)).not.to.have.property(
            'businessCategory'
          );
        });
      });

      it('does not refuse a caller who may not write the organization while its instance is built', async () => {
        await addHeldMember();
        await memberOnlyCaller(async caller => {
          search('acme1.example.org').reply(200, {
            items: [{ ...PLATFORM_ORG_INSTANCE, instantiated_at: null }],
          });
          clouderyOrg('acme1-instance');
          search('inerinacme1.example.org').reply(200, {
            items: [
              {
                fqdn: 'inerinacme1.example.org',
                internal_email: ERIN_CREATED.message.internalEmail,
                instantiated_at: null,
              },
            ],
          });
          expect(await plugin(dm).ensureInstance(erin, caller)).to.equal(
            'pending'
          );
          expect(rabbit.published).to.deep.equal([]);
        });
      });

      const refusedAsTaken = async () =>
        String(
          await refusal(
            plugin(dm).ensureOrganization({
              id: 'acme1',
              name: 'Acme',
              domain: 'acme.example',
            })
          )
        );

      it('takes no instance without an id for the organization’s, though the organization is linked to none', async () => {
        const { _id: _ignored, ...withoutId } = PLATFORM_ORG_INSTANCE;
        search('acme1.example.org').reply(200, { items: [withoutId] });
        nock(CLOUDERY)
          .get('/api/v2/organizations/acme1')
          .optionally()
          .reply(200, { ldap_branch: 'acme1' });
        expect(await refusedAsTaken()).to.match(/belongs to another user/);
        nock.cleanAll();
      });

      it('takes no instance for the organization’s when the Cloudery has no such organization', async () => {
        search('acme1.example.org').reply(200, {
          items: [PLATFORM_ORG_INSTANCE],
        });
        nock(CLOUDERY).get('/api/v2/organizations/acme1').reply(404, {});
        expect(await refusedAsTaken()).to.match(/belongs to another user/);
      });

      it('takes no personal instance at its address for the organization’s', async () => {
        await addUsersOu();
        search('acme1.example.org').reply(200, {
          items: [{ ...PLATFORM_ORG_INSTANCE, _id: 'someone-else' }],
        });
        const looked = clouderyOrg('acme1-instance');
        const member = search('inerinacme1.example.org').reply(200, {
          items: [],
        });
        await dm.ldap.add(
          erin,
          { ...person('in.erin'), mail: ERIN_CREATED.message.internalEmail },
          rest()
        );
        expect(looked.isDone()).to.equal(true);
        expect(member.isDone()).to.equal(false);
        expect(rabbit.published).to.deep.equal([]);
        nock.cleanAll();
      });
    });
  });

  describe('with expressions written for one spelling', () => {
    let dm: DM;
    let rabbit: StubRabbitMq;

    const BASE = process.env.DM_LDAP_BASE as string;
    // One expression spells the branch with one space where the directory
    // stores two; the other uses the directory's own two
    const myOrg = `ou=My  Org,${BASE}`;
    const hisOrg = `ou=His  Org,${BASE}`;
    const his = `uid=in-his,${hisOrg}`;
    const my = `uid=in-my,${myOrg}`;

    before(async () => {
      ({ dm, rabbit } = await server({
        twake_instance_provider: 'cloudery',
        twake_instance_cloudery_url: CLOUDERY,
        twake_instance_cloudery_token: 'tok',
        twake_instance_cloudery_domain: 'example.org',
        twake_instance_cloudery_offer: 'standard',
        twake_instance_dn: [
          `^uid=in-[^,]+,ou=My Org,${BASE}$`,
          `^uid=in-[^,]+,ou=His  Org,${BASE}$`,
          `^uid=[^,]+,ou=users,${BASE}$`,
        ],
        twake_instance_fqdn_attribute: 'description',
        twake_instance_sent_attribute: 'businessCategory',
        twake_lifecycle_deleted_attribute: 'carLicense',
      }));
      for (const [dn, ou] of [
        [myOrg, 'My  Org'],
        [hisOrg, 'His  Org'],
      ])
        await dm.ldap
          .add(dn, { objectClass: ['top', 'organizationalUnit'], ou })
          .catch(() => undefined);
    });

    after(async () => {
      for (const dn of [myOrg, hisOrg])
        await dm.ldap.delete(dn).catch(() => undefined);
    });

    beforeEach(() => (rabbit.published = []));

    afterEach(async () => {
      for (const dn of [his, my])
        await dm.ldap.delete(dn).catch(() => undefined);
    });

    it('matches an expression written as the directory spells it', async () => {
      const scope = search('in-his.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances')
        .reply(202, {});
      await dm.ldap.add(his, person('in-his'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(await read(dm, his)).not.to.have.property('description');
    });

    it('does not take an escaped comma for a branch separator', async () => {
      // This entry's uid holds the comma: it sits beside ou=users, not under
      // it, and must not pass for an account
      const dn = `uid=pr-f\\,ou=users,${BASE}`;
      let asked = false;
      nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(true)
        .optionally()
        .reply(200, () => {
          asked = true;
          return { items: [] };
        });
      try {
        await dm.ldap.add(
          dn,
          person('pr-f,ou=users', {
            description: 'evil.example.net',
            businessCategory: '2026-01-01T00:00:00Z',
          }),
          rest()
        );
        expect(asked).to.equal(false);
        const entry = await read(dm, dn);
        expect(entry).to.have.property('description', 'evil.example.net');
        expect(entry).to.have.property(
          'businessCategory',
          '2026-01-01T00:00:00Z'
        );
      } finally {
        await dm.ldap.delete(dn).catch(() => undefined);
      }
    });

    it('finds the account by mail when the directory answers another spelling', async () => {
      search('in-my.example.org')
        .reply(200, { items: [] })
        .post('/api/v1/instances')
        .reply(202, {});
      await dm.ldap.add(my, person('in-my'), rest());
      await rabbit.handler!({
        twakeId: 'in-my',
        internalEmail: 'in-my@example.org',
        workplaceFqdn: 'in-my.example.org',
      });
      expect(await read(dm, my)).to.have.property(
        'description',
        'in-my.example.org'
      );
      expect(rabbit.published.map(p => p.key)).to.deep.equal(['user.created']);
    });
  });

  describe('with cozy-stack', () => {
    let dm: DM;
    let rabbit: StubRabbitMq;

    const instance = (email: string, oidc: string, onboarded = true) => ({
      data: {
        attributes: {
          email,
          oidc_id: oidc,
          ...(onboarded ? { onboarding_finished: true } : {}),
        },
      },
    });

    before(async () => {
      ({ dm, rabbit } = await server({
        twake_instance_provider: 'cozy-stack',
        twake_instance_cozy_url: COZY,
        twake_instance_cozy_domain: 'example.org',
        twake_instance_cozy_org_id: 'linagora',
        twake_instance_cozy_org_domain: 'linagora.example',
        twake_instance_organization_base: ORGS,
        twake_instance_organization_domain_attribute: 'l',
        twake_instance_organization_name_attribute: 'st',
      }));
      // An organization not announced yet: cozy-stack holds none of its members
      for (const [dn, ou] of [
        [ORGS, 'in-orgs'],
        [`ou=linagora,${ORGS}`, 'linagora'],
      ])
        await dm.ldap
          .add(dn, { objectClass: ['top', 'organizationalUnit'], ou })
          .catch(() => undefined);
    });

    after(async () => {
      for (const dn of [`ou=linagora,${ORGS}`, ORGS])
        await dm.ldap.delete(dn).catch(() => undefined);
    });

    beforeEach(() => (rabbit.published = []));

    afterEach(async () => {
      for (const uid of ['in-alice', 'in-Bob.X'])
        await dm.ldap.delete(dnOf(uid)).catch(() => undefined);
    });

    it('keeps the uid as OIDC id, the OP’s sub, while the address drops its dots', async () => {
      const scope = nock(COZY)
        .get('/instances/in-bobx.example.org')
        .reply(404)
        .post('/instances')
        .query(
          q => q.Domain === 'in-bobx.example.org' && q.OIDCID === 'in-Bob.X'
        )
        .reply(201, {})
        .patch('/instances/in-bobx.example.org')
        .query(true)
        .reply(200, {});
      await dm.ldap.add(dnOf('in-Bob.X'), person('in-Bob.X'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(rabbit.published[0]?.message).to.include({ twakeId: 'in-Bob.X' });
    });

    it('finishes the onboarding of an instance found unfinished', async () => {
      const answered = await outboundCalls('cozy-stack', '200');
      const scope = nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice', false))
        .patch('/instances/in-alice.example.org')
        .query({ OnboardingFinished: 'true' })
        .reply(200, {});
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(await outboundCalls('cozy-stack', '200')).to.equal(answered + 2);
      expect(await read(dm, dnOf('in-alice'))).to.have.property(
        'description',
        'in-alice.example.org'
      );
    });

    it('builds the instance as cozyProvision did, and announces the account in the request, its organization announced or not', async () => {
      const scope = nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(404)
        .post('/instances')
        .query(
          q =>
            q.Domain === 'in-alice.example.org' &&
            q.OIDCID === 'in-alice' &&
            q.Locale === 'fr' &&
            q.ContextName === 'default' &&
            q.OrgID === 'linagora' &&
            q.OrgDomain === 'linagora.example'
        )
        .reply(201, {})
        .patch('/instances/in-alice.example.org')
        .query({ OnboardingFinished: 'true' })
        .reply(200, {});
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      expect(scope.isDone()).to.equal(true);
      expect(await read(dm, dnOf('in-alice'))).to.have.property(
        'description',
        'in-alice.example.org'
      );
      expect(rabbit.published).to.deep.equal([
        {
          key: 'user.created',
          message: {
            twakeId: 'in-alice',
            internalEmail: 'in-alice@example.org',
            workplaceFqdn: 'in-alice.example.org',
            matrixId: '@in-alice:example.org',
            organizationId: 'linagora',
            domain: 'linagora.example',
            organizationDomain: 'linagora.example',
          },
        },
      ]);
    });

    it('takes an existing instance only when it is this user’s', async () => {
      nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'));
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      expect(await read(dm, dnOf('in-alice'))).to.have.property(
        'description',
        'in-alice.example.org'
      );
    });

    it('leaves an account pending when its address is someone else’s', async () => {
      nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('mallory@example.org', 'mallory'));
      expect(await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest())).to
        .be.true;
      expect(await read(dm, dnOf('in-alice'))).not.to.have.property(
        'description'
      );
      expect(rabbit.published).to.deep.equal([]);
    });

    it('destroys the instance of a deleted account, and only its own', async () => {
      nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'));
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      const destroyed = nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'))
        .delete('/instances/in-alice.example.org')
        .reply(204);
      await dm.ldap.delete(dnOf('in-alice'));
      // ldapdeletedone is not awaited by the delete
      for (let i = 0; i < 50 && !destroyed.isDone(); i++)
        await new Promise(r => setTimeout(r, 10));
      expect(destroyed.isDone()).to.equal(true);

      nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'));
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      const other = nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('mallory@example.org', 'mallory'));
      const kept = nock(COZY)
        .delete('/instances/in-alice.example.org')
        .reply(204);
      await dm.ldap.delete(dnOf('in-alice'));
      for (let i = 0; i < 50 && !other.isDone(); i++)
        await new Promise(r => setTimeout(r, 10));
      expect(kept.isDone()).to.equal(false);
    });

    it('destroys the instance of an account deleted under another spelling', async () => {
      nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'));
      await dm.ldap.add(dnOf('in-alice'), person('in-alice'), rest());
      const destroyed = nock(COZY)
        .get('/instances/in-alice.example.org')
        .reply(200, instance('in-alice@example.org', 'in-alice'))
        .delete('/instances/in-alice.example.org')
        .reply(204);
      await dm.ldap.delete(
        `userid=in-alice , ${USERS.toUpperCase().replace(/,/g, ' , ')}`
      );
      for (let i = 0; i < 50 && !destroyed.isDone(); i++)
        await new Promise(r => setTimeout(r, 10));
      expect(destroyed.isDone()).to.equal(true);
    });

    it('refuses to start without a broker', async () => {
      const dm2 = new DM();
      Object.assign(dm2.config, dm.config);
      await dm2.ready;
      const down = new StubRabbitMq();
      down.up = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dm2.loadedPlugins['rabbitmq'] = down as any;
      expect(
        String(
          await refusal(
            dm2.registerPlugin('core/twake/instances', new TwakeInstances(dm2))
          )
        )
      ).to.match(/RabbitMQ is required/);
    });
  });

  describe('at startup', () => {
    const construct = async (config: Record<string, unknown>) => {
      const dm = new DM();
      Object.assign(dm.config, BASE_CONFIG, {
        twake_instance_provider: 'cloudery',
        twake_instance_cloudery_url: CLOUDERY,
        twake_instance_cloudery_domain: 'example.org',
        ...config,
      });
      await dm.ready;
      return () => new TwakeInstances(dm);
    };

    it('refuses to run next to the plugins it replaces', async () => {
      for (const old of [
        'core/twake/cozyProvision',
        'core/twake/clouderyProvision',
      ])
        expect(await construct({ plugin: [old] })).to.throw(/load one of them/);
    });

    it('refuses more Cloudery offers than DN expressions', async () => {
      expect(
        await construct({ twake_instance_cloudery_offer: 'a;b;c' })
      ).to.throw(/more offers/);
    });

    it('reads the Cloudery offers as written in an environment variable', async () => {
      const offersOf = async (offer: string) => {
        const instances = (
          await construct({
            twake_instance_dn: ['ou=a$', 'ou=b$', 'ou=c$'],
            twake_instance_cloudery_offer: offer,
          })
        )() as unknown as {
          account: (
            dn: string,
            entry: AttributesList
          ) => Promise<{ offer?: string } | undefined>;
        };
        return Promise.all(
          ['a', 'b', 'c'].map(
            async ou =>
              (
                await instances.account(`uid=x,ou=${ou}`, {
                  uid: 'x',
                  mail: 'x@example.org',
                })
              )?.offer
          )
        );
      };
      expect(await offersOf(' personal ;; business ;')).to.deep.equal([
        'personal',
        undefined,
        'business',
      ]);
      expect(await offersOf('personal;business')).to.deep.equal([
        'personal',
        'business',
        undefined,
      ]);
    });

    it('refuses an id template naming a group no DN rule captures', async () => {
      expect(await construct({ twake_instance_id: '{uid}{orgg}' })).to.throw(
        /\{orgg\}/
      );
    });
  });

  describe('providers', () => {
    it('give up on a provider that does not answer in time', async () => {
      nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(true)
        .delay(500)
        .reply(200, { items: [] });
      const cloudery = new ClouderyProvider(
        CLOUDERY,
        't',
        'example.org',
        '',
        50
      );
      const request = {
        id: 'in-alice',
        email: 'in-alice@example.org',
        publicName: 'Alice',
        locale: 'en',
      };
      expect(await refusal(cloudery.find(request))).to.have.property(
        'statusCode',
        504
      );
      nock(COZY).get('/instances/in-alice.example.org').delay(500).reply(404);
      const cozy = new CozyStackProvider(
        COZY,
        'admin',
        'x',
        'example.org',
        '',
        '',
        50
      );
      expect(await refusal(cozy.find(request))).to.have.property(
        'statusCode',
        504
      );
    });

    it('give up on an answer whose body does not come in time', async () => {
      nock(CLOUDERY)
        .get('/api/v2/instances')
        .query(true)
        .delay(500)
        .reply(200, { items: [] });
      const cloudery = new ClouderyProvider(
        CLOUDERY,
        't',
        'example.org',
        '',
        50
      );
      expect(
        await refusal(
          cloudery.find({
            id: 'in-alice',
            email: 'in-alice@example.org',
            publicName: 'Alice',
            locale: 'en',
          })
        )
      ).to.have.property('statusCode', 504);
    });
  });
});
