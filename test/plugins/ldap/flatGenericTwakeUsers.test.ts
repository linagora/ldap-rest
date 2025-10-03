import { expect } from 'chai';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';
import supertest from 'supertest';

const { DM_LDAP_BASE } = process.env;
const USER_BRANCH = `ou=users,${DM_LDAP_BASE}`;

const twakeAttr = {
  twakeDepartmentPath: 'Test / SubTest',
  twakeDepartmentLink: `ou=Test,${DM_LDAP_BASE}`,
  twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${DM_LDAP_BASE}`,
  twakeDeliveryMode: `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${DM_LDAP_BASE}`,
};

describe('LdapUsersFlat Plugin (via flatGeneric)', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldapUsersFlat tests: DM_LDAP_BASE and LDAP credentials are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let genericPlugin: LdapFlatGeneric;
  let plugin: any; // The users instance from flatGeneric

  before(async () => {
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    genericPlugin = new LdapFlatGeneric(server);
    plugin = genericPlugin.instances[0];
    // Add backward compatibility aliases
    plugin.addUser = plugin.addEntry.bind(plugin);
    plugin.deleteUser = plugin.deleteEntry.bind(plugin);
    plugin.modifyUser = plugin.modifyEntry.bind(plugin);
    plugin.renameUser = plugin.renameEntry.bind(plugin);
    plugin.listUsers = plugin.listEntries.bind(plugin);
    plugin.searchUsersByName = plugin.searchEntriesByName.bind(plugin);
  });

  afterEach(async () => {
    try {
      await plugin.deleteUser('testuser');
    } catch (e) {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should set base from config', () => {
      expect(plugin.base).to.equal(USER_BRANCH);
    });
  });

  describe('New user', () => {
    it('should add/delete user', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat@example.org',
        ...twakeAttr,
      });
      const listEntries = await plugin.listUsers({});
      // @ts-ignore
      expect(listEntries).to.have.property('testuser');
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
        },
      });
      expect(await plugin.deleteUser('testuser')).to.be.true;
    });

    it('should add/delete user with additional attributes', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-2@example.org',
        givenName: 'Test',
        displayName: 'Test User',
        ...twakeAttr,
      });
      expect(
        await plugin.searchUsersByName('testuser', false, [
          'uid',
          'cn',
          'sn',
          'mail',
          'givenName',
          'displayName',
        ])
      ).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-flat-2@example.org',
          givenName: 'Test',
          displayName: 'Test User',
        },
      });
      expect(await plugin.deleteUser('testuser')).to.be.true;
    });

    it('should add/modify/delete user with additional attributes', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-3@example.org',
        displayName: 'Test User',
        ...twakeAttr,
      });
      expect(
        await plugin.searchUsersByName('testuser', false, [
          'uid',
          'displayName',
        ])
      ).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
          displayName: 'Test User',
        },
      });
      await plugin.modifyUser('testuser', {
        replace: { displayName: 'Modified Test User' },
      });
      expect(
        await plugin.searchUsersByName('testuser', false, [
          'uid',
          'displayName',
        ])
      ).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
          displayName: 'Modified Test User',
        },
      });
      expect(await plugin.deleteUser('testuser')).to.be.true;
    });
  });

  describe('Rename user', () => {
    this.afterEach(async () => {
      try {
        await plugin.deleteUser('testuserbis');
      } catch (e) {
        // ignore
      }
    });

    it('should rename user', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-rename@example.org',
        ...twakeAttr,
      });
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
        },
      });
      await plugin.renameUser('testuser', 'testuserbis');
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({});
      expect(await plugin.searchUsersByName('testuserbis')).to.deep.equal({
        testuserbis: {
          dn: `uid=testuserbis,${USER_BRANCH}`,
          uid: 'testuserbis',
        },
      });
    });
  });

  describe('API', () => {
    let request: any;
    before(async () => {
      plugin.api(server.app);
      request = supertest(server.app);
    });

    it('should add/del user via API', async () => {
      let res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send({
          uid: 'testuser',
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-flat-api@example.org',
          ...twakeAttr,
        });
      expect(res.status).to.equal(201);
      expect(res.body).to.have.property('uid', 'testuser');
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
        },
      });

      res = await request
        .delete('/api/v1/ldap/users/testuser')
        .type('json')
        .send();
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({});
    });

    it('should modify user via API', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-api-modify@example.org',
        displayName: 'Test User',
        ...twakeAttr,
      });
      let res = await request
        .put('/api/v1/ldap/users/testuser')
        .type('json')
        .send({
          replace: { displayName: 'Modified via API' },
        });
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(
        await plugin.searchUsersByName('testuser', false, [
          'uid',
          'displayName',
        ])
      ).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${USER_BRANCH}`,
          uid: 'testuser',
          displayName: 'Modified via API',
        },
      });
    });

    it('should list via API', async () => {
      let res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send({
          uid: 'testuser',
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-flat-api-list@example.org',
          ...twakeAttr,
        });
      expect(res.status).to.equal(201);
      expect(res.body).to.have.property('uid', 'testuser');
      res = await request
        .get('/api/v1/ldap/users?match=uid=*estuse*&attributes=uid,mail')
        .set('Accept', 'application/json');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('testuser');
      expect(res.body.testuser).to.deep.equal({
        dn: `uid=testuser,${USER_BRANCH}`,
        uid: 'testuser',
        mail: 'testuser-flat-api-list@example.org',
      });
    });
  });

  describe('Pointer type validation', () => {
    it('should reject user with non-existent pointer DN', async () => {
      try {
        await plugin.addUser('testuser', {
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-pointer@example.org',
          twakeDepartmentPath: 'Test / SubTest',
          twakeDepartmentLink: `ou=Test,${DM_LDAP_BASE}`,
          twakeAccountStatus: `cn=nonexistent,ou=twakeAccountStatus,ou=nomenclature,${DM_LDAP_BASE}`,
          twakeDeliveryMode: `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${DM_LDAP_BASE}`,
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('points to invalid or non-existent DN');
      }
    });

    it('should reject user with pointer DN outside allowed branch', async () => {
      try {
        await plugin.addUser('testuser', {
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-pointer@example.org',
          twakeDepartmentPath: 'Test / SubTest',
          twakeDepartmentLink: `ou=Test,${DM_LDAP_BASE}`,
          // Using a DN from wrong branch
          twakeAccountStatus: `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${DM_LDAP_BASE}`,
          twakeDeliveryMode: `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${DM_LDAP_BASE}`,
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include(
          'must point to a DN within allowed branches'
        );
      }
    });

    it('should accept user with valid pointer DNs', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-pointer-valid@example.org',
        twakeDepartmentPath: 'Test / SubTest',
        twakeDepartmentLink: `ou=Test,${DM_LDAP_BASE}`,
        twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${DM_LDAP_BASE}`,
        twakeDeliveryMode: `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${DM_LDAP_BASE}`,
      });
      const users = await plugin.searchUsersByName('testuser');
      expect(users).to.have.property('testuser');
      await plugin.deleteUser('testuser');
    });

    it('should reject modification with invalid pointer DN', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-pointer-modify@example.org',
        ...twakeAttr,
      });
      try {
        await plugin.modifyUser('testuser', {
          replace: {
            twakeAccountStatus: `cn=invalid,ou=twakeAccountStatus,ou=nomenclature,${DM_LDAP_BASE}`,
          },
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('points to invalid or non-existent DN');
      } finally {
        await plugin.deleteUser('testuser');
      }
    });
  });
});
