import { expect } from 'chai';
import supertest from 'supertest';
import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organization';

describe('GET APIs for individual entities', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_GROUP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping GET API tests: LDAP credentials and DM_LDAP_GROUP_BASE are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let flatPlugin: LdapFlatGeneric;
  let groupsPlugin: LdapGroups;
  let orgPlugin: LdapOrganizations;
  let request: any;

  before(async function () {
    this.timeout(5000);
    process.env.DM_LDAP_FLAT_SCHEMA =
      './static/schemas/twake/nomenclature/twakeTitle.json';
    server = new DM();
    await server.ready;

    flatPlugin = new LdapFlatGeneric(server);
    await server.registerPlugin('ldapFlatGeneric', flatPlugin);

    groupsPlugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groupsPlugin);

    if (process.env.DM_LDAP_TOP_ORGANIZATION) {
      orgPlugin = new LdapOrganizations(server);
      await server.registerPlugin('ldapOrganizations', orgPlugin);
    }

    request = supertest(server.app);
  });

  describe('Flat entities GET', () => {
    it('should get title by simple id', async () => {
      const res = await request.get('/api/v1/ldap/titles/Dr');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('cn', 'Dr');
      expect(res.body).to.have.property('dn');
    });

    it('should get title by full DN', async () => {
      const dn = `cn=Dr,ou=twakeTitle,ou=nomenclature,${process.env.DM_LDAP_BASE}`;
      const encodedDn = encodeURIComponent(dn);
      const res = await request.get(`/api/v1/ldap/titles/${encodedDn}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('cn', 'Dr');
      expect(res.body).to.have.property('dn', dn);
    });

    it('should return 404 for non-existent title', async () => {
      const res = await request.get('/api/v1/ldap/titles/NonExistentTitle');
      expect(res.status).to.equal(404);
      expect(res.body).to.have.property('error');
    });
  });

  describe('Groups GET', () => {
    let testGroupCn: string;
    let testGroupDn: string;

    before(async function () {
      this.timeout(5000);
      // Find an existing group to use for testing
      const groups = await groupsPlugin.listGroups();
      const groupNames = Object.keys(groups).filter(
        name => name && name.length > 0
      );
      if (groupNames.length === 0) {
        throw new Error('No groups found in LDAP for testing');
      }
      testGroupCn = groupNames[0];
      testGroupDn = groups[testGroupCn].dn as string;
    });

    it('should get group by simple cn', async () => {
      const res = await request.get(`/api/v1/ldap/groups/${testGroupCn}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('dn');
      // Check that the DN contains the cn we looked for
      expect((res.body.dn as string).toLowerCase()).to.include(
        testGroupCn.toLowerCase()
      );
    });

    it('should get group by full DN', async () => {
      const encodedDn = encodeURIComponent(testGroupDn);
      const res = await request.get(`/api/v1/ldap/groups/${encodedDn}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('dn', testGroupDn);
    });

    it('should return 404 for non-existent group', async () => {
      const res = await request.get('/api/v1/ldap/groups/nonexistent-group');
      expect(res.status).to.equal(404);
      expect(res.body).to.have.property('error');
    });
  });

  describe('Organizations GET and subnodes', function () {
    if (!process.env.DM_LDAP_TOP_ORGANIZATION) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping organizations tests: DM_LDAP_TOP_ORGANIZATION not set'
      );
      // @ts-ignore
      this.skip?.();
      return;
    }

    it('should get top organization', async () => {
      const res = await request.get('/api/v1/ldap/organizations/top');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('dn');
    });

    it('should get organization by DN', async () => {
      const topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      const encodedDn = encodeURIComponent(topOrg);
      const res = await request.get(`/api/v1/ldap/organizations/${encodedDn}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('dn');
    });

    it('should get organization subnodes', async () => {
      const topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      const encodedDn = encodeURIComponent(topOrg);
      const res = await request.get(
        `/api/v1/ldap/organizations/${encodedDn}/subnodes`
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
      // Should contain users, groups, or sub-organizations with link attribute
    });

    it('should return error for non-existent organization', async () => {
      const fakeDn = 'ou=nonexistent,dc=example,dc=com';
      const encodedDn = encodeURIComponent(fakeDn);
      const res = await request.get(`/api/v1/ldap/organizations/${encodedDn}`);
      expect(res.status).to.equal(500);
    });
  });
});
