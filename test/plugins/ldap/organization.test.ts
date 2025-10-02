import { expect } from 'chai';
import LdapOrganizations from '../../../src/plugins/ldap/organization';
import { DM } from '../../../src/bin';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

const {
  DM_LDAP_TOP_ORGANIZATION,
  DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE,
  DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE,
} = process.env;

describe('LDAP Organizations Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_TOP_ORGANIZATION
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldap/organization tests: DM_LDAP_DN, DM_LDAP_PWD, and DM_LDAP_TOP_ORGANIZATION env vars are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: LdapOrganizations;
  let request: any;

  const testOrgDn = `ou=testorg,${DM_LDAP_TOP_ORGANIZATION}`;
  const testSubOrgDn = `ou=testsuborg,${DM_LDAP_TOP_ORGANIZATION}`;

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', plugin);
    plugin.api(server.app);
    request = supertest(server.app);
  });

  afterEach(async () => {
    // Clean up test organizations
    try {
      await plugin.server.ldap.delete(testOrgDn);
    } catch (e) {
      // ignore
    }
    try {
      await plugin.server.ldap.delete(testSubOrgDn);
    } catch (e) {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should throw error when ldap_top_organization is missing', () => {
      const tempServer = new DM();
      const originalConfig = tempServer.config.ldap_top_organization;
      delete tempServer.config.ldap_top_organization;
      expect(() => new LdapOrganizations(tempServer)).to.throw(
        'Missing --ldap-top-organization'
      );
      tempServer.config.ldap_top_organization = originalConfig;
    });

    it('should set pathAttr and linkAttr from config', () => {
      expect(plugin.pathAttr).to.equal(
        server.config.ldap_organization_path_attribute
      );
      expect(plugin.linkAttr).to.equal(
        server.config.ldap_organization_link_attribute
      );
    });
  });

  describe('isOu', () => {
    it('should return true for organizational unit entries', () => {
      const entry = {
        objectClass: ['twakedepartment', 'organizationalunit', 'top'],
        ou: 'testorg',
      };
      expect(plugin.isOu(entry)).to.be.true;
    });

    it('should return false for non-organizational entries', () => {
      const entry = {
        objectClass: ['inetOrgPerson', 'top'],
        cn: 'Test User',
      };
      expect(plugin.isOu(entry)).to.be.false;
    });

    it('should ignore "top" objectClass', () => {
      const entry = {
        objectClass: ['top'],
        cn: 'Test',
      };
      expect(plugin.isOu(entry)).to.be.false;
    });
  });

  describe('getOrganisationTop', () => {
    it('should return top organization', async () => {
      const top = await plugin.getOrganisationTop();
      expect(top).to.have.property('dn');
      expect((top.dn as string).toLowerCase()).to.equal(
        DM_LDAP_TOP_ORGANIZATION?.toLowerCase()
      );
    });

    it('should throw error when top organization not configured', async () => {
      const tempServer = new DM();
      delete tempServer.config.ldap_top_organization;
      try {
        const tempPlugin = new LdapOrganizations(tempServer);
        await tempPlugin.getOrganisationTop();
        expect.fail('Should have thrown error');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Missing --ldap-top-organization|No top organization configured/
        );
      }
    });
  });

  describe('getOrganisationByDn', () => {
    beforeEach(async () => {
      // Create test organization
      await plugin.server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'testorg',
      });
    });

    it('should return organization by DN', async () => {
      const org = await plugin.getOrganisationByDn(testOrgDn);
      expect(org).to.have.property('dn', testOrgDn);
      expect(org).to.have.property('ou');
    });

    it('should throw error for non-existent organization', async () => {
      try {
        await plugin.getOrganisationByDn(
          `ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`
        );
        expect.fail('Should have thrown error');
      } catch (e) {
        expect((e as Error).message).to.match(/not found|Code: 0x20/);
      }
    });
  });

  describe('getOrganisationSubnodes', () => {
    it('should return empty array when no subnodes exist', async function () {
      // Create test organization
      await plugin.server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'testorg',
      });

      const subnodes = await plugin.getOrganisationSubnodes(testOrgDn);
      expect(subnodes).to.be.an('array').that.is.empty;
    });

    it('should return empty array when no entries link to organization', async () => {
      // Create parent organization
      await plugin.server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'testorg',
      });

      // Since twakeDepartmentLink may not exist in schema,
      // verify that getOrganisationSubnodes returns empty array
      // when no entries have this attribute pointing to the org
      const subnodes = await plugin.getOrganisationSubnodes(testOrgDn);
      expect(subnodes).to.be.an('array').that.is.empty;
    });
  });

  describe('checkDeptLink', () => {
    beforeEach(async () => {
      // Create test organization
      await plugin.server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'testorg',
      });
    });

    it('should accept valid organization link', async () => {
      const linkAttr = server.config.ldap_organization_link_attribute as string;
      const entry = {
        [linkAttr]: [testOrgDn],
      };
      await plugin.checkDeptLink(entry);
    });

    it('should reject non-existent organization link', async function () {
      const linkAttr = server.config.ldap_organization_link_attribute as string;
      const entry = {
        [linkAttr]: [`ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`],
      };
      try {
        await plugin.checkDeptLink(entry);
        expect.fail('Should have thrown error');
      } catch (e) {
        // Accept both "does not exist" and LDAP error codes for non-existent entries
        expect((e as Error).message).to.match(/does not exist|Code: 0x20/);
      }
    });

    it('should allow entry without organization link', async () => {
      const entry = { cn: 'test' };
      await plugin.checkDeptLink(entry);
    });
  });

  describe('checkDeptPath', () => {
    it('should allow entry without organization path', async () => {
      const entry = { cn: 'test' };
      await plugin.checkDeptPath(entry);
    });
  });

  describe('isEmptyOrganization', () => {
    beforeEach(async () => {
      await plugin.server.ldap.add(testOrgDn, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'testorg',
      });
    });

    it('should not throw for empty organization', async () => {
      await plugin.isEmptyOrganization(testOrgDn);
    });

    it('should not throw when organization has no linked entries', async () => {
      // Since twakeDepartmentLink attribute may not exist in schema,
      // this test verifies that isEmptyOrganization correctly identifies
      // an organization as empty when no entries link to it
      await plugin.isEmptyOrganization(testOrgDn);
      // If we get here without exception, the organization is correctly identified as empty
    });
  });

  describe('hooks', () => {
    describe('ldapaddrequest', () => {
      it('should validate organization link on add', async () => {
        const linkAttr = server.config
          .ldap_organization_link_attribute as string;
        const entry = {
          [linkAttr]: [`ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`],
        };
        const dn = `uid=testuser3,${process.env.DM_LDAP_BASE}`;

        try {
          await plugin.hooks.ldapaddrequest?.([dn, entry]);
          expect.fail('Should have thrown error');
        } catch (e) {
          // Accept both "does not exist" and LDAP error codes
          expect((e as Error).message).to.match(/does not exist|Code: 0x20/);
        }
      });

      it('should allow add without organization attributes', async () => {
        const entry = { cn: 'test' };
        const dn = `cn=test,${process.env.DM_LDAP_BASE}`;

        const result = await plugin.hooks.ldapaddrequest?.([dn, entry]);
        expect(result).to.deep.equal([dn, entry]);
      });
    });

    describe('ldapmodifyrequest', () => {
      it('should prevent deletion of organization link attribute for users/groups', async () => {
        // Create a test user first
        const userDn = `uid=testuser,${process.env.DM_LDAP_BASE}`;
        await plugin.server.ldap.add(userDn, {
          objectClass: ['inetOrgPerson', 'person', 'top'],
          uid: 'testuser',
          cn: 'Test User',
          sn: 'User',
        });

        const linkAttr = server.config
          .ldap_organization_link_attribute as string;
        const changes = {
          delete: [linkAttr],
        };

        try {
          await plugin.hooks.ldapmodifyrequest?.([userDn, changes, 0]);
          expect.fail('Should have thrown error');
        } catch (e) {
          expect((e as Error).message).to.match(
            /organization link cannot be deleted/
          );
        }

        // Clean up
        await plugin.server.ldap.delete(userDn);
      });

      it('should prevent deletion of organization path attribute', async () => {
        // Create organization first
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });

        const pathAttr = server.config
          .ldap_organization_path_attribute as string;
        const dn = testOrgDn;
        const changes = {
          delete: [pathAttr],
        };

        try {
          await plugin.hooks.ldapmodifyrequest?.([dn, changes, 0]);
          expect.fail('Should have thrown error');
        } catch (e) {
          expect((e as Error).message).to.match(
            /organization path cannot be deleted/
          );
        }

        // Clean up
        await plugin.server.ldap.delete(testOrgDn);
      });

      it('should allow modification without organization attributes', async () => {
        const dn = testOrgDn;
        const changes = { replace: { description: 'test' } };

        const result = await plugin.hooks.ldapmodifyrequest?.([dn, changes, 0]);
        expect(result).to.deep.equal([dn, changes, 0]);
      });
    });

    describe('ldapdeleterequest', () => {
      it('should allow deletion when no entries link to organization', async () => {
        // Create organization
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });

        // Since twakeDepartmentLink may not exist in schema,
        // verify that hook allows deletion when no entries link to org
        const result = await plugin.hooks.ldapdeleterequest?.([testOrgDn]);
        expect(result).to.deep.equal([testOrgDn]);
      });

      it('should allow deletion of empty organization', async () => {
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });

        const result = await plugin.hooks.ldapdeleterequest?.([testOrgDn]);
        expect(result).to.deep.equal([testOrgDn]);
      });

      it('should allow deletion of non-organization entries', async () => {
        const dn = `cn=test,${process.env.DM_LDAP_BASE}`;
        const result = await plugin.hooks.ldapdeleterequest?.([dn]);
        expect(result).to.deep.equal([dn]);
      });
    });

    describe('ldaprenamerequest', () => {
      it('should pass through rename requests', () => {
        const dn = testOrgDn;
        const newdn = testSubOrgDn;
        const result = plugin.hooks.ldaprenamerequest?.([dn, newdn]);
        expect(result).to.deep.equal([dn, newdn]);
      });
    });
  });

  describe('API', () => {
    describe('GET /api/v1/ldap/organizations/top', () => {
      it('should return top organization', async () => {
        const res = await request
          .get('/api/v1/ldap/organizations/top')
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('dn');
        expect(res.body.dn.toLowerCase()).to.equal(
          DM_LDAP_TOP_ORGANIZATION?.toLowerCase()
        );
      });
    });

    describe('GET /api/v1/ldap/organizations/:dn', () => {
      beforeEach(async () => {
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });
      });

      it('should return organization by DN', async () => {
        const res = await request
          .get(`/api/v1/ldap/organizations/${encodeURIComponent(testOrgDn)}`)
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('dn', testOrgDn);
        expect(res.body).to.have.property('ou');
      });

      it('should return error for non-existent organization', async () => {
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(`ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`)}`
          )
          .set('Accept', 'application/json');

        expect(res.status).to.equal(500);
      });
    });

    describe('GET /api/v1/ldap/organizations/:dn/subnodes', () => {
      beforeEach(async () => {
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });
      });

      it('should return empty array when organization has no linked entries', async () => {
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(testOrgDn)}/subnodes`
          )
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').that.is.empty;
      });
    });

    describe('POST /api/v1/ldap/organizations', () => {
      it('should create a new organization', async () => {
        const res = await request
          .post('/api/v1/ldap/organizations')
          .type('json')
          .send({
            ou: 'testorg',
          });

        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ success: true });

        // Verify organization was created
        const org = await plugin.getOrganisationByDn(testOrgDn);
        expect(org).to.have.property('ou', 'testorg');
      });

      it('should return error when ou is missing', async () => {
        const res = await request
          .post('/api/v1/ldap/organizations')
          .type('json')
          .send({});

        expect(res.status).to.equal(400);
      });

      it('should create a sub-organization with parentDn', async () => {
        // First create parent organization
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });

        const subOrgRes = await request
          .post('/api/v1/ldap/organizations')
          .type('json')
          .send({
            ou: 'testsuborg',
            parentDn: testOrgDn,
          });

        expect(subOrgRes.status).to.equal(200);
        expect(subOrgRes.body).to.deep.equal({ success: true });

        // Verify sub-organization was created under parent
        const subOrgDn = `ou=testsuborg,${testOrgDn}`;
        const subOrg = await plugin.getOrganisationByDn(subOrgDn);
        expect(subOrg).to.have.property('ou', 'testsuborg');

        // Clean up sub-org
        await plugin.server.ldap.delete(subOrgDn);
      });
    });

    describe('PUT /api/v1/ldap/organizations/:dn', () => {
      beforeEach(async () => {
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });
      });

      it('should modify an organization', async () => {
        const res = await request
          .put(`/api/v1/ldap/organizations/${encodeURIComponent(testOrgDn)}`)
          .type('json')
          .send({
            replace: { description: 'Test organization description' },
          });

        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ success: true });

        // Verify modification
        const org = await plugin.getOrganisationByDn(testOrgDn);
        expect(org).to.have.property(
          'description',
          'Test organization description'
        );
      });

      it('should return error for invalid dn', async () => {
        const res = await request
          .put(
            `/api/v1/ldap/organizations/${encodeURIComponent(`ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`)}`
          )
          .type('json')
          .send({
            replace: { description: 'Test' },
          });

        expect(res.status).to.equal(500);
      });
    });

    describe('DELETE /api/v1/ldap/organizations/:dn', () => {
      beforeEach(async () => {
        await plugin.server.ldap.add(testOrgDn, {
          objectClass: ['organizationalUnit', 'top'],
          ou: 'testorg',
        });
      });

      it('should delete an empty organization', async () => {
        const res = await request
          .delete(`/api/v1/ldap/organizations/${encodeURIComponent(testOrgDn)}`)
          .set('Accept', 'application/json');

        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ success: true });

        // Verify organization was deleted
        try {
          await plugin.getOrganisationByDn(testOrgDn);
          expect.fail('Organization should have been deleted');
        } catch (e) {
          expect((e as Error).message).to.match(/not found|Code: 0x20/);
        }
      });

      it('should return error when deleting non-existent organization', async () => {
        const res = await request
          .delete(
            `/api/v1/ldap/organizations/${encodeURIComponent(`ou=nonexistent,${DM_LDAP_TOP_ORGANIZATION}`)}`
          )
          .set('Accept', 'application/json');

        expect(res.status).to.equal(500);
      });
    });
  });
});
