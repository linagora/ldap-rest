import { expect } from 'chai';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organization';
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

describe('Authorization for Organization Move', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let authzPlugin: AuthzPerBranch;
  let orgPlugin: LdapOrganizations;
  let request: any;

  const getParentOrg1Dn = () => `ou=parent1,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const getParentOrg2Dn = () => `ou=parent2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const getChildOrgDn = () => `ou=child,${getParentOrg1Dn()}`;

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
          // Has read access to parent1 and write access to parent2
          [getParentOrg1Dn()]: {
            read: true,
            write: false,
            delete: false,
          },
          [getParentOrg2Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser2: {
          // Has write access to parent1 but no access to parent2
          [getParentOrg1Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
        },
        testuser3: {
          // Has read/write access to both parents
          [getParentOrg1Dn()]: {
            read: true,
            write: true,
            delete: false,
          },
          [getParentOrg2Dn()]: {
            read: true,
            write: true,
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

    // Register organizations plugin
    orgPlugin = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', orgPlugin);

    // Setup API
    authPlugin.api(server.app);
    orgPlugin.api(server.app);

    request = supertest(server.app);

    // Create test parent organizations
    await server.ldap.add(getParentOrg1Dn(), {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'parent1',
    });
    await server.ldap.add(getParentOrg2Dn(), {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'parent2',
    });
  });

  after(async () => {
    try {
      await server.ldap.delete(getParentOrg1Dn());
    } catch (e) {
      // ignore
    }
    try {
      await server.ldap.delete(getParentOrg2Dn());
    } catch (e) {
      // ignore
    }
  });

  beforeEach(async () => {
    // Create test child organization under parent1
    await server.ldap.add(getChildOrgDn(), {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'child',
      twakeDepartmentPath: 'child / parent1',
    });
  });

  afterEach(async () => {
    try {
      // Try both possible locations
      await server.ldap.delete(getChildOrgDn());
    } catch (e) {
      // ignore
    }
    try {
      const movedChildDn = `ou=child,${getParentOrg2Dn()}`;
      await server.ldap.delete(movedChildDn);
    } catch (e) {
      // ignore
    }
  });

  it('should allow move when user has read access to source and write access to destination', async () => {
    const res = await request
      .post(`/api/v1/ldap/organizations/${encodeURIComponent(getChildOrgDn())}/move`)
      .set('X-Test-User', 'testuser1')
      .type('json')
      .send({
        targetOrgDn: getParentOrg2Dn(),
      });

    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('newDn');

    // Verify organization was moved
    const movedChildDn = `ou=child,${getParentOrg2Dn()}`;
    const org = await server.ldap.search(
      { paged: false, scope: 'base' },
      movedChildDn
    );
    expect((org as SearchResult).searchEntries[0].dn).to.equal(movedChildDn);
  });

  it('should reject move when user lacks read access to source', async () => {
    const res = await request
      .post(`/api/v1/ldap/organizations/${encodeURIComponent(getChildOrgDn())}/move`)
      .set('X-Test-User', 'testuser2')
      .type('json')
      .send({
        targetOrgDn: getParentOrg2Dn(),
      });

    expect(res.status).to.equal(500);
    expect(res.body.error).to.equal('check logs');
  });

  it('should reject move when user lacks write access to destination', async () => {
    // testuser1 has read on parent1 but no write, so moving within parent1 should fail
    const siblingOrgDn = `ou=sibling,${getParentOrg1Dn()}`;
    await server.ldap.add(siblingOrgDn, {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'sibling',
      twakeDepartmentPath: 'sibling / parent1',
    });

    try {
      const res = await request
        .post(
          `/api/v1/ldap/organizations/${encodeURIComponent(getChildOrgDn())}/move`
        )
        .set('X-Test-User', 'testuser1')
        .type('json')
        .send({
          targetOrgDn: siblingOrgDn,
        });

      expect(res.status).to.equal(500);
      expect(res.body.error).to.equal('check logs');
    } finally {
      await server.ldap.delete(siblingOrgDn);
    }
  });

  it('should allow move when user has full access', async () => {
    const res = await request
      .post(`/api/v1/ldap/organizations/${encodeURIComponent(getChildOrgDn())}/move`)
      .set('X-Test-User', 'testuser3')
      .type('json')
      .send({
        targetOrgDn: getParentOrg2Dn(),
      });

    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('newDn');
  });
});
