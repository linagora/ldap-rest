import { expect } from 'chai';
import LdapDepartmentSync from '../../../src/plugins/ldap/departmentSync';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';
import type { SearchResult } from 'ldapts';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('LDAP Department Sync Plugin', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let plugin: LdapDepartmentSync;
  let DM_LDAP_TOP_ORGANIZATION: string;
  let DM_LDAP_BASE: string;
  let DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE: string | undefined;
  let DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE: string | undefined;
  let testOrgDn: string;
  let testSubOrg1Dn: string;
  let testSubOrg2Dn: string;
  let movedOrgDn: string;
  let testUserDn: string;
  let testUser2Dn: string;
  let testGroupDn: string;

  before(async () => {
    DM_LDAP_TOP_ORGANIZATION = process.env.DM_LDAP_TOP_ORGANIZATION!;
    DM_LDAP_BASE = process.env.DM_LDAP_BASE!;
    DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE =
      process.env.DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE;
    DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE =
      process.env.DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE;
    testOrgDn = `ou=SyncTestOrg,${DM_LDAP_TOP_ORGANIZATION}`;
    testSubOrg1Dn = `ou=SubOrg1,${testOrgDn}`;
    testSubOrg2Dn = `ou=SubOrg2,${testSubOrg1Dn}`;
    movedOrgDn = `ou=SyncTestOrgMoved,${DM_LDAP_TOP_ORGANIZATION}`;
    testUserDn = `uid=synctestuser,${DM_LDAP_BASE}`;
    testUser2Dn = `uid=synctestuser2,${DM_LDAP_BASE}`;
    testGroupDn = `cn=synctestgroup,${DM_LDAP_BASE}`;

    server = new DM();
    await server.ready;
    plugin = new LdapDepartmentSync(server);
  });

  afterEach(async () => {
    // Clean up all test entries
    const targetOrgDn = `ou=SyncTarget,${DM_LDAP_TOP_ORGANIZATION}`;
    const cleanupEntries = [
      testUser2Dn,
      testUserDn,
      testGroupDn,
      `ou=SubOrg2,ou=SubOrg1,${targetOrgDn}`,
      `ou=SubOrg1,${targetOrgDn}`,
      targetOrgDn,
      `ou=SubOrg2,ou=SubOrg1,${movedOrgDn}`,
      `ou=SubOrg1,${movedOrgDn}`,
      testSubOrg2Dn,
      testSubOrg1Dn,
      movedOrgDn,
      testOrgDn,
    ];

    for (const dn of cleanupEntries) {
      try {
        await server.ldap.delete(dn);
      } catch (e) {
        // ignore
      }
    }
  });

  describe('constructor', () => {
    it('should initialize with default attribute names', () => {
      expect(plugin.name).to.equal('ldapDepartmentSync');
      expect(plugin.roles).to.deep.equal(['consistency']);
    });

    it('should use configured attribute names', () => {
      const linkAttr =
        (server.config.ldap_organization_link_attribute as string) ||
        'twakeDepartmentLink';
      const pathAttr =
        (server.config.ldap_organization_path_attribute as string) ||
        'twakeDepartmentPath';

      expect(plugin['linkAttr']).to.equal(linkAttr);
      expect(plugin['pathAttr']).to.equal(pathAttr);
    });
  });

  describe('ldaprenamedone hook', () => {
    it('should skip non-organization renames', async () => {
      const oldDn = `uid=testuser,${DM_LDAP_BASE}`;
      const newDn = `uid=testuser2,${DM_LDAP_BASE}`;

      // Should not throw error
      await plugin.hooks.ldaprenamedone?.([oldDn, newDn]);
    });

    it('should update resources directly linked to renamed organization', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });

      // Create user linked to organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: 'SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Trigger the hook
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);

      // Verify user's link was updated
      const userResult = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr, pathAttr] },
        testUserDn
      )) as SearchResult;

      const user = userResult.searchEntries[0];
      const userLink = Array.isArray(user[linkAttr])
        ? String(user[linkAttr][0])
        : String(user[linkAttr]);
      const userPath = Array.isArray(user[pathAttr])
        ? String(user[pathAttr][0])
        : String(user[pathAttr]);

      expect(userLink).to.equal(movedOrgDn);
      expect(userPath).to.equal('SyncTestOrgMoved');
    });

    it('updates the resources linked to an organization whose DN holds parentheses', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';
      const org = `ou=R&D (Paris),${DM_LDAP_TOP_ORGANIZATION}`;
      const moved = `ou=R&D (Lyon),${DM_LDAP_TOP_ORGANIZATION}`;
      await server.ldap.add(org, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'R&D (Paris)',
        [pathAttr]: 'R&D (Paris)',
      });
      try {
        await server.ldap.add(testUserDn, {
          objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
          uid: 'synctestuser',
          cn: 'Sync Test User',
          sn: 'User',
          mail: 'synctestuser@example.org',
          [linkAttr]: org,
          [pathAttr]: 'R&D (Paris)',
        });
        await server.ldap.rename(org, moved);
        await plugin.hooks.ldaprenamedone?.([org, moved]);
        const user = (
          (await server.ldap.search(
            { paged: false, scope: 'base', attributes: [linkAttr] },
            testUserDn
          )) as SearchResult
        ).searchEntries[0];
        expect(String(user[linkAttr])).to.equal(moved);
      } finally {
        await server.ldap.delete(org).catch(() => undefined);
        await server.ldap.delete(moved).catch(() => undefined);
      }
    });

    it('should update resources linked to sub-organizations when parent is renamed', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization hierarchy
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });

      await server.ldap.add(testSubOrg1Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg1',
        [pathAttr]: 'SyncTestOrg / SubOrg1',
      });

      // Create user linked to sub-organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        [linkAttr]: testSubOrg1Dn,
        [pathAttr]: 'SyncTestOrg / SubOrg1',
      });

      // Rename parent organization (this moves sub-org automatically)
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // The new sub-org DN after parent rename
      const movedSubOrg1Dn = `ou=SubOrg1,${movedOrgDn}`;

      // Trigger the hook
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);

      // Verify user's link was updated to new sub-org DN
      const userResult = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr, pathAttr] },
        testUserDn
      )) as SearchResult;

      const user = userResult.searchEntries[0];
      const userLink = Array.isArray(user[linkAttr])
        ? String(user[linkAttr][0])
        : String(user[linkAttr]);
      const userPath = Array.isArray(user[pathAttr])
        ? String(user[pathAttr][0])
        : String(user[pathAttr]);

      expect(userLink).to.equal(movedSubOrg1Dn);
      expect(userPath).to.equal('SyncTestOrgMoved / SubOrg1');
    });

    it('should update multiple resources at once', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });

      // Create multiple resources linked to organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: 'SyncTestOrg',
      });

      await server.ldap.add(testUser2Dn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser2',
        cn: 'Sync Test User 2',
        sn: 'User',
        mail: 'synctestuser2@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: 'SyncTestOrg',
      });

      await server.ldap.add(testGroupDn, {
        objectClass: ['groupOfNames', 'twakeStaticGroup', 'top'],
        cn: 'synctestgroup',
        member: testUserDn,
        [linkAttr]: testOrgDn,
        [pathAttr]: 'SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Trigger the hook
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);

      // Verify all resources were updated
      const entries = [testUserDn, testUser2Dn, testGroupDn];

      for (const dn of entries) {
        const result = (await server.ldap.search(
          { paged: false, scope: 'base', attributes: [linkAttr, pathAttr] },
          dn
        )) as SearchResult;

        const entry = result.searchEntries[0];
        const entryLink = Array.isArray(entry[linkAttr])
          ? String(entry[linkAttr][0])
          : String(entry[linkAttr]);
        const entryPath = Array.isArray(entry[pathAttr])
          ? String(entry[pathAttr][0])
          : String(entry[pathAttr]);

        expect(entryLink).to.equal(movedOrgDn);
        expect(entryPath).to.equal('SyncTestOrgMoved');
      }
    });

    it('should handle deep organizational hierarchy', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create deep hierarchy: testOrg -> SubOrg1 -> SubOrg2
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });

      await server.ldap.add(testSubOrg1Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg1',
        [pathAttr]: 'SyncTestOrg / SubOrg1',
      });

      await server.ldap.add(testSubOrg2Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg2',
        [pathAttr]: 'SyncTestOrg / SubOrg1 / SubOrg2',
      });

      // Create user linked to deepest sub-organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        [linkAttr]: testSubOrg2Dn,
        [pathAttr]: 'SyncTestOrg / SubOrg1 / SubOrg2',
      });

      // Rename top-level organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // New DNs after parent rename
      const movedSubOrg1Dn = `ou=SubOrg1,${movedOrgDn}`;
      const movedSubOrg2Dn = `ou=SubOrg2,${movedSubOrg1Dn}`;

      // Trigger the hook
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);

      // Verify user's link was updated to new deep sub-org DN
      const userResult = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr, pathAttr] },
        testUserDn
      )) as SearchResult;

      const user = userResult.searchEntries[0];
      const userLink = Array.isArray(user[linkAttr])
        ? String(user[linkAttr][0])
        : String(user[linkAttr]);
      const userPath = Array.isArray(user[pathAttr])
        ? String(user[pathAttr][0])
        : String(user[pathAttr]);

      expect(userLink).to.equal(movedSubOrg2Dn);
      expect(userPath).to.equal('SyncTestOrgMoved / SubOrg1 / SubOrg2');
    });

    it('should recompute the paths of a moved subtree before the linked entries', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';
      const orgClass = ['organizationalUnit', 'twakeDepartment', 'top'];
      const targetOrgDn = `ou=SyncTarget,${DM_LDAP_TOP_ORGANIZATION}`;

      await server.ldap.add(testOrgDn, {
        objectClass: orgClass,
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });
      await server.ldap.add(testSubOrg1Dn, {
        objectClass: orgClass,
        ou: 'SubOrg1',
        [pathAttr]: 'SyncTestOrg / SubOrg1',
      });
      await server.ldap.add(testSubOrg2Dn, {
        objectClass: orgClass,
        ou: 'SubOrg2',
        [pathAttr]: 'SyncTestOrg / SubOrg1 / SubOrg2',
      });
      await server.ldap.add(targetOrgDn, {
        objectClass: orgClass,
        ou: 'SyncTarget',
        [pathAttr]: 'SyncTarget',
      });
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testSubOrg2Dn,
        [pathAttr]: 'SyncTestOrg / SubOrg1 / SubOrg2',
      });

      // Move SubOrg1 (and SubOrg2 with it) under another organization
      const movedSub1 = `ou=SubOrg1,${targetOrgDn}`;
      const movedSub2 = `ou=SubOrg2,${movedSub1}`;
      await server.ldap.rename(testSubOrg1Dn, movedSub1);
      await plugin.hooks.ldaprenamedone?.([testSubOrg1Dn, movedSub1]);

      const read = async (dn: string, attr: string): Promise<string> => {
        const result = (await server.ldap.search(
          { paged: false, scope: 'base', attributes: [attr] },
          dn
        )) as SearchResult;
        const value = result.searchEntries[0][attr];
        return String(Array.isArray(value) ? value[0] : value);
      };

      // The tree itself follows the move…
      expect(await read(movedSub1, pathAttr)).to.equal('SyncTarget / SubOrg1');
      expect(await read(movedSub2, pathAttr)).to.equal(
        'SyncTarget / SubOrg1 / SubOrg2'
      );
      // …and the linked entry copies the new path, not the stale one
      expect(await read(testUserDn, linkAttr)).to.equal(movedSub2);
      expect(await read(testUserDn, pathAttr)).to.equal(
        'SyncTarget / SubOrg1 / SubOrg2'
      );
    });

    it('should not fail when organization has no linked resources', async () => {
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization without any linked resources
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: 'SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Trigger the hook (should not throw)
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);
    });

    it('should handle organization path without attribute', async () => {
      const linkAttr =
        DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE || 'twakeDepartmentLink';
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization without path attribute
      // Note: twakeDepartment requires twakeDepartmentPath, so we use basic organizationalUnit
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'SyncTestOrg',
      });

      // Create user linked to organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: 'SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Trigger the hook (should fallback to constructing path from ou attribute)
      await plugin.hooks.ldaprenamedone?.([testOrgDn, movedOrgDn]);

      // Verify user's link was updated
      const userResult = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr, pathAttr] },
        testUserDn
      )) as SearchResult;

      const user = userResult.searchEntries[0];
      const userLink = Array.isArray(user[linkAttr])
        ? String(user[linkAttr][0])
        : String(user[linkAttr]);

      expect(userLink).to.equal(movedOrgDn);
      // Path should be constructed from ou attribute
      expect(user[pathAttr]).to.exist;
    });
  });
});

describe('LDAP Department Sync Plugin, attributes named by their roles', function () {
  // A deployment that names the path and link attributes only through the
  // schema roles, none of them the configured defaults: the enterprise rules
  // read the roles, and reading only the configuration here recomputed
  // nothing for it, silently.
  let server: DM;
  let plugin: LdapDepartmentSync;
  let top: string;
  let base: string;
  let previousOrgSchema: string | undefined;
  let previousFlatSchema: string | undefined;
  const orgClass = ['top', 'organizationalUnit'];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    top = process.env.DM_LDAP_TOP_ORGANIZATION!;
    base = process.env.DM_LDAP_BASE!;
    previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
    previousFlatSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './test/fixtures/schemas/roleNamedOrganizations.json';
    process.env.DM_LDAP_FLAT_SCHEMA =
      './test/fixtures/schemas/roleNamedPeople.json';
    server = new DM();
    await server.ready;
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    plugin = new LdapDepartmentSync(server);
  });

  const source = () => `ou=RoleSource,${top}`;
  const target = () => `ou=RoleTarget,${top}`;
  const person = () => `uid=role.person,ou=users,${base}`;

  after(async () => {
    for (const dn of [
      person(),
      `ou=Sub,${target()}`,
      `ou=Sub,${source()}`,
      source(),
      target(),
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousOrgSchema === undefined)
      delete process.env.DM_ORGANIZATION_SCHEMA;
    else process.env.DM_ORGANIZATION_SCHEMA = previousOrgSchema;
    if (previousFlatSchema === undefined)
      delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousFlatSchema;
  });

  it('should recompute the tree and the linked entries through the roles', async () => {
    await server.ldap.add(source(), {
      objectClass: orgClass,
      ou: 'RoleSource',
      description: 'RoleSource',
    });
    await server.ldap.add(target(), {
      objectClass: orgClass,
      ou: 'RoleTarget',
      description: 'RoleTarget',
    });
    await server.ldap.add(`ou=Sub,${source()}`, {
      objectClass: orgClass,
      ou: 'Sub',
      description: 'RoleSource / Sub',
    });
    await server.ldap.add(person(), {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'role.person',
      cn: 'Role Person',
      sn: 'Person',
      seeAlso: `ou=Sub,${source()}`,
      departmentNumber: 'RoleSource / Sub',
    });

    const moved = `ou=Sub,${target()}`;
    await server.ldap.rename(`ou=Sub,${source()}`, moved);
    await plugin.hooks.ldaprenamedone?.([`ou=Sub,${source()}`, moved]);

    const read = async (dn: string, attr: string): Promise<string> => {
      const result = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [attr] },
        dn
      )) as SearchResult;
      const value = result.searchEntries[0][attr];
      return String(Array.isArray(value) ? value[0] : value);
    };
    expect(await read(moved, 'description')).to.equal('RoleTarget / Sub');
    expect(await read(person(), 'seeAlso')).to.equal(moved);
    expect(await read(person(), 'departmentNumber')).to.equal(
      'RoleTarget / Sub'
    );
  });
});
