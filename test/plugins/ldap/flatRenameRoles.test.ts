/**
 * The cascade follows the `role` a schema declares, not the attribute name
 * the shipped schemas happen to use. Nothing in the implementation may say
 * `member`.
 *
 * The schema loaded here is the shipped group schema with its member list
 * moved to another attribute, its `role: "members"` kept. Two things about
 * the attribute chosen matter:
 *
 *   * it is not `uniqueMember`, which would have proved nothing: OpenLDAP's
 *     `refint` overlay rewrites `member`, `uniqueMember`, `owner`, `manager`
 *     and `memberOf` by itself on a `modifyDN`, so the test would pass with
 *     the role lookup deleted;
 *   * it holds a DN and is not a `pointer` — like a member list, which
 *     cannot be one, since a pointer's target must exist and a group
 *     legitimately holds external members that have no entry.
 *
 * So the only thing that can move this value is the role.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import type { Schema, SchemaAttribute } from '../../../src/config/schema';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/** The attribute the copied schema puts the member list in */
const ROLE_ATTRIBUTE = 'seeAlso';

describe('Flat entity rename, roles rather than names', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let listBranch: string;
  let schemaFile: string;
  let orgDn: string;
  let aliceDn: string;
  const ALICE = 'role.alice';
  const RENAMED = 'role.alice.renamed';
  const LIST = 'role.list';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    listBranch = `ou=rolelists,${base}`;
    orgDn = `ou=RoleOrg,${base}`;
    aliceDn = `uid=${ALICE},${userBranch}`;

    // Copied from the shipped schema, so the member list keeps the exact
    // definition it has there — its role among the rest.
    const shipped = JSON.parse(
      fs.readFileSync('./static/schemas/twake/groups.json', 'utf8')
    ) as Schema & { entity: Record<string, unknown> };
    const members = shipped.attributes.member;
    expect(members.role, 'the shipped schema still marks the members').to.equal(
      'members'
    );
    const copy = {
      entity: {
        name: 'roleList',
        mainAttribute: 'cn',
        objectClass: ['top', 'device'],
        singularName: 'rolelist',
        pluralName: 'rolelists',
        base: listBranch,
      },
      strict: true,
      attributes: {
        objectClass: shipped.attributes.objectClass,
        cn: shipped.attributes.cn,
        description: shipped.attributes.description,
        [ROLE_ATTRIBUTE]: members as SchemaAttribute,
      },
    };
    copy.attributes.objectClass = {
      ...copy.attributes.objectClass,
      default: ['top', 'device'],
    };
    schemaFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ldap-rest-rename-')),
      'rolelists.json'
    );
    fs.writeFileSync(schemaFile, JSON.stringify(copy, null, 2));

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/users.json',
      schemaFile,
    ];

    for (const [dn, entry] of [
      [
        listBranch,
        { objectClass: ['top', 'organizationalUnit'], ou: 'rolelists' },
      ],
      [
        orgDn,
        {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'RoleOrg',
          twakeDepartmentPath: 'RoleOrg',
        },
      ],
    ] as [string, AttributesList][])
      await server.ldap.add(dn, entry).catch(() => undefined);

    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      `cn=${LIST},${listBranch}`,
      aliceDn,
      `uid=${RENAMED},${userBranch}`,
      listBranch,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    fs.rmSync(path.dirname(schemaFile), { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const dn of [
      `cn=${LIST},${listBranch}`,
      aliceDn,
      `uid=${RENAMED},${userBranch}`,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    await server.ldap.add(aliceDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: ALICE,
      cn: ALICE,
      sn: 'Role',
      givenName: 'Test',
      displayName: 'Test Role',
      mail: `${ALICE}@example.com`,
      employeeNumber: 'ROL0001',
      twakeDepartmentLink: orgDn,
      twakeDepartmentPath: 'RoleOrg',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
    await server.ldap.add(`cn=${LIST},${listBranch}`, {
      objectClass: ['top', 'device'],
      cn: LIST,
      [ROLE_ATTRIBUTE]: [aliceDn],
    });
  });

  it('should follow the role to an attribute nothing else knows about', async () => {
    const res = await request
      .post(`/api/v1/ldap/users/${ALICE}/rename`)
      .type('json')
      .send({ newId: RENAMED });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.referencesUpdated).to.equal(1);

    const found = (await server.ldap.search(
      { paged: false, scope: 'base' },
      `cn=${LIST},${listBranch}`
    )) as SearchResult;
    const stored = found.searchEntries[0][ROLE_ATTRIBUTE];
    expect(
      (Array.isArray(stored) ? stored : [stored]).map(String)
    ).to.deep.equal([`uid=${RENAMED},${userBranch}`]);
  });
});
