import { expect } from 'chai';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Response } from 'express';
import type { Role } from '../../../src/abstract/plugin';
import supertest from 'supertest';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';
import type { SearchResult } from 'ldapts';

// Simple auth plugin for testing that sets user from X-Test-User header
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const testUser = req.headers['x-test-user'];
    if (testUser && typeof testUser === 'string') {
      req.user = testUser;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

describe('Authorization for Group Move', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let authzPlugin: AuthzPerBranch;
  let groupsPlugin: LdapGroups;
  let request: any;

  const getOrg1Dn = () => `ou=testorg1,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const getOrg2Dn = () => `ou=testorg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const getGroupDn = () => `cn=testgroup,${process.env.DM_LDAP_GROUP_BASE}`;

  before(async function () {
    this.timeout(10000);

    // Create test config with authorization rules
    const testConfig = {
      default: {
        read: false,
        write: false,
        delete: false,
      },
      users: {
        testuser1: {
          // Has read access to org1 and write access to org2
          [getOrg1Dn()]: {
            read: true,
            write: false,
            delete: false,
          },
          [getOrg2Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser2: {
          // Has write access to org1 but no access to org2
          [getOrg1Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser3: {
          // Has read/write access to both orgs
          [getOrg1Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
          [getOrg2Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser4: {
          // Has read access to org1 but no write access to org2
          [getOrg1Dn()]: {
            read: true,
            write: false,
            delete: false,
          },
          [getOrg2Dn()]: {
            read: true,
            write: false,
            delete: false,
          },
        },
      },
      groups: {},
    };

    // Set environment variables
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify(testConfig);
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    // Initialize server
    server = new DM();

    // Register auth plugin
    const authPlugin = new TestAuthPlugin(server);
    await server.registerPlugin('testAuth', authPlugin);

    // Register authz plugin
    authzPlugin = new AuthzPerBranch(server);
    await server.registerPlugin('authzPerBranch', authzPlugin);

    // Register groups plugin
    groupsPlugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groupsPlugin);

    // Setup API
    authPlugin.api(server.app);
    groupsPlugin.api(server.app);

    request = supertest(server.app);

    // Create test organizations
    await server.ldap.add(getOrg1Dn(), {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'testorg1',
      twakeDepartmentPath: 'Test Org 1',
    });
    await server.ldap.add(getOrg2Dn(), {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'testorg2',
      twakeDepartmentPath: 'Test Org 2',
    });
  });

  after(async () => {
    try {
      await server.ldap.delete(getOrg1Dn());
    } catch (e) {
      // ignore
    }
    try {
      await server.ldap.delete(getOrg2Dn());
    } catch (e) {
      // ignore
    }
  });

  beforeEach(async () => {
    // Create test group in org1
    await server.ldap.add(getGroupDn(), {
      objectClass: ['groupOfNames', 'twakeStaticGroup', 'top'],
      cn: 'testgroup',
      member: ['cn=fakeuser'],
      twakeDepartmentLink: getOrg1Dn(),
      twakeDepartmentPath: 'Test Org 1',
    });
  });

  afterEach(async () => {
    try {
      await server.ldap.delete(getGroupDn());
    } catch (e) {
      // ignore
    }
  });

  it('should allow move when user has read access to source and write access to destination', async () => {
    const res = await request
      .post('/api/v1/ldap/groups/testgroup/move')
      .set('X-Test-User', 'testuser1')
      .type('json')
      .send({
        targetOrgDn: getOrg2Dn(),
      });

    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ success: true });

    // Verify group was moved
    const group = await server.ldap.search(
      { paged: false, scope: 'base' },
      getGroupDn()
    );
    expect(
      (group as SearchResult).searchEntries[0].twakeDepartmentLink
    ).to.equal(getOrg2Dn());
  });

  it('should reject move when user lacks read access to source', async () => {
    const res = await request
      .post('/api/v1/ldap/groups/testgroup/move')
      .set('X-Test-User', 'testuser2')
      .type('json')
      .send({
        targetOrgDn: getOrg2Dn(),
      });

    expect(res.status).to.equal(500);
    expect(res.body.error).to.equal('check logs');
  });

  it('should reject move when user lacks write access to destination', async () => {
    const res = await request
      .post('/api/v1/ldap/groups/testgroup/move')
      .set('X-Test-User', 'testuser4')
      .type('json')
      .send({
        targetOrgDn: getOrg2Dn(),
      });

    expect(res.status).to.equal(500);
    expect(res.body.error).to.equal('check logs');
  });

  it('should allow move when user has full access', async () => {
    const res = await request
      .post('/api/v1/ldap/groups/testgroup/move')
      .set('X-Test-User', 'testuser3')
      .type('json')
      .send({
        targetOrgDn: getOrg2Dn(),
      });

    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ success: true });
  });
});
