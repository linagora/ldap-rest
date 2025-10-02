import { expect } from 'chai';
import LdapUsersFlat from '../../../src/plugins/ldap/usersFlat';
import { DM } from '../../../src/bin';
import supertest from 'supertest';

const { DM_LDAP_USER_BRANCH } = process.env;
process.env.DM_USER_SCHEMA = '';

describe('LdapUsersFlat Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_USER_BRANCH
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldapUsersFlat tests: DM_LDAP_USER_BRANCH and LDAP credentials are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: LdapUsersFlat;

  before(async () => {
    server = new DM();
    plugin = new LdapUsersFlat(server);
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
      expect(plugin.base).to.equal(DM_LDAP_USER_BRANCH);
    });
  });

  describe('New user', () => {
    it('should add/delete user', async () => {
      await plugin.addUser('testuser', {
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat@example.org',
      });
      const listEntries = await plugin.listUsers();
      // @ts-ignore
      expect(listEntries).to.have.property('testuser');
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
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
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
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
      });
      expect(
        await plugin.searchUsersByName('testuser', false, [
          'uid',
          'displayName',
        ])
      ).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
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
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
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
      });
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
          uid: 'testuser',
        },
      });
      await plugin.renameUser('testuser', 'testuserbis');
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({});
      expect(await plugin.searchUsersByName('testuserbis')).to.deep.equal({
        testuserbis: {
          dn: `uid=testuserbis,${DM_LDAP_USER_BRANCH}`,
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
      let res = await request.post('/api/v1/ldap/users').type('json').send({
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-api@example.org',
      });
      expect(res.body).to.deep.equal({ success: true });
      expect(res.status).to.equal(200);
      expect(await plugin.searchUsersByName('testuser')).to.deep.equal({
        testuser: {
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
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
          dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
          uid: 'testuser',
          displayName: 'Modified via API',
        },
      });
    });

    it('should list via API', async () => {
      let res = await request.post('/api/v1/ldap/users').type('json').send({
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser-flat-api-list@example.org',
      });
      expect(res.body).to.deep.equal({ success: true });
      expect(res.status).to.equal(200);
      res = await request
        .get('/api/v1/ldap/users?match=uid=*estuse*&attributes=uid,mail')
        .set('Accept', 'application/json');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('testuser');
      expect(res.body.testuser).to.deep.equal({
        dn: `uid=testuser,${DM_LDAP_USER_BRANCH}`,
        uid: 'testuser',
        mail: 'testuser-flat-api-list@example.org',
      });
    });
  });
});
