import { expect } from 'chai';
import LdapDepartmentSync from '../../../src/plugins/ldap/departmentSync';
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
    const cleanupEntries = [
      testUser2Dn,
      testUserDn,
      testGroupDn,
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
        [pathAttr]: '/SyncTestOrg',
      });

      // Create user linked to organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: '/SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Update the organization's path attribute (normally done by organization plugin)
      await server.ldap.modify(movedOrgDn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved' },
      });

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
      expect(userPath).to.equal('/SyncTestOrgMoved');
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
        [pathAttr]: '/SyncTestOrg',
      });

      await server.ldap.add(testSubOrg1Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg1',
        [pathAttr]: '/SyncTestOrg/SubOrg1',
      });

      // Create user linked to sub-organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        [linkAttr]: testSubOrg1Dn,
        [pathAttr]: '/SyncTestOrg/SubOrg1',
      });

      // Rename parent organization (this moves sub-org automatically)
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // The new sub-org DN after parent rename
      const movedSubOrg1Dn = `ou=SubOrg1,${movedOrgDn}`;

      // Update the organizations' path attributes (normally done by organization plugin)
      await server.ldap.modify(movedOrgDn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved' },
      });
      await server.ldap.modify(movedSubOrg1Dn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved/SubOrg1' },
      });

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
      expect(userPath).to.equal('/SyncTestOrgMoved/SubOrg1');
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
        [pathAttr]: '/SyncTestOrg',
      });

      // Create multiple resources linked to organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        mail: 'synctestuser@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: '/SyncTestOrg',
      });

      await server.ldap.add(testUser2Dn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser2',
        cn: 'Sync Test User 2',
        sn: 'User',
        mail: 'synctestuser2@example.org',
        [linkAttr]: testOrgDn,
        [pathAttr]: '/SyncTestOrg',
      });

      await server.ldap.add(testGroupDn, {
        objectClass: ['groupOfNames', 'twakeStaticGroup', 'top'],
        cn: 'synctestgroup',
        member: testUserDn,
        [linkAttr]: testOrgDn,
        [pathAttr]: '/SyncTestOrg',
      });

      // Rename organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // Update the organization's path attribute (normally done by organization plugin)
      await server.ldap.modify(movedOrgDn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved' },
      });

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
        expect(entryPath).to.equal('/SyncTestOrgMoved');
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
        [pathAttr]: '/SyncTestOrg',
      });

      await server.ldap.add(testSubOrg1Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg1',
        [pathAttr]: '/SyncTestOrg/SubOrg1',
      });

      await server.ldap.add(testSubOrg2Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SubOrg2',
        [pathAttr]: '/SyncTestOrg/SubOrg1/SubOrg2',
      });

      // Create user linked to deepest sub-organization
      await server.ldap.add(testUserDn, {
        objectClass: ['twakeAccount', 'twakeWhitePages', 'top'],
        uid: 'synctestuser',
        cn: 'Sync Test User',
        sn: 'User',
        [linkAttr]: testSubOrg2Dn,
        [pathAttr]: '/SyncTestOrg/SubOrg1/SubOrg2',
      });

      // Rename top-level organization
      await server.ldap.rename(testOrgDn, movedOrgDn);

      // New DNs after parent rename
      const movedSubOrg1Dn = `ou=SubOrg1,${movedOrgDn}`;
      const movedSubOrg2Dn = `ou=SubOrg2,${movedSubOrg1Dn}`;

      // Update organizations' path attributes (normally done by organization plugin)
      await server.ldap.modify(movedOrgDn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved' },
      });
      await server.ldap.modify(movedSubOrg1Dn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved/SubOrg1' },
      });
      await server.ldap.modify(movedSubOrg2Dn, {
        replace: { [pathAttr]: '/SyncTestOrgMoved/SubOrg1/SubOrg2' },
      });

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
      expect(userPath).to.equal('/SyncTestOrgMoved/SubOrg1/SubOrg2');
    });

    it('should not fail when organization has no linked resources', async () => {
      const pathAttr =
        DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE || 'twakeDepartmentPath';

      // Create organization without any linked resources
      await server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'SyncTestOrg',
        [pathAttr]: '/SyncTestOrg',
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
        [pathAttr]: '/SyncTestOrg',
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
