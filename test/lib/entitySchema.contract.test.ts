/**
 * One schema, one answer: the same attribute rules, written in a schema of
 * each kind, are enforced alike by the flat routes, the group routes and the
 * organization routes. The three fixtures declare the same `description`,
 * `businessCategory` and `seeAlso`; each case below is sent to the three
 * entities, on a creation and on a change.
 *
 * `divergences` lists what one entity still answers otherwise; those cases
 * are skipped there, and the list is meant to shrink.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';
import type { AttributesList } from '../../src/lib/ldapActions';

import { DM } from '../../src/bin';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import { skipIfMissingEnvVars, LDAP_ENV_VARS_WITH_ORG } from '../helpers/env';

type Body = Record<string, unknown>;

interface Entity {
  name: string;
  classes: string[] | (() => string[]);
  route: string;
  dn: () => string;
  /** The body of a valid creation, with the attributes under test added */
  create: (attributes: Body) => Body;
  /** What the directory holds before a change is tried */
  stored: () => AttributesList;
  modifyUrl: () => string;
}

/** What one kind of entity still answers otherwise, by `<entity>: <case>` */
const divergences: Record<string, string> = {
  'users: refuses an array for a string':
    'the flat routes store every value of the array',
  'groups: refuses a replace of a fixed attribute':
    'the group routes drop the attribute and answer 200',
};

describe('Entity schema contract', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let pointee: string;
  const previous = {
    group: process.env.DM_GROUP_SCHEMA,
    organization: process.env.DM_ORGANIZATION_SCHEMA,
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    pointee = `uid=contract-pointee,ou=users,${base}`;
    process.env.DM_GROUP_SCHEMA = './test/fixtures/schemas/contractGroups.json';
    process.env.DM_ORGANIZATION_SCHEMA =
      './test/fixtures/schemas/contractOrganizations.json';
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/contractPeople.json',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await server.ldap.add(pointee, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'contract-pointee',
      cn: 'Pointee',
      sn: 'Contract',
    });
  });

  after(async () => {
    await server.ldap.delete(pointee).catch(() => undefined);
    for (const [key, value] of Object.entries(previous)) {
      const name = `DM_${key.toUpperCase()}_SCHEMA`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const entities: Entity[] = [
    {
      name: 'users',
      classes: ['top', 'inetOrgPerson'],
      route: '/api/v1/ldap/contractPeople',
      dn: () => `uid=contract-alice,ou=users,${base}`,
      create: attributes => ({
        uid: 'contract-alice',
        cn: 'Alice',
        sn: 'Contract',
        description: 'A person',
        ...attributes,
      }),
      stored: () => ({
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'contract-alice',
        cn: 'Alice',
        sn: 'Contract',
        description: 'A person',
      }),
      modifyUrl: () => '/api/v1/ldap/contractPeople/contract-alice',
    },
    {
      name: 'groups',
      classes: ['top', 'groupOfNames'],
      route: '/api/v1/ldap/groups',
      dn: () => `cn=contract-group,${process.env.DM_LDAP_GROUP_BASE || base}`,
      create: attributes => ({
        cn: 'contract-group',
        member: [pointee],
        description: 'A group',
        ...attributes,
      }),
      stored: () => ({
        objectClass: ['top', 'groupOfNames'],
        cn: 'contract-group',
        member: [pointee],
        description: 'A group',
      }),
      modifyUrl: () => '/api/v1/ldap/groups/contract-group',
    },
    {
      name: 'organizations',
      classes: () => server.config.ldap_organization_class as string[],
      route: '/api/v1/ldap/organizations',
      dn: () => `ou=ContractOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`,
      create: attributes => ({
        ou: 'ContractOrg',
        description: 'An organization',
        ...attributes,
      }),
      stored: () => ({
        objectClass: server.config.ldap_organization_class as string[],
        ou: 'ContractOrg',
        description: 'An organization',
      }),
      modifyUrl: () =>
        `/api/v1/ldap/organizations/${encodeURIComponent(
          `ou=ContractOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`
        )}`,
    },
  ];

  /** Attributes refused alike on a creation and in a `replace` */
  const refused: Array<{ title: string; attributes: Body }> = [
    { title: 'an unknown attribute', attributes: { nosuchattribute: 'x' } },
    {
      title: 'a value failing the pattern',
      attributes: { businessCategory: 'Not Valid' },
    },
    { title: 'an empty string', attributes: { businessCategory: '' } },
    { title: 'an array for a string', attributes: { description: ['a', 'b'] } },
    { title: 'a number for a string', attributes: { description: 42 } },
    { title: 'an empty pointer', attributes: { seeAlso: '' } },
    {
      title: 'a pointer outside its branch',
      attributes: { seeAlso: () => process.env.DM_LDAP_TOP_ORGANIZATION },
    },
    {
      title: 'a pointer to a missing entry',
      attributes: { seeAlso: () => `uid=contract-nobody,ou=users,${base}` },
    },
  ];

  const resolve = (attributes: Body): Body =>
    Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [
        key,
        typeof value === 'function' ? (value as () => unknown)() : value,
      ])
    );

  const classes = (entity: Entity): string[] =>
    typeof entity.classes === 'function' ? entity.classes() : entity.classes;

  const classesOf = async (dn: string): Promise<unknown> => {
    const result = (await server.ldap
      .search({ paged: false, scope: 'base', attributes: ['objectClass'] }, dn)
      .catch(() => ({ searchEntries: [] }))) as SearchResult;
    return result.searchEntries[0]?.objectClass;
  };

  const created = (res: supertest.Response): void => {
    expect([200, 201], JSON.stringify(res.body)).to.include(res.status);
  };

  for (const entity of entities) {
    const test = (
      title: string
    ): Mocha.TestFunction | Mocha.PendingTestFunction => {
      const reason = divergences[`${entity.name}: ${title}`];
      return reason ? it.skip : it;
    };

    describe(entity.name, () => {
      afterEach(async () => {
        await server.ldap.delete(entity.dn()).catch(() => undefined);
      });

      describe('on a creation', () => {
        test('accepts a valid body')('accepts a valid body', async () => {
          const res = await request.post(entity.route).send(entity.create({}));
          created(res);
          expect(await classesOf(entity.dn())).to.have.members(classes(entity));
        });

        test('keeps its own classes')('keeps its own classes', async () => {
          const res = await request
            .post(entity.route)
            .send(entity.create({ objectClass: ['top', 'extensibleObject'] }));
          created(res);
          expect(await classesOf(entity.dn())).to.have.members(classes(entity));
        });

        for (const required of ['a missing', 'an empty']) {
          const title = `refuses ${required} required attribute`;
          test(title)(title, async () => {
            const body = entity.create({});
            if (required === 'a missing') delete body.description;
            else body.description = '';
            const res = await request.post(entity.route).send(body);
            expect(res.status, JSON.stringify(res.body)).to.equal(400);
            expect(res.body.error).to.match(/description.*required/);
          });
        }

        for (const { title, attributes } of refused) {
          test(`refuses ${title}`)(`refuses ${title}`, async () => {
            const res = await request
              .post(entity.route)
              .send(entity.create(resolve(attributes)));
            expect(res.status, JSON.stringify(res.body)).to.equal(400);
            expect(await classesOf(entity.dn())).to.be.undefined;
          });
        }
      });

      describe('on a change', () => {
        beforeEach(async () => {
          await server.ldap.add(entity.dn(), entity.stored());
        });

        test('accepts a valid replace')('accepts a valid replace', async () => {
          const res = await request
            .put(entity.modifyUrl())
            .send({ replace: { description: 'Changed', seeAlso: pointee } });
          expect(res.status, JSON.stringify(res.body)).to.equal(200);
        });

        const fixed = 'refuses a replace of a fixed attribute';
        test(fixed)(fixed, async () => {
          const res = await request
            .put(entity.modifyUrl())
            .send({ replace: { objectClass: ['top', 'extensibleObject'] } });
          expect(res.status, JSON.stringify(res.body)).to.equal(400);
          expect(await classesOf(entity.dn())).to.have.members(classes(entity));
        });

        for (const { title, attributes } of refused) {
          test(`refuses ${title}`)(`refuses ${title}`, async () => {
            const res = await request
              .put(entity.modifyUrl())
              .send({ replace: resolve(attributes) });
            expect(res.status, JSON.stringify(res.body)).to.equal(400);
          });
        }
      });
    });
  }
});
