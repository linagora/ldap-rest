import { expect } from 'chai';
import LdapUsersFlat from '../../../src/plugins/ldap/usersFlat';
import { DM } from '../../../src/bin';

const { DM_LDAP_USER_BRANCH } = process.env;

const twakeAttr = {
  twakeDepartmentPath: 'Test / SubTest',
  twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_BASE}`,
};

describe('LdapUsersFlat validation', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_USER_BRANCH
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldapUsersFlat validation tests: DM_LDAP_USER_BRANCH and LDAP credentials are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: LdapUsersFlat;

  before(async function () {
    this.timeout(5000); // Increase timeout to wait for schema loading
    process.env.DM_USER_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    plugin = new LdapUsersFlat(server);
    // Wait for schema to load (async file read)
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    try {
      await plugin.deleteUser('testuser2').catch(() => {});
      await plugin.deleteUser('testuser3').catch(() => {});
    } catch (e) {
      console.error('After error', e);
    }
  });

  describe('constructor', () => {
    it('should set base from config', () => {
      expect(plugin.base).to.equal(DM_LDAP_USER_BRANCH);
    });
  });

  describe('New user with schema validation', () => {
    it('should add/delete user with required fields', async () => {
      await plugin.addUser('testuser2', {
        cn: 'Test User 2',
        sn: 'User',
        mail: 'testuser2-schema@example.org',
        ...twakeAttr,
      });
      const listEntries = await plugin.listUsers();
      // @ts-ignore
      expect(listEntries).to.have.property('testuser2');
      expect(await plugin.searchUsersByName('testuser2')).to.deep.equal({
        testuser2: {
          dn: `uid=testuser2,${DM_LDAP_USER_BRANCH}`,
          uid: 'testuser2',
        },
      });
      expect(await plugin.deleteUser('testuser2')).to.be.true;
    });

    it('should reject user with invalid uid format', async () => {
      try {
        await plugin.addUser('test user!', {
          cn: 'Test User',
          sn: 'User',
          mail: 'testuser-invalid-uid@example.org',
          ...twakeAttr,
        });
        expect.fail('Should reject invalid uid format');
      } catch (e) {
        expect((e as Error).message).to.match(/Field uid has invalid value/);
      }
    });

    it('should reject user with missing required fields', async () => {
      try {
        await plugin.addUser('testuser3', {
          cn: 'Test User',
          // Missing sn
          mail: 'testuser3-missing-sn@example.org',
          ...twakeAttr,
        });
        expect.fail('Should reject missing required field');
      } catch (e) {
        expect((e as Error).message).to.match(/Missing required field sn/);
      }
    });

    it('should reject user with invalid email format', async () => {
      try {
        await plugin.addUser('testuser3', {
          cn: 'Test User',
          sn: 'User',
          mail: 'invalid-email-schema',
          ...twakeAttr,
        });
        expect.fail('Should reject invalid email format');
      } catch (e) {
        expect((e as Error).message).to.match(/Field mail has invalid value/);
      }
    });
  });
});
