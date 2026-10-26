/**
 * One schema, one answer: the same attribute rules, written in a schema of
 * each kind, are enforced alike by the flat routes, the group routes and the
 * organization routes. The three fixtures declare the same attributes under
 * test; every case below is sent to the three entities, and a refusal has to
 * come from the schema, before the write, not from the directory.
 *
 * `divergences` lists what one kind still answers otherwise, by entity, phase
 * and case, with the status it answers today: such a case asserts that
 * answer instead of the contract, so that a fix shows and removes the entry.
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
type Response = supertest.Response;

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

/** What one kind still answers otherwise: `<entity>: <phase>: <case>` */
const divergences: Record<string, [status: number, reason: string]> = {
  'groups: creation: refuses null for an optional attribute': [500, 'crashes'],
  'organizations: creation: refuses null for an optional attribute': [
    500,
    'crashes',
  ],
  'organizations: delete: refuses deleting a required attribute, named with no value':
    [200, 'deletes it'],
  'organizations: delete: refuses deleting a required attribute, named with null':
    [200, 'deletes it'],
  'groups: creation: accepts a list of one for a single value and one value for a list':
    [400, 'refuses the list of one'],
  'groups: replace: accepts a list of one for a single value and one value for a list':
    [400, 'refuses the list of one'],
  'organizations: creation: accepts a list of one for a single value and one value for a list':
    [400, 'refuses the list of one'],
  'organizations: replace: accepts a list of one for a single value and one value for a list':
    [400, 'refuses the list of one'],
  'groups: creation: writes a fixed attribute as the schema says': [
    200,
    'writes nothing',
  ],
  'groups: replace: refuses a replace of the classes': [
    200,
    'drops it, answers 200',
  ],
  'groups: replace: refuses a fixed attribute': [200, 'drops it, answers 200'],
  'groups: add: refuses a fixed attribute': [200, 'drops it, answers 200'],
  'groups: delete: refuses deleting a fixed attribute': [
    200,
    'drops it, answers 200',
  ],
  'groups: replace: clears an optional attribute with null': [500, 'crashes'],
  'organizations: creation: refuses a string that is not a number for a number':
    [200, 'stores it'],
  'organizations: replace: refuses a string that is not a number for a number':
    [200, 'stores it'],
  'organizations: add: refuses a string that is not a number for a number': [
    200,
    'stores it',
  ],
  'organizations: replace: clears an optional attribute with null': [
    500,
    'crashes',
  ],
  'organizations: delete: refuses deleting a required attribute': [
    200,
    'deletes it',
  ],
  'organizations: delete: refuses deleting an attribute the schema does not declare':
    [200, 'deletes it'],
};

describe('Entity schema contract', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let pointee: string;
  // Read once the embedded directory has set the environment, not when the
  // file loads: restoring an earlier reading would drop the suite's schemas
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    previous.group = process.env.DM_GROUP_SCHEMA;
    previous.organization = process.env.DM_ORGANIZATION_SCHEMA;
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
    for (const dn of [pointee, ...entities.map(entity => entity.dn())])
      await server.ldap.delete(dn).catch(() => undefined);
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

  const held = (): AttributesList => ({
    description: 'Held',
    businessCategory: 'valid',
    l: 'paris',
    telephoneNumber: '+33 9 99 99 99 99',
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
        ...held(),
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
        ...held(),
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
        ...held(),
      }),
      modifyUrl: () =>
        `/api/v1/ldap/organizations/${encodeURIComponent(
          `ou=ContractOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`
        )}`,
    },
  ];

  /**
   * Values refused on a creation, in a `replace` and in an `add`. The
   * directory would take every one of them (`telephoneNumber` through
   * extensibleObject, an empty IA5 string in `mail`, `'abc'` in
   * `employeeNumber`, a string in `secretary`): only the schema refuses them.
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
      title: 'a read-only attribute',
      attributes: () => ({ employeeType: 'contractor' }),
    },
    {
      title: 'a value failing the pattern',
      attributes: () => ({ businessCategory: 'Not Valid' }),
    },
    {
      title: 'a value failing the pattern, under the name in another case',
      attributes: () => ({ BUSINESSCATEGORY: 'Not Valid' }),
    },
    { title: 'an empty string', attributes: () => ({ mail: '' }) },
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
      title: 'a missing entry in an array of pointers',
      attributes: () => ({
        secretary: [pointee, `uid=contract-nobody,ou=users,${base}`],
      }),
    },
    { title: 'a fixed attribute', attributes: () => ({ l: 'lyon' }) },
  ];

  /** Deletions refused: the schema knows what is required, fixed or undeclared */
  const refusedDeletes: Array<{
    title: string;
    body: unknown;
    attributes: string[];
  }> = [
    {
      title: 'a required attribute',
      body: ['description'],
      attributes: ['description'],
    },
    {
      title: 'a required attribute, named with no value',
      body: { description: [] },
      attributes: ['description'],
    },
    {
      title: 'a required attribute, named with null',
      body: { description: null },
      attributes: ['description'],
    },
    { title: 'a fixed attribute', body: ['l'], attributes: ['l'] },
    {
      title: 'an attribute the schema does not declare',
      body: ['telephoneNumber'],
      attributes: ['telephoneNumber'],
    },
  ];

  /** The valid values written under a name in another case */
  const otherCase: Body = { BUSINESSCATEGORY: 'changed', PWDRESET: true };

  const lower = (name: string): string => name.toLowerCase();
  const sameName = (a: string, b: string): boolean => lower(a) === lower(b);
  /** `create()` without the attributes `attributes` names in another case */
  const createWith = (entity: Entity, attributes: Body): Body => {
    const body = entity.create({});
    for (const name of Object.keys(body))
      if (Object.keys(attributes).some(other => sameName(name, other)))
        delete body[name];
    return { ...body, ...attributes };
  };

  const refusedBySchema = (res: Response): void => {
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(
      res.body.error,
      'refused by the directory, not the schema'
    ).not.to.match(/directory refused/);
    expect(res.body.error, 'refused as unknown, not as invalid').not.to.match(
      /name the same attribute/
    );
  };

  const created = (res: Response): void => {
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
    /**
     * A case under contract runs `check` on the answer; a divergent one
     * asserts the status it answers today, and fails once that changes
     */
    const define = (
      phase: Phase,
      title: string,
      send: () => Promise<Response>,
      check: (res: Response) => Promise<void>
    ): void => {
      const divergence = divergences[`${entity.name}: ${phase}: ${title}`];
      if (!divergence) it(title, async () => check(await send()));
      else {
        const [status, reason] = divergence;
        it(`${title}: still ${reason}`, async () => {
          const res = await send();
          expect(
            res.status,
            `no longer ${status}, remove the divergence: ${JSON.stringify(res.body)}`
          ).to.equal(status);
        });
      }
    };

    describe(entity.name, () => {
      afterEach(async () => {
        await server.ldap.delete(entity.dn()).catch(() => undefined);
      });

      describe('on a creation', () => {
        define(
          'creation',
          'accepts a valid body',
          () => request.post(entity.route).send(entity.create({})),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'objectClass')).to.have.members(
              entity.classes()
            );
          }
        );

        define(
          'creation',
          'accepts a boolean',
          () =>
            request.post(entity.route).send(entity.create({ pwdReset: true })),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'pwdReset')).to.equal('TRUE');
          }
        );

        define(
          'creation',
          'accepts valid values under names in another case',
          () => request.post(entity.route).send(createWith(entity, otherCase)),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'businessCategory')).to.equal(
              'changed'
            );
            expect(await stored(entity.dn(), 'pwdReset')).to.equal('TRUE');
          }
        );

        define(
          'creation',
          'accepts a list of one for a single value and one value for a list',
          () =>
            request.post(entity.route).send(
              entity.create({
                description: ['A person'],
                seeAlso: [pointee],
                secretary: pointee,
              })
            ),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'description')).to.equal(
              'A person'
            );
            expect(await stored(entity.dn(), 'seeAlso')).to.equal(pointee);
            // One value comes back bare
            expect(await stored(entity.dn(), 'secretary')).to.equal(pointee);
          }
        );

        define(
          'creation',
          'keeps its own classes',
          () =>
            request
              .post(entity.route)
              .send(
                entity.create({ objectClass: ['top', 'extensibleObject'] })
              ),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'objectClass')).to.have.members(
              entity.classes()
            );
          }
        );

        define(
          'creation',
          'writes a fixed attribute as the schema says',
          () => request.post(entity.route).send(entity.create({ l: 'lyon' })),
          async res => {
            created(res);
            expect(await stored(entity.dn(), 'l')).to.equal('paris');
          }
        );

        for (const [title, value] of [
          ['refuses a missing required attribute', undefined],
          ['refuses an empty required attribute', ''],
          ['refuses an empty array for a required attribute', []],
        ] as Array<[string, unknown]>) {
          define(
            'creation',
            title,
            () => {
              const body = entity.create({});
              if (value === undefined) delete body.description;
              else body.description = value;
              return request.post(entity.route).send(body);
            },
            async res => {
              refusedBySchema(res);
              expect(res.body.error).to.match(/description.*required/);
            }
          );
        }

        for (const [title, value] of [
          ['refuses no value for an optional attribute', []],
          ['refuses null for an optional attribute', null],
        ] as Array<[string, unknown]>) {
          define(
            'creation',
            title,
            () =>
              request
                .post(entity.route)
                .send(entity.create({ businessCategory: value })),
            async res => {
              refusedBySchema(res);
              expect(await stored(entity.dn(), 'objectClass')).to.be.undefined;
            }
          );
        }

        for (const { title, attributes } of refusedValues) {
          if (title === 'a fixed attribute') continue;
          define(
            'creation',
            `refuses ${title}`,
            () =>
              request.post(entity.route).send(createWith(entity, attributes())),
            async res => {
              refusedBySchema(res);
              expect(await stored(entity.dn(), 'objectClass')).to.be.undefined;
            }
          );
        }
      });

      describe('on a change', () => {
        beforeEach(async () => {
          await server.ldap.add(entity.dn(), entity.stored());
        });

        const unchanged = async (names: string[]): Promise<void> => {
          for (const [name, value] of Object.entries(entity.stored()))
            if (names.some(other => sameName(name, other)) || name === 'l')
              expect(await stored(entity.dn(), name), name).to.deep.equal(
                value
              );
        };

        define(
          'replace',
          'accepts a valid replace',
          () =>
            request.put(entity.modifyUrl()).send({
              replace: {
                description: 'Changed',
                businessCategory: 'changed',
                seeAlso: pointee,
                secretary: [pointee],
                employeeNumber: 42,
                pwdReset: true,
              },
            }),
          async res => {
            expect(res.status, JSON.stringify(res.body)).to.equal(200);
            expect(await stored(entity.dn(), 'description')).to.equal(
              'Changed'
            );
            expect(await stored(entity.dn(), 'pwdReset')).to.equal('TRUE');
          }
        );

        define(
          'replace',
          'accepts a list of one for a single value and one value for a list',
          () =>
            request.put(entity.modifyUrl()).send({
              replace: {
                description: ['Changed'],
                seeAlso: [pointee],
                secretary: pointee,
              },
            }),
          async res => {
            expect(res.status, JSON.stringify(res.body)).to.equal(200);
            expect(await stored(entity.dn(), 'description')).to.equal(
              'Changed'
            );
            // One value comes back bare
            expect(await stored(entity.dn(), 'secretary')).to.equal(pointee);
          }
        );

        define(
          'replace',
          'accepts valid values under names in another case',
          () => request.put(entity.modifyUrl()).send({ replace: otherCase }),
          async res => {
            expect(res.status, JSON.stringify(res.body)).to.equal(200);
            expect(await stored(entity.dn(), 'businessCategory')).to.equal(
              'changed'
            );
            expect(await stored(entity.dn(), 'pwdReset')).to.equal('TRUE');
          }
        );

        for (const [title, value] of [
          ['clears an optional attribute with an empty array', []],
          ['clears an optional attribute with null', null],
        ] as Array<[string, unknown]>) {
          define(
            'replace',
            title,
            () =>
              request
                .put(entity.modifyUrl())
                .send({ replace: { businessCategory: value } }),
            async res => {
              expect(res.status, JSON.stringify(res.body)).to.equal(200);
              expect(await stored(entity.dn(), 'businessCategory')).to.be
                .undefined;
            }
          );
        }

        for (const [title, value] of [
          ['refuses an empty array for a required attribute', []],
          ['refuses null for a required attribute', null],
        ] as Array<[string, unknown]>) {
          define(
            'replace',
            title,
            () =>
              request
                .put(entity.modifyUrl())
                .send({ replace: { description: value } }),
            async res => {
              refusedBySchema(res);
              await unchanged(['description']);
            }
          );
        }

        define(
          'replace',
          'refuses a replace of the classes',
          () =>
            // labeledURIObject: an auxiliary class the directory would accept
            request.put(entity.modifyUrl()).send({
              replace: {
                objectClass: [...entity.classes(), 'labeledURIObject'],
              },
            }),
          async res => {
            refusedBySchema(res);
            expect(await stored(entity.dn(), 'objectClass')).to.have.members(
              entity.classes()
            );
          }
        );

        for (const phase of ['replace', 'add'] as Phase[]) {
          for (const { title, attributes } of refusedValues) {
            define(
              phase,
              `refuses ${title}`,
              () =>
                request.put(entity.modifyUrl()).send({ [phase]: attributes() }),
              async res => {
                refusedBySchema(res);
                await unchanged(Object.keys(attributes()));
              }
            );
          }
        }

        for (const { title, body, attributes } of refusedDeletes) {
          define(
            'delete',
            `refuses deleting ${title}`,
            () => request.put(entity.modifyUrl()).send({ delete: body }),
            async res => {
              refusedBySchema(res);
              await unchanged(attributes);
            }
          );
        }
      });
    });
  }
});
