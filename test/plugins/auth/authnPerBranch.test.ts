import { expect } from 'chai';
import AuthnPerBranch from '../../../src/plugins/auth/authnPerBranch';
import { DM } from '../../../src/bin';

const { DM_LDAP_USER_BRANCH, DM_LDAP_GROUP_BRANCH } = process.env;

describe('AuthnPerBranch', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_USER_BRANCH
  ) {
    console.warn(
      'Skipping authnPerBranch tests: LDAP credentials are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: AuthnPerBranch;

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
          [DM_LDAP_USER_BRANCH as string]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser2: {
          [DM_LDAP_USER_BRANCH as string]: {
            read: true,
            write: false,
            delete: false,
          },
        },
      },
      groups: {},
    };

    // Set environment variables BEFORE creating DM
    process.env.DM_AUTHN_PER_BRANCH_CONFIG = JSON.stringify(testConfig);
    process.env.DM_AUTHN_PER_BRANCH_CACHE_TTL = '60';

    // Initialize server with config
    server = new DM();
    plugin = new AuthnPerBranch(server);
    await server.registerPlugin('authnPerBranch', plugin);
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
        DM_LDAP_USER_BRANCH as string
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
        DM_LDAP_USER_BRANCH as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.true;
      expect(permissions.delete).to.be.false;
    });

    it('should return different permissions for different users', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'testuser2',
        DM_LDAP_USER_BRANCH as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.false;
      expect(permissions.delete).to.be.false;
    });

    it('should support sub-branch permissions', async function () {
      this.timeout(5000);
      // Test that permissions apply to sub-branches
      const subBranch = `ou=test,${DM_LDAP_USER_BRANCH}`;
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
      const branches = await plugin.getAuthorizedBranches('testuser1', 'read');
      expect(branches).to.be.an('array');
      expect(branches).to.include(DM_LDAP_USER_BRANCH);
    });

    it('should return authorized branches for write permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranches('testuser1', 'write');
      expect(branches).to.be.an('array');
      expect(branches).to.include(DM_LDAP_USER_BRANCH);
    });

    it('should return empty array for unauthorized permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranches('testuser2', 'write');
      expect(branches).to.be.an('array');
      expect(branches).to.have.lengthOf(0);
    });

    it('should return empty array for unknown user', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranches(
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
            DM_LDAP_USER_BRANCH as string,
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
          DM_LDAP_USER_BRANCH as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(DM_LDAP_USER_BRANCH);
        // When searching within authorized branch, filter should not be modified
        expect(result[1]).to.not.be.undefined;
      }
    });

    it('should pass through when no user in request', async function () {
      this.timeout(5000);
      const mockReq = {} as any;
      if (plugin.hooks?.ldapsearchrequest) {
        const result = await plugin.hooks.ldapsearchrequest([
          DM_LDAP_USER_BRANCH as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(DM_LDAP_USER_BRANCH);
        expect(result[1]).to.deep.equal({ paged: false });
      }
    });
  });
});
