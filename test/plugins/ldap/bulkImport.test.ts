import { expect } from 'chai';
import { DM } from '../../../src/bin';
import LdapBulkImport from '../../../src/plugins/ldap/bulkImport';
import supertest from 'supertest';
import fs from 'fs';
import path from 'path';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('LDAP Bulk Import Plugin', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let plugin: LdapBulkImport;
  let request: any;

  const testOrg1Dn = `ou=TestOrg1,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
  const testOrg2Dn = `ou=TestOrg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;

  before(async function () {
    this.timeout(10000);

    // Create test schema
    const testSchemaPath = path.join(
      __dirname,
      '../../fixtures/bulk-import-schema.json'
    );
    const testSchema = {
      base: process.env.DM_LDAP_BASE,
      mainAttribute: 'uid',
      properties: {
        objectClass: {
          type: 'array',
          fixed: true,
          default: ['top', 'twakeAccount', 'twakeWhitePages'],
        },
        uid: {
          type: 'string',
          required: true,
        },
        cn: {
          type: 'string',
          required: true,
        },
        sn: {
          type: 'string',
          required: true,
        },
        givenName: {
          type: 'string',
        },
        mail: {
          type: 'string',
        },
        userPassword: {
          type: 'string',
        },
        twakeDepartmentLink: {
          type: 'string',
          role: ['organizationLink'],
        },
        twakeDepartmentPath: {
          type: 'string',
          role: ['organizationPath'],
        },
      },
    };

    // Ensure fixtures directory exists
    const fixturesDir = path.join(__dirname, '../../fixtures');
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
    fs.writeFileSync(testSchemaPath, JSON.stringify(testSchema, null, 2));

    // Set config
    process.env.DM_BULK_IMPORT_SCHEMAS = `testusers:${testSchemaPath}`;
    process.env.DM_BULK_IMPORT_MAX_FILE_SIZE = '1048576'; // 1MB
    process.env.DM_BULK_IMPORT_BATCH_SIZE = '50';

    // Initialize server
    server = new DM();
    plugin = new LdapBulkImport(server);
    await server.registerPlugin('bulkImport', plugin);

    // Setup API
    plugin.api(server.app);

    request = supertest(server.app);

    // Create test organizations
    await server.ldap.add(testOrg1Dn, {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'TestOrg1',
      twakeDepartmentPath: 'TestOrg1',
    });
    await server.ldap.add(testOrg2Dn, {
      objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
      ou: 'TestOrg2',
      twakeDepartmentPath: 'TestOrg2',
    });
  });

  after(async function () {
    // Clean up test organizations
    try {
      await server.ldap.delete(testOrg1Dn);
    } catch (e) {
      // ignore
    }
    try {
      await server.ldap.delete(testOrg2Dn);
    } catch (e) {
      // ignore
    }

    // Clean up test schema
    const testSchemaPath = path.join(
      __dirname,
      '../../fixtures/bulk-import-schema.json'
    );
    if (fs.existsSync(testSchemaPath)) {
      fs.unlinkSync(testSchemaPath);
    }
  });

  afterEach(async function () {
    // Clean up test users
    const testUsers = ['bulkuser1', 'bulkuser2', 'bulkuser3', 'invaliduser'];
    for (const uid of testUsers) {
      try {
        await server.ldap.delete(`uid=${uid},${process.env.DM_LDAP_BASE}`);
      } catch (e) {
        // ignore
      }
    }
  });

  describe('Template Generation', () => {
    it('should generate CSV template with editable attributes', async () => {
      const res = await request.get(
        '/api/v1/ldap/bulk-import/testusers/template.csv'
      );

      expect(res.status).to.equal(200);
      expect(res.headers['content-type']).to.include('text/csv');
      expect(res.headers['content-disposition']).to.include(
        'testusers-template.csv'
      );

      const headers = res.text.trim().split(',');
      expect(headers).to.include('uid');
      expect(headers).to.include('cn');
      expect(headers).to.include('sn');
      expect(headers).to.include('givenName');
      expect(headers).to.include('mail');
      expect(headers).to.include('organizationDn');

      // Should NOT include fixed attributes
      expect(headers).to.not.include('objectClass');

      // Should NOT include organizationLink/organizationPath (calculated)
      expect(headers).to.not.include('twakeDepartmentLink');
      expect(headers).to.not.include('twakeDepartmentPath');
    });
  });

  describe('Bulk Import', () => {
    it('should import users from valid CSV file', async function () {
      this.timeout(10000);

      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Bulk User 1,User1,Bulk,bulkuser1@test.org,Passw0rd!123,"${testOrg1Dn}"`,
        `bulkuser2,Bulk User 2,User2,Bulk,bulkuser2@test.org,Passw0rd!456,"${testOrg2Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv')
        .field('dryRun', 'false')
        .field('continueOnError', 'true');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('success', true);
      expect(res.body).to.have.property('total', 2);
      expect(res.body).to.have.property('created', 2);
      expect(res.body).to.have.property('failed', 0);

      // Verify users were created
      const user1 = await server.ldap.search(
        { paged: false, scope: 'base' },
        `uid=bulkuser1,${process.env.DM_LDAP_BASE}`
      );
      expect((user1 as any).searchEntries[0].uid).to.equal('bulkuser1');
      expect((user1 as any).searchEntries[0].twakeDepartmentLink).to.equal(
        testOrg1Dn
      );
      expect((user1 as any).searchEntries[0].twakeDepartmentPath).to.equal(
        'TestOrg1'
      );
    });

    it('should handle dry run mode', async () => {
      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Bulk User 1,User1,Bulk,bulkuser1@test.org,Passw0rd!123,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv')
        .field('dryRun', 'true');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('created', 1);

      // Verify user was NOT actually created
      try {
        await server.ldap.search(
          { paged: false, scope: 'base' },
          `uid=bulkuser1,${process.env.DM_LDAP_BASE}`
        );
        expect.fail('User should not exist in dry run mode');
      } catch (error) {
        // Expected - user should not exist
      }
    });

    it('should skip existing users when updateExisting is false', async function () {
      this.timeout(10000);

      // Create a user first
      await server.ldap.add(`uid=bulkuser1,${process.env.DM_LDAP_BASE}`, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: 'bulkuser1',
        cn: 'Existing User',
        sn: 'Existing',
        mail: 'existing@test.org',
      });

      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Updated User,User1,Updated,updated@test.org,Newpass!123,"${testOrg1Dn}"`,
        `bulkuser2,New User,User2,New,new@test.org,Passw0rd!123,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv')
        .field('updateExisting', 'false');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('created', 1);
      expect(res.body).to.have.property('skipped', 1);

      // Verify first user was not updated
      const user1 = await server.ldap.search(
        { paged: false, scope: 'base' },
        `uid=bulkuser1,${process.env.DM_LDAP_BASE}`
      );
      expect((user1 as any).searchEntries[0].cn).to.equal('Existing User');
    });

    it('should update existing users when updateExisting is true', async function () {
      this.timeout(10000);

      // Create a user first
      await server.ldap.add(`uid=bulkuser1,${process.env.DM_LDAP_BASE}`, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: 'bulkuser1',
        cn: 'Existing User',
        sn: 'Existing',
        mail: 'existing@test.org',
      });

      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Updated User,User1,Updated,updated@test.org,Newpass!123,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv')
        .field('updateExisting', 'true');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('updated', 1);

      // Verify user was updated
      const user1 = await server.ldap.search(
        { paged: false, scope: 'base' },
        `uid=bulkuser1,${process.env.DM_LDAP_BASE}`
      );
      expect((user1 as any).searchEntries[0].cn).to.equal('Updated User');
    });

    it('should handle errors and continue when continueOnError is true', async () => {
      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Valid User,User1,Valid,valid@test.org,Passw0rd!123,"${testOrg1Dn}"`,
        `invaliduser,Invalid User,User2,Invalid,invalid@test.org,Passw0rd!123,"ou=nonexistent,dc=invalid"`, // Invalid org
        `bulkuser2,Valid User 2,User2,Valid,valid2@test.org,Passw0rd!456,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv')
        .field('continueOnError', 'true');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('created', 2);
      expect(res.body).to.have.property('failed', 1);
      expect(res.body.errors).to.have.lengthOf(1);
      expect(res.body.errors[0]).to.have.property('line', 3);
    });

    it('should validate required attributes', async () => {
      const csvContent = [
        'uid,cn,givenName,mail,organizationDn', // Missing 'sn'
        `bulkuser1,Bulk User 1,Bulk,bulkuser1@test.org,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('failed', 1);
      expect(res.body.errors[0].error).to.include(
        'Missing required attribute: sn'
      );
    });

    it('should handle multi-value attributes', async function () {
      this.timeout(10000);

      const csvContent = [
        'uid,cn,sn,givenName,mail,userPassword,organizationDn',
        `bulkuser1,Bulk User 1,User1,Bulk,bulkuser1@test.org;bulkuser1-alt@test.org,Passw0rd!123,"${testOrg1Dn}"`,
      ].join('\n');

      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from(csvContent), 'test.csv');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('created', 1);

      // Verify multi-value attribute
      const user1 = await server.ldap.search(
        { paged: false, scope: 'base' },
        `uid=bulkuser1,${process.env.DM_LDAP_BASE}`
      );
      const mail = (user1 as any).searchEntries[0].mail;
      expect(mail).to.be.an('array');
      expect(mail).to.have.lengthOf(2);
      expect(mail).to.include('bulkuser1@test.org');
      expect(mail).to.include('bulkuser1-alt@test.org');
    });

    it('should reject non-CSV files', async () => {
      const res = await request
        .post('/api/v1/ldap/bulk-import/testusers')
        .attach('file', Buffer.from('not a csv'), 'test.txt');

      expect(res.status).to.equal(500);
    });

    it('should return 400 when no file is uploaded', async () => {
      const res = await request.post('/api/v1/ldap/bulk-import/testusers');

      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('No file uploaded');
    });
  });
});
