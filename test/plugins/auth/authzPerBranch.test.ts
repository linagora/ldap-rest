import { expect } from 'chai';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { DM } from '../../../src/bin';
import LdapOrganization from '../../../src/plugins/ldap/organization';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Response } from 'express';
import type { Role } from '../../../src/abstract/plugin';
import supertest from 'supertest';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

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

const { DM_LDAP_BASE, DM_LDAP_GROUP_BRANCH } = process.env;
const USER_BRANCH = `ou=users,${DM_LDAP_BASE}`;

describe('AuthzPerBranch', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let plugin: AuthzPerBranch;

  before(async function () {
    this.timeout(5000);

    // Create test config as JSON string for environment variable
    const testConfig = {
      default: {
        read: false,
        write: false,
        delete: false,
      },
      users: {
        testuser1: {
          [USER_BRANCH as string]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser2: {
          [USER_BRANCH as string]: {
            read: true,
            write: false,
            delete: false,
          },
        },
      },
      groups: {},
    };

    // Set environment variables BEFORE creating DM
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify(testConfig);
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    // Initialize server with config
    server = new DM();
    plugin = new AuthzPerBranch(server);
    await server.registerPlugin('authzPerBranch', plugin);
  });

  describe('Config loading', () => {
    it('should load authorization config from environment', () => {
      expect(plugin.authConfig).to.exist;
      expect(plugin.authConfig?.default).to.deep.equal({
        read: false,
        write: false,
        delete: false,
      });
      expect(plugin.authConfig?.users).to.have.property('testuser1');
      expect(plugin.authConfig?.users).to.have.property('testuser2');
    });

    it('should set cache TTL from config', () => {
      expect(plugin.cacheTTL).to.equal(60000); // 60 seconds in ms
    });
  });

  describe('Permission checking', () => {
    it('should return default permissions for unknown user', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'unknownuser',
        USER_BRANCH as string
      );
      expect(permissions).to.deep.equal({
        read: false,
        write: false,
        delete: false,
      });
    });

    it('should return user-specific permissions', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'testuser1',
        USER_BRANCH as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.true;
      expect(permissions.delete).to.be.false;
    });

    it('should return different permissions for different users', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'testuser2',
        USER_BRANCH as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.false;
      expect(permissions.delete).to.be.false;
    });

    it('should support sub-branch permissions', async function () {
      this.timeout(5000);
      // Test that permissions apply to sub-branches
      const subBranch = `ou=test,${USER_BRANCH}`;
      const permissions = await plugin.getUserPermissions(
        'testuser1',
        subBranch
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.true;
    });
  });

  describe('Authorized branches', () => {
    it('should return authorized branches for read permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranchesForPermission(
        'testuser1',
        'read'
      );
      expect(branches).to.be.an('array');
      expect(branches).to.include(USER_BRANCH);
    });

    it('should return authorized branches for write permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranchesForPermission(
        'testuser1',
        'write'
      );
      expect(branches).to.be.an('array');
      expect(branches).to.include(USER_BRANCH);
    });

    it('should return empty array for unauthorized permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranchesForPermission(
        'testuser2',
        'write'
      );
      expect(branches).to.be.an('array');
      expect(branches).to.have.lengthOf(0);
    });

    it('should return empty array for unknown user', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranchesForPermission(
        'unknownuser',
        'read'
      );
      expect(branches).to.be.an('array');
      expect(branches).to.have.lengthOf(0);
    });
  });

  describe('Group caching', () => {
    it('should cache group memberships', async function () {
      this.timeout(5000);
      const uid = 'testuser1';

      // First call - should query LDAP
      const groups1 = await plugin.getUserGroups(uid);

      // Second call - should use cache
      const groups2 = await plugin.getUserGroups(uid);

      expect(groups1).to.deep.equal(groups2);
      expect(plugin.groupCache.has(uid)).to.be.true;
    });

    it('should expire cache after TTL', async function () {
      this.timeout(5000);
      const uid = 'testuser_cache_test';

      // Set a very short TTL for this test
      const originalTTL = plugin.cacheTTL;
      plugin.cacheTTL = 100; // 100ms

      // First call
      await plugin.getUserGroups(uid);
      expect(plugin.groupCache.has(uid)).to.be.true;

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Second call should trigger new LDAP query
      await plugin.getUserGroups(uid);

      // Restore original TTL
      plugin.cacheTTL = originalTTL;
    });
  });

  describe('Hook integration', () => {
    it('should register ldapsearchrequest hook', () => {
      expect(plugin.hooks).to.not.be.undefined;
      expect(plugin.hooks).to.have.property('ldapsearchrequest');
      expect(plugin.hooks?.ldapsearchrequest).to.be.a('function');
    });

    it('should throw error when user lacks read permission', async function () {
      this.timeout(5000);
      try {
        // Create a mock request with unauthorized user
        const mockReq = { user: 'unknownuser' } as any;
        if (plugin.hooks?.ldapsearchrequest) {
          await plugin.hooks.ldapsearchrequest([
            USER_BRANCH as string,
            { paged: false },
            mockReq,
          ]);
        }
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.match(/does not have read permission/i);
      }
    });

    it('should allow search when user has read permission', async function () {
      this.timeout(5000);
      const mockReq = { user: 'testuser1' } as any;
      if (plugin.hooks?.ldapsearchrequest) {
        const result = await plugin.hooks.ldapsearchrequest([
          USER_BRANCH as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(USER_BRANCH);
        // When searching within authorized branch, filter should not be modified
        expect(result[1]).to.not.be.undefined;
      }
    });

    it('should pass through when no user in request', async function () {
      this.timeout(5000);
      const mockReq = {} as any;
      if (plugin.hooks?.ldapsearchrequest) {
        const result = await plugin.hooks.ldapsearchrequest([
          USER_BRANCH as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(USER_BRANCH);
        expect(result[1]).to.deep.equal({ paged: false });
      }
    });
  });

  describe('API access control', () => {
    const testOrgDn = `ou=TestOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const testOrg2Dn = `ou=TestOrg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const testSubOrg1Dn = `ou=SubOrg1,${testOrgDn}`;
    const testSubOrg2Dn = `ou=SubOrg2,${testOrg2Dn}`;
    const testUser1Dn = `uid=testuser1,ou=users,${DM_LDAP_BASE}`;
    const testUser2Dn = `uid=testuser2,ou=users,${DM_LDAP_BASE}`;
    const adminToken = 'test-admin-token';
    let request: ReturnType<typeof supertest>;
    let orgPlugin: LdapOrganization;
    let authPlugin: TestAuthPlugin;
    let apiServer: DM;

    before(async function () {
      this.timeout(10000);

      // Create test config for API tests
      const testConfig = {
        default: {
          read: false,
          write: false,
          delete: false,
        },
        users: {
          testuser1: {
            [testOrgDn]: {
              read: true,
              write: true,
              delete: false,
            },
          },
        },
        groups: {},
      };

      // Setup DM with auth and organization plugins
      process.env.DM_AUTH_TOKENS = adminToken;
      process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify(testConfig);
      apiServer = new DM();
      await apiServer.ready;

      // Register plugins
      const authzPerBranch = new AuthzPerBranch(apiServer);
      authPlugin = new TestAuthPlugin(apiServer);
      orgPlugin = new LdapOrganization(apiServer);

      await apiServer.registerPlugin('testAuth', authPlugin);
      await apiServer.registerPlugin('authzPerBranch', authzPerBranch);
      await apiServer.registerPlugin('ldapOrganizations', orgPlugin);

      orgPlugin.api(apiServer.app);
      request = supertest(apiServer.app);
    });

    afterEach(async function () {
      this.timeout(5000);
      // Clean up test entries
      try {
        await apiServer.ldap.delete(testUser1Dn);
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(testUser2Dn);
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(testSubOrg1Dn);
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(testSubOrg2Dn);
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(testOrgDn);
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(testOrg2Dn);
      } catch (err) {
        // Ignore
      }
    });

    describe('READ - Search outside authorized scope', () => {
      it('should not allow search in unauthorized branch', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized for testuser1)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Create organization 2 (NOT authorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await apiServer.ldap.add(testOrg2Dn, org2Entry);

        // Try to get unauthorized org via API - should fail
        const res = await request
          .get(`/api/v1/ldap/organizations/${encodeURIComponent(testOrg2Dn)}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(500);
        expect(res.body).to.have.property('error');
        expect(res.body.error).to.equal('check logs');
      });

      it('should allow search in authorized branch', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized for testuser1)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Try to get authorized org via API - should succeed
        const res = await request
          .get(`/api/v1/ldap/organizations/${encodeURIComponent(testOrgDn)}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('dn', testOrgDn);
        expect(res.body).to.have.property('ou', 'TestOrg');
      });
    });

    describe('WRITE - Add organizational unit outside scope', () => {
      it('should reject adding a sub-organization in an unauthorized branch', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Create organization 2 (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await apiServer.ldap.add(testOrg2Dn, org2Entry);

        // Try to add a sub-org under unauthorized org2 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .type('json')
          .send({
            ou: 'SubOrg2',
            parentDn: testOrg2Dn,
          });

        // Should be rejected
        expect(res.status).to.not.equal(200);

        // Verify nothing was written to LDAP
        try {
          await apiServer.ldap.search(
            {
              paged: false,
              scope: 'base',
              filter: '(objectClass=*)',
            },
            testSubOrg2Dn
          );
          expect.fail('SubOrg2 should not have been created');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as any).code).to.equal(32); // NoSuchObject
        }
      });

      it('should allow adding a sub-organization in an authorized branch', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Try to add a sub-org under authorized org1 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .type('json')
          .send({
            ou: 'SubOrg1',
            parentDn: testOrgDn,
          });

        // Should succeed
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('success', true);

        // Verify it was written to LDAP
        const searchResult = await apiServer.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          testSubOrg1Dn
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect((searchResult as any).searchEntries[0].ou).to.equal('SubOrg1');
      });
    });

    describe('WRITE - Add user with twakeDepartmentLink', () => {
      it('should allow adding a user if twakeDepartmentLink points to authorized org', async function () {
        this.timeout(5000);

        // Create organization (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Create user with twakeDepartmentLink pointing to authorized org
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: [testOrgDn],
        };

        const mockReq = { user: 'testuser1' } as any;

        // This should succeed
        await apiServer.ldap.add(testUser1Dn, newUserEntry, mockReq);

        // Verify it was written
        const searchResult = await apiServer.ldap.search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
          },
          testUser1Dn
        );
        expect((searchResult as any).searchEntries).to.have.lengthOf(1);
        expect((searchResult as any).searchEntries[0].uid).to.equal(
          'testuser1'
        );
      });

      it('should reject adding a user if twakeDepartmentLink points to unauthorized org', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg / organization',
        };
        await apiServer.ldap.add(testOrgDn, org1Entry);

        // Create organization 2 (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2 / organization',
        };
        await apiServer.ldap.add(testOrg2Dn, org2Entry);

        // Try to create user with twakeDepartmentLink pointing to unauthorized org
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser2',
          sn: 'User2',
          cn: 'Test User 2',
          twakeDepartmentLink: [testOrg2Dn], // UNAUTHORIZED
        };

        const mockReq = { user: 'testuser1' } as any;

        // This should be rejected
        try {
          await apiServer.ldap.add(testUser2Dn, newUserEntry, mockReq);
          expect.fail('Should have thrown an error for unauthorized write');
        } catch (err) {
          expect(err).to.be.instanceOf(Error);
          expect((err as Error).message).to.include(
            'does not have write permission'
          );
        }

        // Verify nothing was written
        try {
          await apiServer.ldap.search(
            {
              paged: false,
              scope: 'base',
              filter: '(objectClass=*)',
            },
            testUser2Dn
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
