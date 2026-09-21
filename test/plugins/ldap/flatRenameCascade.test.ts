/**
 * Renaming an entry moves its DN, and every entry naming that DN has to be
 * told. The cascade is driven by the schemas alone — no attribute name
 * appears in the code — and it is awaited, so the directory is consistent by
 * the time the call returns.
 *
 * What is followed: every `pointer` (single, or under `items`) whose `branch`
 * admits the renamed entry, and every attribute carrying the `members` or
 * `owners` role. A group's member list has to be found by its role: it
 * cannot be a pointer, because a pointer's target must exist and a group
 * legitimately holds the DN of an external member that has none.
 *
 * The security case is the local administrator: `authzLinid1` grants
 * permissions by searching organizations for the caller's DN. A renamed
 * administrator whose `twakeLocalAdminLink` was left behind loses every
 * branch, silently and permanently.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import ExternalUsersInGroups from '../../../src/plugins/ldap/externalUsersInGroups';
import DepartmentSync from '../../../src/plugins/ldap/departmentSync';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import type {
  AttributesList,
  SearchOptions,
  SearchResult,
} from '../../../src/lib/ldapActions';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Flat entity rename, reference cascade', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let userBranch: string;
  let groupBranch: string;
  let deviceBranch: string;
  let orgDn: string;
  let aliceDn: string;
  let newAliceDn: string;
  let otherDn: string;
  let previousOrganizationSchema: string | undefined;
  let previousGroupSchema: string | undefined;

  const ALICE = 'csc.alice';
  const RENAMED = 'csc.alice.renamed';
  const OTHER = 'csc.other';
  const LONELY = 'csc.lonely';
  const GROUP1 = 'csc.group1';
  const GROUP2 = 'csc.group2';
  const DEVICE = 'csc.device';
  /** An external member the directory does not hold: creating it is the bug */
  let ghostDn: string;
  /** The placeholder a `groupOfNames` keeps so it can have no real member */
  let dummyDn: string;

  const read = async (dn: string): Promise<AttributesList | null> => {
    try {
      const res = (await server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      return (res.searchEntries[0] as AttributesList) || null;
    } catch {
      return null;
    }
  };

  const values = async (dn: string, attribute: string): Promise<string[]> => {
    const entry = await read(dn);
    const value = entry?.[attribute];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(v => String(v));
  };

  const user = (uid: string, employeeNumber: string): AttributesList => ({
    objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
    uid,
    cn: uid,
    sn: 'Cascade',
    givenName: 'Test',
    displayName: `Test ${uid}`,
    mail: `${uid}@example.com`,
    employeeNumber,
    twakeDepartmentLink: orgDn,
    twakeDepartmentPath: 'CascadeOrg',
    twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    twakeDeliveryMode: [
      `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
    ],
  });

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async function () {
    this.timeout(30000);
    base = process.env.DM_LDAP_BASE as string;
    top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    userBranch = `ou=users,${base}`;
    groupBranch = process.env.DM_LDAP_GROUP_BASE as string;
    deviceBranch = `ou=devices,${base}`;
    orgDn = `ou=CascadeOrg,${top}`;
    aliceDn = `uid=${ALICE},${userBranch}`;
    newAliceDn = `uid=${RENAMED},${userBranch}`;
    otherDn = `uid=${OTHER},${userBranch}`;
    ghostDn = `mail=ghost@outside.example,ou=external,${base}`;
    dummyDn = `uid=fakeuser,${userBranch}`;

    // Both plugins take their schema from the environment, and the suite
    // shares one process with files that blank it at load time. Without a
    // schema a binding is never searched, so the cascade would quietly cover
    // less than it is being tested for.
    previousOrganizationSchema = process.env.DM_ORGANIZATION_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/users.json',
      './static/schemas/twake/devices.json',
    ];
    server.config.group_dummy_user = dummyDn;

    await server.ldap
      .add(deviceBranch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'devices',
      })
      .catch(() => undefined);

    const groups = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groups);
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'externalUsersInGroups',
      new ExternalUsersInGroups(server)
    );
    // Loaded, and expected to stay out of the way: it acts on organization
    // renames, which an entry of a flat branch is not.
    await server.registerPlugin('departmentSync', new DepartmentSync(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);

    // The group and organization plugins read their schemas asynchronously,
    // and a binding without a schema is a binding that is never searched.
    // Asserted rather than waited for: a cascade that covers three entities
    // instead of four still answers 200, and the test would pass proving
    // less than it says.
    const organizations = server.loadedPlugins['ldapOrganizations'] as {
      schema?: unknown;
    };
    for (let i = 0; i < 50 && !(groups.schema && organizations.schema); i++)
      await new Promise(r => setTimeout(r, 100));
    expect(groups.schema, 'the group schema is loaded').to.not.equal(undefined);
    expect(
      organizations.schema,
      'the organization schema is loaded'
    ).to.not.equal(undefined);
  });

  after(async () => {
    for (const dn of [
      `cn=${GROUP1},${groupBranch}`,
      `cn=${GROUP2},${groupBranch}`,
      `cn=${DEVICE},${deviceBranch}`,
      aliceDn,
      newAliceDn,
      otherDn,
      `uid=${LONELY},${userBranch}`,
      orgDn,
      deviceBranch,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousOrganizationSchema === undefined)
      delete process.env.DM_ORGANIZATION_SCHEMA;
    else process.env.DM_ORGANIZATION_SCHEMA = previousOrganizationSchema;
    if (previousGroupSchema === undefined) delete process.env.DM_GROUP_SCHEMA;
    else process.env.DM_GROUP_SCHEMA = previousGroupSchema;
  });

  beforeEach(async function () {
    this.timeout(20000);
    for (const dn of [
      `cn=${GROUP1},${groupBranch}`,
      `cn=${GROUP2},${groupBranch}`,
      `cn=${DEVICE},${deviceBranch}`,
      aliceDn,
      newAliceDn,
      otherDn,
      `uid=${LONELY},${userBranch}`,
      ghostDn,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);

    await server.ldap.add(orgDn, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'CascadeOrg',
      twakeDepartmentPath: 'CascadeOrg',
    });
    await server.ldap.add(aliceDn, user(ALICE, 'CSC0001'));
    await server.ldap.add(otherDn, {
      ...user(OTHER, 'CSC0002'),
      twakeDelegatedUsers: [aliceDn],
    });
    await server.ldap.add(
      `uid=${LONELY},${userBranch}`,
      user(LONELY, 'CSC0003')
    );

    // The organization names her twice over: as a manager, and as the local
    // administrator `authzLinid1` reads to grant her the branch.
    await server.ldap.modify(orgDn, {
      replace: {
        twakeManagerLink: [aliceDn],
        twakeLocalAdminLink: [aliceDn],
      },
    });

    for (const [cn, extra] of [
      [GROUP1, { owner: [aliceDn] }],
      [GROUP2, {}],
    ] as [string, AttributesList][]) {
      await server.ldap.add(`cn=${cn},${groupBranch}`, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn,
        // A real member, another one, an external member with no entry, and
        // the placeholder: only the first must move.
        member: [aliceDn, otherDn, ghostDn, dummyDn],
        twakeDepartmentLink: orgDn,
        twakeDepartmentPath: 'CascadeOrg',
        ...extra,
      });
    }

    await server.ldap.add(`cn=${DEVICE},${deviceBranch}`, {
      objectClass: ['top', 'device'],
      cn: DEVICE,
      // A single pointer, carrying no referentialIntegrity: "may dangle on
      // delete" is not "may be wrong after a rename".
      owner: aliceDn,
    });
  });

  const rename = (id: string, newId: string): supertest.Test =>
    request
      .post(`/api/v1/ldap/users/${encodeURIComponent(id)}/rename`)
      .type('json')
      .send({ newId });

  it('should rewrite every reference the schemas declare', async function () {
    this.timeout(20000);
    const res = await rename(ALICE, RENAMED);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    // Two memberships, one ownership, one delegation, two organization
    // links, one device owner.
    expect(res.body).to.deep.equal({
      success: true,
      dn: newAliceDn,
      referencesUpdated: 7,
    });

    for (const cn of [GROUP1, GROUP2]) {
      const members = await values(`cn=${cn},${groupBranch}`, 'member');
      expect(members, cn).to.have.members([
        newAliceDn,
        otherDn,
        ghostDn,
        dummyDn,
      ]);
    }
    expect(await values(`cn=${GROUP1},${groupBranch}`, 'owner')).to.deep.equal([
      newAliceDn,
    ]);
    expect(await values(otherDn, 'twakeDelegatedUsers')).to.deep.equal([
      newAliceDn,
    ]);
    expect(await values(orgDn, 'twakeManagerLink')).to.deep.equal([newAliceDn]);
    expect(await values(orgDn, 'twakeLocalAdminLink')).to.deep.equal([
      newAliceDn,
    ]);
    expect(await values(`cn=${DEVICE},${deviceBranch}`, 'owner')).to.deep.equal(
      [newAliceDn]
    );
  });

  it('should not create the external member it walked past', async () => {
    // `LdapGroups.addMember` fires `ldapgroupvalidatemembers`, which
    // `externalUsersInGroups` answers by creating the missing entry.
    // Respelling a DN that is already there is not adding a member.
    await rename(ALICE, RENAMED);
    expect(await read(ghostDn)).to.equal(null);
  });

  it('should leave the renamed administrator her branches', async () => {
    await rename(ALICE, RENAMED);
    const authz = new AuthzLinid1(server);
    await authz.refreshUserPermissions(newAliceDn);
    expect(await authz.getAuthorizedBranches(newAliceDn)).to.include(orgDn);
    expect((await authz.getUserPermissions(newAliceDn, orgDn)).write).to.equal(
      true
    );
  });

  it('should only search the attributes that could name a user', async () => {
    // `title` points into `ou=positions` and `personalTitle` into a
    // nomenclature branch: neither can hold the DN of a user, so neither is
    // searched. The narrowing is what keeps a rename to a handful of queries.
    const original = server.ldap.search.bind(server.ldap);
    const filters: string[] = [];
    server.ldap.search = (
      options: SearchOptions,
      searchBase?: string,
      req?: Parameters<typeof original>[2]
    ) => {
      if (typeof options.filter === 'string') filters.push(options.filter);
      return original(options, searchBase, req);
    };
    try {
      await rename(ALICE, RENAMED);
    } finally {
      server.ldap.search = original;
    }
    const asked = filters.filter(f => f.includes(ALICE));
    expect(asked.some(f => f.startsWith('(member='))).to.equal(true);
    expect(asked.some(f => f.startsWith('(title='))).to.equal(false);
    expect(asked.some(f => f.startsWith('(personalTitle='))).to.equal(false);
  });

  it('should report no reference when nothing points at the entry', async () => {
    const res = await rename(LONELY, `${LONELY}.renamed`);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.referencesUpdated).to.equal(0);
    await server.ldap
      .delete(`uid=${LONELY}.renamed,${userBranch}`)
      .catch(() => undefined);
  });

  it('should leave every department path exactly where it was', async () => {
    // `departmentSync` reacts to `ldaprenamedone`, and an entry of a flat
    // branch is not an organization. Loaded, it must do nothing at all.
    const watched = [
      orgDn,
      otherDn,
      `cn=${GROUP1},${groupBranch}`,
      `cn=${GROUP2},${groupBranch}`,
    ];
    const before = new Map<string, string[]>();
    for (const dn of watched)
      before.set(dn, await values(dn, 'twakeDepartmentPath'));

    await rename(ALICE, RENAMED);
    // The hook is fired without being awaited, so leave it time to be wrong.
    await new Promise(r => setTimeout(r, 500));

    for (const dn of watched)
      expect(await values(dn, 'twakeDepartmentPath'), dn).to.deep.equal(
        before.get(dn)
      );
    expect(await values(newAliceDn, 'twakeDepartmentPath')).to.deep.equal([
      'CascadeOrg',
    ]);
  });
});
