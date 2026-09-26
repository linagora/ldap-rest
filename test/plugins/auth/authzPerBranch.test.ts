import { expect } from 'chai';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { DM } from '../../../src/bin';
import LdapOrganization from '../../../src/plugins/ldap/organizations';
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

// Use getters to ensure env vars are evaluated after setup
const getUserBranch = () => `ou=users,${process.env.DM_LDAP_BASE}`;
const getGroupDn = () =>
  `cn=authzperbranch,ou=groups,${process.env.DM_LDAP_BASE}`;
const getGroupMemberDn = () => `uid=groupmember,${getUserBranch()}`;
const getNonMemberDn = () => `uid=nonmember,${getUserBranch()}`;

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
          [getUserBranch() as string]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser2: {
          [getUserBranch() as string]: {
            read: true,
            write: false,
            delete: false,
          },
        },
      },
      groups: {
        [getGroupDn()]: {
          [getUserBranch()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
      },
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
        getUserBranch() as string
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
        getUserBranch() as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.true;
      expect(permissions.delete).to.be.false;
    });

    it('should return different permissions for different users', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'testuser2',
        getUserBranch() as string
      );
      expect(permissions.read).to.be.true;
      expect(permissions.write).to.be.false;
      expect(permissions.delete).to.be.false;
    });

    it('should support sub-branch permissions', async function () {
      this.timeout(5000);
      // Test that permissions apply to sub-branches
      const subBranch = `ou=test,${getUserBranch()}`;
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
      expect(branches).to.include(getUserBranch());
    });

    it('should return authorized branches for write permission', async function () {
      this.timeout(5000);
      const branches = await plugin.getAuthorizedBranchesForPermission(
        'testuser1',
        'write'
      );
      expect(branches).to.be.an('array');
      expect(branches).to.include(getUserBranch());
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

  describe('Group permissions', () => {
    beforeEach(async function () {
      this.timeout(5000);
      await server.ldap.add(getGroupMemberDn(), {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'groupmember',
        sn: 'Member',
        cn: 'Group Member',
      });
      await server.ldap.add(getNonMemberDn(), {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'nonmember',
        sn: 'Member',
        cn: 'Non Member',
      });
      await server.ldap.add(getGroupDn(), {
        objectClass: ['top', 'groupOfNames'],
        cn: 'authzperbranch',
        member: [getGroupMemberDn()],
      });
    });

    afterEach(async function () {
      this.timeout(5000);
      try {
        await server.ldap.delete(getGroupDn());
      } catch (err) {
        // Ignore
      }
      try {
        await server.ldap.delete(getGroupMemberDn());
      } catch (err) {
        // Ignore
      }
      try {
        await server.ldap.delete(getNonMemberDn());
      } catch (err) {
        // Ignore
      }
    });

    it('finds the groups a caller belongs to', async function () {
      this.timeout(5000);
      expect(await plugin.getUserGroups('groupmember')).to.include(
        getGroupDn()
      );
    });

    it('applies the permissions of a group the caller belongs to', async function () {
      this.timeout(5000);
      const permissions = await plugin.getUserPermissions(
        'groupmember',
        getUserBranch()
      );
      expect(permissions).to.deep.equal({
        read: true,
        write: true,
        delete: false,
      });
    });

    it('finds no group for a user who is not a member', async function () {
      this.timeout(5000);
      expect(await plugin.getUserGroups('nonmember')).to.deep.equal([]);
    });

    it('finds no group for a uid that does not resolve', async function () {
      this.timeout(5000);
      expect(await plugin.getUserGroups('nobody')).to.deep.equal([]);
    });
  });

  describe('Group rules', () => {
    const base = () => process.env.DM_LDAP_BASE as string;
    const alpha = () => `ou=alpha,${base()}`;
    const beta = () => `ou=beta,${base()}`;
    const groupA = () => `cn=authzpba,ou=groups,${base()}`;
    const groupB = () => `cn=authzpbb,ou=groups,${base()}`;
    const userDn = () => `uid=grpuser,${getUserBranch()}`;
    // Same uid, another entry: what a directory without the unique overlay
    // lets through.
    const homonymDn = () => `uid=grpuser,${base()}`;
    // groupOfNames needs a member left once the user is removed.
    const filler = () => `uid=filler,${getUserBranch()}`;
    const none = { read: false, write: false, delete: false };

    let savedConfig: typeof plugin.authConfig;

    beforeEach(async function () {
      this.timeout(5000);
      savedConfig = plugin.authConfig;
      plugin.authConfig = {
        default: none,
        users: {
          grpuser: { [alpha()]: { read: true, write: false, delete: false } },
        },
        groups: {
          [groupA()]: {
            [alpha()]: { read: true, write: true, delete: false },
            [beta()]: { read: true, write: false, delete: false },
          },
          // Spelled otherwise than the directory answers: case, and a space
          // after each comma.
          [`CN=AuthzPbB, OU=Groups, ${base().toUpperCase().replace(/,/g, ', ')}`]:
            { [beta()]: { read: false, write: false, delete: true } },
        },
      };
      await server.ldap.add(userDn(), {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'grpuser',
        sn: 'User',
        cn: 'Group User',
      });
      await server.ldap.add(groupA(), {
        objectClass: ['top', 'groupOfNames'],
        cn: 'authzpba',
        member: [userDn(), filler()],
      });
      await server.ldap.add(groupB(), {
        objectClass: ['top', 'groupOfNames'],
        cn: 'authzpbb',
        member: [userDn(), filler()],
      });
    });

    afterEach(async function () {
      this.timeout(5000);
      plugin.authConfig = savedConfig;
      for (const dn of [groupA(), groupB(), userDn(), homonymDn()]) {
        try {
          await server.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
      delete (plugin as unknown as Record<string, unknown>).findUserDn;
      plugin.forgetGroups();
    });

    /** Replace the DN lookup on this instance only. */
    const stubFindUserDn = (
      fn: (
        original: (uid: string) => Promise<string | null>,
        uid: string
      ) => Promise<string | null>
    ): void => {
      const original = plugin['findUserDn'].bind(plugin);
      (plugin as unknown as Record<string, unknown>).findUserDn = (
        uid: string
      ) => fn(original, uid);
    };

    it('lists a branch granted by a group only, and a shared one once', async function () {
      this.timeout(5000);
      const read = await plugin.getAuthorizedBranchesForPermission(
        'grpuser',
        'read'
      );
      expect(read).to.have.members([alpha(), beta()]);
      expect(read.filter(b => b === alpha())).to.have.lengthOf(1);
      expect(
        await plugin.getAuthorizedBranchesForPermission('grpuser', 'write')
      ).to.deep.equal([alpha()]);
    });

    it('merges the rules of two groups', async function () {
      this.timeout(5000);
      expect(await plugin.getUserPermissions('grpuser', beta())).to.deep.equal({
        read: true,
        write: false,
        delete: true,
      });
    });

    it('merges a user rule and a group rule on one branch', async function () {
      this.timeout(5000);
      expect(await plugin.getUserPermissions('grpuser', alpha())).to.deep.equal(
        { read: true, write: true, delete: false }
      );
    });

    it('matches a group configured with another spelling of its DN', async function () {
      this.timeout(5000);
      expect(
        await plugin.getAuthorizedBranchesForPermission('grpuser', 'delete')
      ).to.deep.equal([beta()]);
    });

    it('grants no group to a uid naming two entries, and keeps its user rule', async function () {
      this.timeout(5000);
      await server.ldap.add(homonymDn(), {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'grpuser',
        sn: 'Homonym',
        cn: 'Group User Homonym',
      });
      // A member too, so that picking either entry would find a group.
      await server.ldap.modify(groupA(), { add: { member: homonymDn() } });
      expect(await plugin.getUserGroups('grpuser')).to.deep.equal([]);
      expect(await plugin.getUserPermissions('grpuser', alpha())).to.deep.equal(
        { read: true, write: false, delete: false }
      );
    });

    it('forgets a membership as soon as it is removed, not after the TTL', async function () {
      this.timeout(5000);
      expect(await plugin.getUserGroups('grpuser')).to.include(groupA());
      await server.ldap.modify(groupA(), { delete: { member: userDn() } });
      // The done hooks are launched without being awaited.
      await new Promise(resolve => setImmediate(resolve));
      expect(await plugin.getUserGroups('grpuser')).to.not.include(groupA());
    });

    it('keeps the cache across a modify that touches no membership', async function () {
      this.timeout(5000);
      await plugin.getUserGroups('grpuser');
      await server.ldap.modify(userDn(), { replace: { sn: 'Renamed' } });
      await new Promise(resolve => setImmediate(resolve));
      expect(plugin.groupCache.has('grpuser')).to.be.true;
    });

    it('forgets the cache when a modify touches the attribute users are found by', async function () {
      this.timeout(5000);
      await plugin.getUserGroups('grpuser');
      // A second value: the first one is the RDN and cannot be replaced.
      const attr = plugin.config.ldap_user_main_attribute || 'uid';
      await server.ldap.modify(userDn(), { add: { [attr]: 'grpuser2' } });
      await new Promise(resolve => setImmediate(resolve));
      expect(plugin.groupCache.has('grpuser')).to.be.false;
    });

    it('shares one lookup between concurrent misses', async function () {
      this.timeout(5000);
      let calls = 0;
      stubFindUserDn((original, uid) => {
        calls++;
        return original(uid);
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => plugin.getUserGroups('grpuser'))
      );
      expect(calls).to.equal(1);
      for (const groups of results) expect(groups).to.include(groupA());
    });

    it('does not cache a failed lookup', async function () {
      this.timeout(5000);
      let failed = false;
      stubFindUserDn((original, uid) => {
        if (failed) return original(uid);
        failed = true;
        return Promise.reject(new Error('directory unavailable'));
      });
      let caught: unknown;
      try {
        await plugin.getUserGroups('grpuser');
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(plugin.groupCache.has('grpuser')).to.be.false;
      expect(await plugin.getUserGroups('grpuser')).to.include(groupA());
    });

    it('does not cache what a lookup overtaken by a write read', async function () {
      this.timeout(5000);
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      stubFindUserDn(async (original, uid) => {
        await gate;
        return original(uid);
      });
      const lookup = plugin.getUserGroups('grpuser');
      plugin.forgetGroups();
      release();
      expect(await lookup).to.include(groupA());
      expect(plugin.groupCache.has('grpuser')).to.be.false;
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
            getUserBranch() as string,
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
          getUserBranch() as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(getUserBranch());
        // When searching within authorized branch, filter should not be modified
        expect(result[1]).to.not.be.undefined;
      }
    });

    it('should refuse to move an entry out of an organization the caller cannot read', async function () {
      // The source check used to throw inside the `try` whose `catch` was
      // meant for a failed search, so its own refusal was caught and the
      // parent branch — readable here — judged instead: the entry moved.
      this.timeout(5000);
      const previousLink = server.config.ldap_organization_link_attribute;
      const linkAttr = previousLink || 'twakeDepartmentLink';
      server.config.ldap_organization_link_attribute = linkAttr;
      const entryDn = `uid=moved,${getUserBranch()}`;
      const secretOrg = `ou=secret,${process.env.DM_LDAP_BASE}`;
      const search = server.ldap.search;
      server.ldap.search = (async (_opts: unknown, base: string) =>
        base === entryDn
          ? { searchEntries: [{ dn: entryDn, [linkAttr]: secretOrg }] }
          : { searchEntries: [] }) as unknown as typeof search;
      try {
        let refused: Error | undefined;
        await plugin.hooks!.ldapmodifyrequest!([
          entryDn,
          { replace: { [linkAttr]: getUserBranch() } },
          0,
          { user: 'testuser1' } as DmRequest,
        ]).catch((err: Error) => {
          refused = err;
        });
        expect(refused, 'refused').to.be.instanceOf(Error);
        expect(refused!.message).to.include(
          `read permission for source branch ${secretOrg}`
        );
      } finally {
        server.ldap.search = search;
        server.config.ldap_organization_link_attribute = previousLink;
      }
    });

    it('should pass through when no user in request', async function () {
      this.timeout(5000);
      const mockReq = {} as any;
      if (plugin.hooks?.ldapsearchrequest) {
        const result = await plugin.hooks.ldapsearchrequest([
          getUserBranch() as string,
          { paged: false },
          mockReq,
        ]);

        expect(result[0]).to.equal(getUserBranch());
        expect(result[1]).to.deep.equal({ paged: false });
      }
    });
  });

  describe('API access control', () => {
    const getTestOrgDn = () =>
      `ou=TestOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const getTestOrg2Dn = () =>
      `ou=TestOrg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const getTestSubOrg1Dn = () => `ou=SubOrg1,${getTestOrgDn()}`;
    const getTestSubOrg2Dn = () => `ou=SubOrg2,${getTestOrg2Dn()}`;
    const getTestUser1Dn = () =>
      `uid=testuser1,ou=users,${process.env.DM_LDAP_BASE}`;
    const getTestUser2Dn = () =>
      `uid=testuser2,ou=users,${process.env.DM_LDAP_BASE}`;
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
            [getTestOrgDn()]: {
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
        await apiServer.ldap.delete(getTestUser1Dn());
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(getTestUser2Dn());
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(getTestSubOrg1Dn());
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(getTestSubOrg2Dn());
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(getTestOrgDn());
      } catch (err) {
        // Ignore
      }
      try {
        await apiServer.ldap.delete(getTestOrg2Dn());
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
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 (NOT authorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2',
        };
        await apiServer.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to get unauthorized org via API - should fail
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(getTestOrg2Dn())}`
          )
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(403);
        expect(res.body).to.have.property('error');
        expect(res.body.error).to.equal(
          'Token does not have permission on this branch'
        );
      });

      it('should allow search in authorized branch', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized for testuser1)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Try to get authorized org via API - should succeed
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(getTestOrgDn())}`
          )
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('dn', getTestOrgDn());
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
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2',
        };
        await apiServer.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to add a sub-org under unauthorized org2 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .type('json')
          .send({
            ou: 'SubOrg2',
            parentDn: getTestOrg2Dn(),
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
            getTestSubOrg2Dn()
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
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Try to add a sub-org under authorized org1 via API
        const res = await request
          .post('/api/v1/ldap/organizations')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Test-User', 'testuser1')
          .type('json')
          .send({
            ou: 'SubOrg1',
            parentDn: getTestOrgDn(),
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
          getTestSubOrg1Dn()
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
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Create user with twakeDepartmentLink pointing to authorized org
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser1',
          sn: 'User1',
          cn: 'Test User 1',
          twakeDepartmentLink: [getTestOrgDn()],
        };

        const mockReq = { user: 'testuser1' } as any;

        // This should succeed
        await apiServer.ldap.add(getTestUser1Dn(), newUserEntry, mockReq);

        // Verify it was written
        const searchResult = await apiServer.ldap.search(
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
      });

      it('should reject adding a user if twakeDepartmentLink points to unauthorized org', async function () {
        this.timeout(5000);

        // Create organization 1 (authorized)
        const org1Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg',
          twakeDepartmentPath: 'TestOrg',
        };
        await apiServer.ldap.add(getTestOrgDn(), org1Entry);

        // Create organization 2 (unauthorized)
        const org2Entry = {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'TestOrg2',
          twakeDepartmentPath: 'TestOrg2',
        };
        await apiServer.ldap.add(getTestOrg2Dn(), org2Entry);

        // Try to create user with twakeDepartmentLink pointing to unauthorized org
        const newUserEntry = {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          uid: 'testuser2',
          sn: 'User2',
          cn: 'Test User 2',
          twakeDepartmentLink: [getTestOrg2Dn()], // UNAUTHORIZED
        };

        const mockReq = { user: 'testuser1' } as any;

        // This should be rejected
        try {
          await apiServer.ldap.add(getTestUser2Dn(), newUserEntry, mockReq);
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
