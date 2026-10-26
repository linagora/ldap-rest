/**
 * One schema, one answer: the same attribute rules, written in a schema of
 * each kind, are enforced alike by the flat routes, the group routes and the
 * organization routes. The three fixtures declare the same attributes; every
 * case below is sent to the three entities, and a refusal has to come from
 * the schema, before the write, not from the directory.
 *
 * `divergences` lists what one kind still answers otherwise, by entity, phase
 * and case; those cases are skipped there with the reason, and the list is
 * meant to shrink.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../src/bin';
import type { AttributesList } from '../../src/lib/ldapActions';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import { skipIfMissingEnvVars, LDAP_ENV_VARS_WITH_ORG } from '../helpers/env';

type Body = Record<string, unknown>;
type Phase = 'creation' | 'replace' | 'add' | 'delete';

interface Entity {
  name: string;
  classes: () => string[];
  route: string;
  dn: () => string;
  /** The body of a valid creation, with the attributes under test added */
  create: (attributes: Body) => Body;
  /** What the directory holds before a change is tried */
  stored: () => AttributesList;
  modifyUrl: () => string;
}

/** What one kind still answers otherwise, by `<entity>: <phase>: <case>` */
const divergences: Record<string, string> = {
  'users: creation: refuses an array for a string': 'stores every value',
  'users: replace: refuses an array for a string': 'stores every value',
  'users: add: refuses an array for a string': 'stores every value',
  'users: creation: refuses a string that is not a number for a number':
    'stores it',
  'users: replace: refuses a string that is not a number for a number':
    'stores it',
  'users: add: refuses a string that is not a number for a number': 'stores it',
  'users: creation: refuses a string for an array of pointers': 'stores it',
  'users: replace: refuses a string for an array of pointers': 'stores it',
  'users: add: refuses a string for an array of pointers': 'stores it',
  'users: replace: refuses null for a required attribute': 'answers 500',
  'users: delete: refuses deleting a required attribute': 'deletes it',
  'users: delete: refuses deleting an attribute the schema does not declare':
    'answers 404',
  'groups: creation: writes a fixed attribute as the schema says':
    'writes nothing',
  'groups: replace: refuses a replace of the classes': 'drops it, answers 200',
  'groups: replace: refuses a fixed attribute': 'drops it, answers 200',
  'groups: add: refuses a fixed attribute': 'drops it, answers 200',
  'groups: delete: refuses deleting a fixed attribute': 'drops it, answers 200',
  'organizations: creation: refuses a string that is not a number for a number':
    'stores it',
  'organizations: replace: refuses a string that is not a number for a number':
    'stores it',
  'organizations: add: refuses a string that is not a number for a number':
    'stores it',
  'organizations: creation: refuses a string for an array of pointers':
    'stores it',
  'organizations: replace: refuses a string for an array of pointers':
    'stores it',
  'organizations: add: refuses a string for an array of pointers': 'stores it',
  'organizations: delete: refuses deleting a required attribute': 'deletes it',
  'organizations: delete: refuses deleting an attribute the schema does not declare':
    'answers 404',
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
    // extensibleObject lets the three kinds hold the same attributes
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/contractPeople.json',
    ];
    server.config.group_class = ['top', 'groupOfNames', 'extensibleObject'];
    server.config.ldap_organization_class = [
      'top',
      'organizationalUnit',
      'extensibleObject',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    const groups = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groups);
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    for (let i = 0; i < 50 && !(groups.schema && organizations.schema); i++)
      await new Promise(r => setTimeout(r, 100));
    expect(groups.schema?.attributes.l?.fixed, 'group schema').to.be.true;
    expect(organizations.schema?.attributes.l?.fixed, 'organization schema').to
      .be.true;
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await server.ldap.delete(pointee).catch(() => undefined);
    await server.ldap.add(pointee, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'contract-pointee',
      cn: 'Pointee',
      sn: 'Contract',
    });
  });

  after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      const name = `DM_${key.toUpperCase()}_SCHEMA`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await server?.ldap.delete(pointee).catch(() => undefined);
  });

  const entities: Entity[] = [
    {
      name: 'users',
      classes: () => ['top', 'inetOrgPerson', 'extensibleObject'],
      route: '/api/v1/ldap/contractPeople',
      dn: () => `uid=contract-alice,ou=users,${base}`,
      create: attributes => ({
        uid: 'contract-alice',
        cn: 'Alice',
        sn: 'Contract',
        description: 'A person',
        businessCategory: 'valid',
        ...attributes,
      }),
      stored: () => ({
        objectClass: ['top', 'inetOrgPerson', 'extensibleObject'],
        uid: 'contract-alice',
        cn: 'Alice',
        sn: 'Contract',
        description: 'A person',
        businessCategory: 'valid',
        l: 'paris',
      }),
      modifyUrl: () => '/api/v1/ldap/contractPeople/contract-alice',
    },
    {
      name: 'groups',
      classes: () => server.config.group_class as string[],
      route: '/api/v1/ldap/groups',
      dn: () => `cn=contract-group,${process.env.DM_LDAP_GROUP_BASE || base}`,
      create: attributes => ({
        cn: 'contract-group',
        member: [pointee],
        description: 'A group',
        businessCategory: 'valid',
        ...attributes,
      }),
      stored: () => ({
        objectClass: server.config.group_class as string[],
        cn: 'contract-group',
        member: [pointee],
        description: 'A group',
        businessCategory: 'valid',
        l: 'paris',
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
        businessCategory: 'valid',
        ...attributes,
      }),
      stored: () => ({
        objectClass: server.config.ldap_organization_class as string[],
        ou: 'ContractOrg',
        description: 'An organization',
        businessCategory: 'valid',
        l: 'paris',
      }),
      modifyUrl: () =>
        `/api/v1/ldap/organizations/${encodeURIComponent(
          `ou=ContractOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`
        )}`,
    },
  ];

  /**
   * Values refused on a creation, in a `replace` and in an `add`. The
   * directory would take `telephoneNumber` (extensibleObject), `'abc'` in
   * `employeeNumber` and a string in `secretary`: only the schema refuses them.
   */
  const refusedValues: Array<{ title: string; attributes: () => Body }> = [
    {
      title: 'an attribute the schema does not declare',
      attributes: () => ({ telephoneNumber: '+33 1 00 00 00 00' }),
    },
    {
      title: 'an attribute the schema does not declare, in another case',
      attributes: () => ({ TELEPHONENUMBER: '+33 1 00 00 00 00' }),
    },
    {
      title: 'a value failing the pattern',
      attributes: () => ({ businessCategory: 'Not Valid' }),
    },
    {
      title: 'a value failing the pattern, under the name in another case',
      attributes: () => ({ BUSINESSCATEGORY: 'Not Valid' }),
    },
    { title: 'an empty string', attributes: () => ({ businessCategory: '' }) },
    {
      title: 'an array for a string',
      attributes: () => ({ description: ['a', 'b'] }),
    },
    { title: 'a number for a string', attributes: () => ({ description: 42 }) },
    {
      title: 'a string that is not a number for a number',
      attributes: () => ({ employeeNumber: 'abc' }),
    },
    { title: 'an empty pointer', attributes: () => ({ seeAlso: '' }) },
    {
      title: 'a pointer outside its branch',
      attributes: () => ({ seeAlso: process.env.DM_LDAP_TOP_ORGANIZATION }),
    },
    {
      title: 'a pointer to a missing entry',
      attributes: () => ({ seeAlso: `uid=contract-nobody,ou=users,${base}` }),
    },
    {
      title: 'a string for an array of pointers',
      attributes: () => ({ secretary: pointee }),
    },
    {
      title: 'a missing entry in an array of pointers',
      attributes: () => ({
        secretary: [pointee, `uid=contract-nobody,ou=users,${base}`],
      }),
    },
    {
      title: 'a fixed attribute',
      attributes: () => ({ l: 'lyon' }),
    },
  ];

  /** Deletions refused: the schema knows what is required, fixed or absent */
  const refusedDeletes: Array<{ title: string; attributes: string[] }> = [
    { title: 'a required attribute', attributes: ['description'] },
    { title: 'a fixed attribute', attributes: ['l'] },
    {
      title: 'an attribute the schema does not declare',
      attributes: ['telephoneNumber'],
    },
  ];

  const refusedBySchema = (res: supertest.Response): void => {
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(
      res.body.error,
      'refused by the directory, not the schema'
    ).not.to.match(/directory refused/);
  };

  const created = (res: supertest.Response): void => {
    expect([200, 201], JSON.stringify(res.body)).to.include(res.status);
  };

  const stored = async (
    dn: string,
    attribute: string
  ): Promise<unknown | undefined> => {
    try {
      const result = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [attribute] },
        dn
      )) as SearchResult;
      const value = result.searchEntries[0]?.[attribute];
      // An attribute asked for but absent comes back as []
      return Array.isArray(value) && value.length === 0 ? undefined : value;
    } catch (err) {
      if (/NoSuchObject/.test(String(err))) return undefined;
      throw err;
    }
  };

  for (const entity of entities) {
    const define = (
      phase: Phase,
      title: string,
      fn: () => Promise<void>
    ): void => {
      const reason = divergences[`${entity.name}: ${phase}: ${title}`];
      if (reason) it.skip(`${title} (${reason})`, fn);
      else it(title, fn);
    };

    describe(entity.name, () => {
      afterEach(async () => {
        await server.ldap.delete(entity.dn()).catch(() => undefined);
      });

      describe('on a creation', () => {
        define('creation', 'accepts a valid body', async () => {
          created(await request.post(entity.route).send(entity.create({})));
          expect(await stored(entity.dn(), 'objectClass')).to.have.members(
            entity.classes()
          );
        });

        define('creation', 'keeps its own classes', async () => {
          created(
            await request
              .post(entity.route)
              .send(entity.create({ objectClass: ['top', 'extensibleObject'] }))
          );
          expect(await stored(entity.dn(), 'objectClass')).to.have.members(
            entity.classes()
          );
        });

        define(
          'creation',
          'writes a fixed attribute as the schema says',
          async () => {
            created(
              await request
                .post(entity.route)
                .send(entity.create({ l: 'lyon' }))
            );
            expect(await stored(entity.dn(), 'l')).to.equal('paris');
          }
        );

        for (const [title, value] of [
          ['refuses a missing required attribute', undefined],
          ['refuses an empty required attribute', ''],
          ['refuses an empty array for a required attribute', []],
        ] as Array<[string, unknown]>) {
          define('creation', title, async () => {
            const body = entity.create({});
            if (value === undefined) delete body.description;
            else body.description = value;
            const res = await request.post(entity.route).send(body);
            refusedBySchema(res);
            expect(res.body.error).to.match(/description.*required/);
          });
        }

        for (const { title, attributes } of refusedValues) {
          if (title === 'a fixed attribute') continue;
          define('creation', `refuses ${title}`, async () => {
            const res = await request
              .post(entity.route)
              .send(entity.create(attributes()));
            refusedBySchema(res);
            expect(await stored(entity.dn(), 'objectClass')).to.be.undefined;
          });
        }
      });

      describe('on a change', () => {
        beforeEach(async () => {
          await server.ldap.add(entity.dn(), entity.stored());
        });

        define('replace', 'accepts a valid replace', async () => {
          const res = await request.put(entity.modifyUrl()).send({
            replace: {
              description: 'Changed',
              businessCategory: 'changed',
              seeAlso: pointee,
              secretary: [pointee],
              employeeNumber: 42,
            },
          });
          expect(res.status, JSON.stringify(res.body)).to.equal(200);
          expect(await stored(entity.dn(), 'description')).to.equal('Changed');
        });

        define(
          'replace',
          'clears an optional attribute with an empty array',
          async () => {
            const res = await request
              .put(entity.modifyUrl())
              .send({ replace: { businessCategory: [] } });
            expect(res.status, JSON.stringify(res.body)).to.equal(200);
            expect(await stored(entity.dn(), 'businessCategory')).to.be
              .undefined;
          }
        );

        for (const [title, value] of [
          ['refuses an empty array for a required attribute', []],
          ['refuses null for a required attribute', null],
        ] as Array<[string, unknown]>) {
          define('replace', title, async () => {
            const res = await request
              .put(entity.modifyUrl())
              .send({ replace: { description: value } });
            refusedBySchema(res);
            expect(await stored(entity.dn(), 'description')).to.equal(
              entity.stored().description
            );
          });
        }

        define('replace', 'refuses a replace of the classes', async () => {
          // labeledURIObject: an auxiliary class the directory would accept
          const res = await request.put(entity.modifyUrl()).send({
            replace: { objectClass: [...entity.classes(), 'labeledURIObject'] },
          });
          refusedBySchema(res);
          expect(await stored(entity.dn(), 'objectClass')).to.have.members(
            entity.classes()
          );
        });

        for (const phase of ['replace', 'add'] as Phase[]) {
          for (const { title, attributes } of refusedValues) {
            define(phase, `refuses ${title}`, async () => {
              const res = await request
                .put(entity.modifyUrl())
                .send({ [phase]: attributes() });
              refusedBySchema(res);
              for (const [name, value] of Object.entries(entity.stored()))
                if (name in attributes() || name === 'l')
                  expect(await stored(entity.dn(), name), name).to.deep.equal(
                    value
                  );
            });
          }
        }

        for (const { title, attributes } of refusedDeletes) {
          define('delete', `refuses deleting ${title}`, async () => {
            const res = await request
              .put(entity.modifyUrl())
              .send({ delete: attributes });
            refusedBySchema(res);
            for (const name of attributes)
              expect(await stored(entity.dn(), name), name).to.deep.equal(
                entity.stored()[name]
              );
          });
        }
      });
    });
  }
});
