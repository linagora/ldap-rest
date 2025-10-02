import { expect } from 'chai';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';

const { DM_LDAP_USER_BRANCH } = process.env;

describe('LdapUsersFlat validation with standard schema (via flatGeneric)', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_USER_BRANCH
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldapUsersFlat standard schema validation tests: DM_LDAP_USER_BRANCH and LDAP credentials are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let genericPlugin: LdapFlatGeneric;
  let plugin: any;

  before(async function () {
    this.timeout(5000);
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/standard/users.json';
    server = new DM();
    genericPlugin = new LdapFlatGeneric(server);
    plugin = genericPlugin.instances[0];
    // Add backward compatibility aliases
    plugin.addUser = plugin.addEntry.bind(plugin);
    plugin.deleteUser = plugin.deleteEntry.bind(plugin);
    plugin.searchUsersByName = plugin.searchEntriesByName.bind(plugin);
    plugin.listUsers = plugin.listEntries.bind(plugin);
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

  describe('New user with standard schema validation', () => {
    it('should add/delete user with required fields', async () => {
      await plugin.addUser('testuser2', {
        cn: 'Test User 2',
        sn: 'User',
        mail: 'testuser2-schema@example.org',
      });
      const listEntries = await plugin.listUsers({});
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
        });
        expect.fail('Should reject invalid uid format');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Invalid value for attribute "uid"/
        );
      }
    });

    it('should reject user with missing required fields', async () => {
      try {
        await plugin.addUser('testuser3', {
          cn: 'Test User',
          // Missing sn
          mail: 'testuser3-missing-sn@example.org',
        });
        expect.fail('Should reject missing required field');
      } catch (e) {
        expect((e as Error).message).to.match(/Attribute "sn" is required/);
      }
    });

    it('should reject user with invalid email format', async () => {
      try {
        await plugin.addUser('testuser3', {
          cn: 'Test User',
          sn: 'User',
          mail: 'invalid-email-schema',
        });
        expect.fail('Should reject invalid email format');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Invalid value for attribute "mail"/
        );
      }
    });
  });
});
