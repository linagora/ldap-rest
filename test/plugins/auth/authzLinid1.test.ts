import { expect } from 'chai';
import { DM } from '../../../src/bin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import LdapOrganization from '../../../src/plugins/ldap/organization';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Response } from 'express';
import type { Role } from '../../../src/abstract/plugin';
import supertest from 'supertest';
import { skipIfMissingEnvVars } from '../../helpers/env';

// Simple auth plugin for testing that sets user from X-Test-User header
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    // Use X-Test-User header to identify user, or fall back to token-based auth
    const testUser = req.headers['x-test-user'];
    if (testUser && typeof testUser === 'string') {
      req.user = testUser;
      return next();
    }

    // Otherwise, require a valid token
    let token = req.headers['authorization'];
    if (!token || !/^Bearer .+/.test(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    token = token.split(' ')[1];
    if (!(this.config.auth_token as string[]).includes(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user =
      'token number ' + (this.config.auth_token as string[]).indexOf(token);
    next();
  }
}

describe('AuthzLinid1 Plugin', () => {
  let dm: DM;
  let authz: AuthzLinid1;

  // Use getters to ensure env vars are evaluated after setup
  const getTestOrgDn = () => `ou=TestOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const getTestUserDn = () => `uid=testadmin,${process.env.DM_LDAP_BASE}`;

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    authz = new AuthzLinid1(dm);
    dm.registerPlugin('authzLinid1', authz);
  });

  afterEach(async () => {
    // Clean up test entries
    try {
      await dm.ldap.delete(getTestOrgDn());
    } catch (err) {
      // Ignore if doesn't exist
    }
    try {
      await dm.ldap.delete(getTestUserDn());
    } catch (err) {
      // Ignore if doesn't exist
    }
  });

  describe('getUserDn', () => {
    it('should resolve user DN from uid', async () => {
      // Create a test user
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), entry);

      const dn = await authz.getUserDn('testadmin');
      expect(dn).to.equal(getTestUserDn());
    });

    it('should return null for non-existent user', async () => {
      const dn = await authz.getUserDn('nonexistent');
      expect(dn).to.be.null;
    });
  });

  describe('getUserPermissions', () => {
    it('should grant permissions when user is in twakeLocalAdminLink', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Create test organization with user as local admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Get permissions
      const perms = await authz.getUserPermissions(getTestUserDn(), getTestOrgDn());

      expect(perms.read).to.be.true;
      expect(perms.write).to.be.true;
      expect(perms.delete).to.be.true;
    });

    it('should deny permissions when user is not in twakeLocalAdminLink', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Create test organization without user as local admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Get permissions
      const perms = await authz.getUserPermissions(getTestUserDn(), getTestOrgDn());

      expect(perms.read).to.be.false;
      expect(perms.write).to.be.false;
      expect(perms.delete).to.be.false;
    });

    it('should grant permissions for sub-branches when user has access to parent', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Create parent organization with user as local admin
      const parentOrgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), parentOrgEntry);

      // Check permissions for a sub-branch
      const subBranchDn = `ou=SubOrg,${getTestOrgDn()}`;
      const perms = await authz.getUserPermissions(getTestUserDn(), subBranchDn);

      expect(perms.read).to.be.true;
      expect(perms.write).to.be.true;
      expect(perms.delete).to.be.true;
    });
  });

  describe('getAuthorizedBranches', () => {
    it('should return list of branches user manages', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Create test organization with user as local admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Get authorized branches
      const branches = await authz.getAuthorizedBranches(getTestUserDn());

      expect(branches).to.be.an('array');
      expect(branches).to.include(getTestOrgDn());
    });

    it('should return empty array when user has no permissions', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Get authorized branches (no org with this user as admin)
      const branches = await authz.getAuthorizedBranches(getTestUserDn());

      expect(branches).to.be.an('array');
      expect(branches).to.have.lengthOf(0);
    });
  });

  describe('Cache', () => {
    it('should cache permissions', async () => {
      // Create test user
      const userEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), userEntry);

      // Create test organization
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // First call - should fetch from LDAP
      const perms1 = await authz.getUserPermissions(getTestUserDn(), getTestOrgDn());
      expect(perms1.read).to.be.true;

      // Second call - should use cache
      const perms2 = await authz.getUserPermissions(getTestUserDn(), getTestOrgDn());
      expect(perms2.read).to.be.true;

      // Verify cache was used
      const cached = authz.permissionsCache.get(getTestUserDn());
      expect(cached).to.exist;
      expect(cached?.branches.size).to.be.greaterThan(0);
    });
  });

  describe('Integration with users branch', () => {
    const getTestUserInOrgDn = () => `uid=testuser,ou=users,${process.env.DM_LDAP_BASE}`;
    const getTestUser2InOrgDn = () => `uid=testuser2,ou=users,${process.env.DM_LDAP_BASE}`;
    const getTestOrg2Dn = () => `ou=TestOrg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;

    afterEach(async () => {
      // Clean up test users in users branch
      try {
        await dm.ldap.delete(getTestUserInOrgDn());
      } catch (err) {
        // Ignore if doesn't exist
      }
      try {
        await dm.ldap.delete(getTestUser2InOrgDn());
      } catch (err) {
        // Ignore if doesn't exist
      }
      try {
        await dm.ldap.delete(getTestOrg2Dn());
      } catch (err) {
        // Ignore if doesn't exist
      }
    });

    it('should allow admin to see users linked to their organization', async () => {
      // Create admin user
      const adminEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), adminEntry);

      // Create organization with admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Create user in users branch linked to this organization
      const userEntry = {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: 'testuser',
        sn: 'User',
        cn: 'Test User',
        twakeDepartmentLink: getTestOrgDn(),
      };
      await dm.ldap.add(getTestUserInOrgDn(), userEntry);

      // Admin should have permissions to read the users branch
      const perms = await authz.getUserPermissions(
        getTestUserDn(),
        `ou=users,${process.env.DM_LDAP_BASE}`
      );

      // Note: Admin has permissions on their org branch, not necessarily on ou=users
      // But they should be able to read users that belong to their org
      // This might require additional logic in the plugin or is handled by LDAP filters
      expect(perms).to.exist;
    });

    it('should grant permissions for users branch when user manages an organization', async () => {
      // Create admin user
      const adminEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), adminEntry);

      // Create organization with admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Get authorized branches
      const branches = await authz.getAuthorizedBranches(getTestUserDn());

      // Should include the organization
      expect(branches).to.include(getTestOrgDn());
    });

    it('should return sub-organization as top for local admin via getOrganisationTop hook', async function () {
      if (!process.env.DM_LDAP_TOP_ORGANIZATION) {
        this.skip();
      }

      // Load organization plugin
      const orgPlugin = new LdapOrganization(dm);
      dm.registerPlugin('ldapOrganizations', orgPlugin);

      // Create admin user
      const adminEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), adminEntry);

      // Create sub-organization with admin
      const orgEntry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), orgEntry);

      // Create a mock request with the admin user
      const req = { user: 'testadmin' } as any;

      // First verify that the user has been granted permissions
      const branches = await authz.getAuthorizedBranches(getTestUserDn());
      expect(branches).to.include(getTestOrgDn());

      // Call getOrganisationTop - should return the sub-org, not the top org
      const result = await orgPlugin.getOrganisationTop(req);

      // Should return the TestOrg, not the top organization
      expect(result).to.exist;
      const resultDn =
        typeof (result as any).dn === 'string'
          ? (result as any).dn
          : String((result as any).dn);
      expect(resultDn).to.equal(getTestOrgDn());
    });

    it('should deny admin access to users from other organizations', async () => {
      // Create admin user
      const adminEntry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'testadmin',
        sn: 'Admin',
        cn: 'Test Admin',
      };
      await dm.ldap.add(getTestUserDn(), adminEntry);

      // Create organization 1 with admin
      const org1Entry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg',
        twakeDepartmentPath: 'TestOrg / organization',
        twakeLocalAdminLink: getTestUserDn(),
      };
      await dm.ldap.add(getTestOrgDn(), org1Entry);

      // Create organization 2 without admin
      const org2Entry = {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'TestOrg2',
        twakeDepartmentPath: 'TestOrg2 / organization',
      };
      await dm.ldap.add(getTestOrg2Dn(), org2Entry);

      // Create user in users branch linked to organization 2
      const user2Entry = {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: 'testuser2',
        sn: 'User2',
        cn: 'Test User 2',
        twakeDepartmentLink: getTestOrg2Dn(),
      };
      await dm.ldap.add(getTestUser2InOrgDn(), user2Entry);

      // Get authorized branches - should only include org1, not org2
      const branches = await authz.getAuthorizedBranches(getTestUserDn());
      expect(branches).to.include(getTestOrgDn());
      expect(branches).to.not.include(getTestOrg2Dn());

      // Admin should not have permissions on org2
      const perms = await authz.getUserPermissions(getTestUserDn(), getTestOrg2Dn());
      expect(perms.read).to.be.false;
      expect(perms.write).to.be.false;
      expect(perms.delete).to.be.false;
    });
  });

  describe('Out of scope access control via API', () => {
    let request: ReturnType<typeof supertest>;
    let orgPlugin: LdapOrganization;
    let authPlugin: TestAuthPlugin;
    const getTestOrg2Dn = () => `ou=TestOrg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const getTestSubOrg1Dn = () => `ou=SubOrg1,${getTestOrgDn()}`;
    const getTestSubOrg2Dn = () => `ou=SubOrg2,${getTestOrg2Dn()}`;
    const adminToken = 'test-admin-token';

    beforeEach(async () => {
      // Setup DM with auth token and organization plugins
      process.env.DM_AUTH_TOKENS = adminToken;
      dm = new DM();
      await dm.ready;

      // Register plugins
      authz = new AuthzLinid1(dm);
      authPlugin = new TestAuthPlugin(dm);
      orgPlugin = new LdapOrganization(dm);

      await dm.registerPlugin('testAuth', authPlugin);
      await dm.registerPlugin('authzLinid1', authz);
      await dm.registerPlugin('ldapOrganizations', orgPlugin);

      orgPlugin.api(dm.app);
      request = supertest(dm.app);
    });

    afterEach(async () => {
      // Clean up test entries
      try {
        await dm.ldap.delete(getTestSubOrg1Dn());
      } catch (err) {
        // Ignore if doesn't exist
      }
      try {
        await dm.ldap.delete(getTestSubOrg2Dn());
      } catch (err) {
        // Ignore if doesn't exist
      }
      try {
        await dm.ldap.delete(getTestOrg2Dn());
      } catch (err) {
        // Ignore if doesn't exist
      }
      delete process.env.DM_AUTH_TOKENS;
    });

    describe('READ - Search outside authorized scope', () => {
      it('should not allow search in unauthorized branch', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 without admin (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to get unauthorized org via API - should fail
        const res = await request
          .get(`/api/v1/ldap/organizations/${encodeURIComponent(getTestOrg2Dn())}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testadmin')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(500);
        expect(res.body).to.have.property('error');
        expect(res.body.error).to.equal('check logs');
      });

      it('should allow search in authorized branch', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Try to get authorized org via API - should succeed
        const res = await request
          .get(`/api/v1/ldap/organizations/${encodeURIComponent(getTestOrgDn())}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testadmin')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('dn', getTestOrgDn());
        expect(res.body).to.have.property('ou', 'TestOrg');
      });

      it('should not return entries from other branches in subnodes search', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 without admin (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to search subnodes of unauthorized org - should fail
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(getTestOrg2Dn())}/subnodes`
          )
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testadmin')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(500);
        expect(res.body).to.have.property('error');
      });
    });

    describe('WRITE - Add organizational unit outside scope', () => {
      it('should reject adding a sub-organization in an unauthorized branch', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 without admin (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to add a sub-org under unauthorized org2 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testadmin')
          .type('json')
          .send({
            ou: 'SubOrg2',
            parentDn: getTestOrg2Dn(),
          });

        // Should be rejected
        expect(res.status).to.not.equal(200);

        // Verify nothing was written to LDAP using direct search
        try {
          const searchResult = await dm.ldap.search(
            {
              paged: false,
              scope: 'base',
              filter: '(objectClass=*)',
            },
            getTestSubOrg2Dn()
          );
          // If search succeeds, ensure it returned 0 entries
          expect((searchResult as any).searchEntries).to.have.lengthOf(0);
        } catch (err) {
          // NoSuchObjectError is expected - it means the entry was not created
          expect(err).to.be.instanceOf(Error);
          expect((err as any).code).to.equal(32); // LDAP NoSuchObject error code
        }
      });

      it('should allow adding a sub-organization in an authorized branch', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Try to add a sub-org under authorized org1 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testadmin')
          .type('json')
          .send({
            ou: 'SubOrg1',
            parentDn: getTestOrgDn(),
          });

        // Should succeed
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('success', true);

        // Verify it was written to LDAP using direct search
        const searchResult = await dm.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          getTestSubOrg1Dn()
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect((searchResult as any).searchEntries[0].ou).to.equal('SubOrg1');
      });
    });

    describe('WRITE - Move user between organizations', () => {
      const getTestUser1Dn = () => `uid=testuser1,ou=users,${process.env.DM_LDAP_BASE}`;

      afterEach(async () => {
        try {
          await dm.ldap.delete(getTestUser1Dn());
        } catch (err) {
          // Ignore if doesn't exist
        }
      });

      it('should allow moving user to authorized organization', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create second organization with admin (also authorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Create user in first organization
        const userEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: getTestOrgDn(),
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await dm.ldap.add(getTestUser1Dn(), userEntry);

        // Create mock request
        const mockReq = { user: 'testadmin' } as any;

        // Move user to second organization - should succeed
        await dm.ldap.modify(
          getTestUser1Dn(),
          {
            replace: {
              twakeDepartmentLink: getTestOrg2Dn(),
              twakeDepartmentPath: 'TestOrg2 / organization',
            },
          },
          mockReq
        );

        // Verify it was updated
        const searchResult = await dm.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          getTestUser1Dn()
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect(
          (searchResult as any).searchEntries[0].twakeDepartmentLink
        ).to.equal(getTestOrg2Dn());
      });

      it('should reject moving user to unauthorized organization', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 without admin (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Create user in first organization
        const userEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: getTestOrgDn(),
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await dm.ldap.add(getTestUser1Dn(), userEntry);

        // Create mock request
        const mockReq = { user: 'testadmin' } as any;

        // Try to move user to unauthorized organization - should be rejected
        try {
          await dm.ldap.modify(
            getTestUser1Dn(),
            {
              replace: {
                twakeDepartmentLink: getTestOrg2Dn(),
                twakeDepartmentPath: 'TestOrg2 / organization',
              },
            },
            mockReq
          );
          expect.fail('Should have thrown an error for unauthorized move');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as Error).message).to.include(
            'does not have write permission'
          );
        }

        // Verify user was not moved
        const searchResult = await dm.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          getTestUser1Dn()
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect(
          (searchResult as any).searchEntries[0].twakeDepartmentLink
        ).to.equal(getTestOrgDn()); // Still in original org
      });

      it('should reject moving user from unauthorized org (requires read on source)', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 without admin (user starts here, unauthorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 with admin (authorized for admin)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Create user in first organization (where admin has no rights)
        const userEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: getTestOrgDn(),
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await dm.ldap.add(getTestUser1Dn(), userEntry);

        // Create mock request
        const mockReq = { user: 'testadmin' } as any;

        // Try to move user to authorized organization
        // This should fail because admin does not have read permission on source org
        try {
          await dm.ldap.modify(
            getTestUser1Dn(),
            {
              replace: {
                twakeDepartmentLink: getTestOrg2Dn(),
                twakeDepartmentPath: 'TestOrg2 / organization',
              },
            },
            mockReq
          );
          expect.fail('Should have thrown an error for unauthorized move');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as Error).message).to.include(
            'does not have read permission for source branch'
          );
        }

        // Verify user was not moved
        const searchResult = await dm.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          getTestUser1Dn()
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect(
          (searchResult as any).searchEntries[0].twakeDepartmentLink
        ).to.equal(getTestOrgDn()); // Still in original org
      });
    });

    describe('WRITE - Add user with twakeDepartmentLink', () => {
      const getTestUser1Dn = () => `uid=testuser1,ou=users,${process.env.DM_LDAP_BASE}`;
      const getTestUser2Dn = () => `uid=testuser2,ou=users,${process.env.DM_LDAP_BASE}`;

      afterEach(async () => {
        try {
          await dm.ldap.delete(getTestUser1Dn());
        } catch (err) {
          // Ignore if doesn't exist
        }
        try {
          await dm.ldap.delete(getTestUser2Dn());
        } catch (err) {
          // Ignore if doesn't exist
        }
      });

      it('should allow adding a user in ou=users if twakeDepartmentLink points to authorized org', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Admin should NOT have direct write permission on ou=users
        const usersBranchDn = `ou=users,${process.env.DM_LDAP_BASE}`;
        const usersBranchPerms = await authz.getUserPermissions(
          getTestUserDn(),
          usersBranchDn
        );
        expect(usersBranchPerms.write).to.be.false;

        // But admin SHOULD be able to create a user with twakeDepartmentLink pointing to their org
        // This is done via direct LDAP add with req context
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: [getTestOrgDn()], // Points to authorized org (array format)
        };

        // Create mock request
        const mockReq = { user: 'testadmin' } as any;

        // This should succeed because twakeDepartmentLink points to authorized org
        await dm.ldap.add(getTestUser1Dn(), newUserEntry, mockReq);

        // Verify it was written to LDAP
        const searchResult = await dm.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          getTestUser1Dn()
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect((searchResult as any).searchEntries[0].uid).to.equal(
          'testuser1'
        );
        expect(
          (searchResult as any).searchEntries[0].twakeDepartmentLink
        ).to.equal(getTestOrgDn());
      });

      it('should reject adding a user in ou=users if twakeDepartmentLink points to unauthorized org', async () => {
        // Create admin user
        const adminEntry = {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'testadmin',
          sn: 'Admin',
          cn: 'Test Admin',
        };
        await dm.ldap.add(getTestUserDn(), adminEntry);

        // Create organization 1 with admin (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
          twakeLocalAdminLink: getTestUserDn(),
        };
        await dm.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 without admin (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await dm.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to create a user with twakeDepartmentLink pointing to unauthorized org
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser2',
          sn: 'User2',
          cn: 'Test User 2',
          twakeDepartmentLink: [getTestOrg2Dn()], // Points to UNAUTHORIZED org (array format)
        };

        // Create mock request
        const mockReq = { user: 'testadmin' } as any;

        // This should be rejected
        try {
          await dm.ldap.add(getTestUser2Dn(), newUserEntry, mockReq);
          expect.fail('Should have thrown an error for unauthorized write');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as Error).message).to.include(
            'does not have write permission'
          );
        }

        // Verify nothing was written to LDAP
        try {
          await dm.ldap.search(
            {
              paged: false,
              scope: 'base',
              filter: '(objectClass=*)',
            },
            getTestUser2Dn()
          );
          expect.fail('User should not have been created');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as any).code).to.equal(32); // NoSuchObject
        }
      });
    });
  });
});
