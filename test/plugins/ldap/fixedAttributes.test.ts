import { expect } from 'chai';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';

const { DM_LDAP_USER_BRANCH } = process.env;

describe('Fixed attributes validation', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_USER_BRANCH
  ) {
    console.warn(
      'Skipping fixed attributes tests: DM_LDAP_USER_BRANCH and LDAP credentials are required'
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
  });

  afterEach(async () => {
    try {
      await plugin.deleteEntry('testfixed').catch(() => {});
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('objectClass as fixed attribute', () => {
    it('should automatically set objectClass to default value on creation', async function () {
      this.timeout(5000);

      // Create user without specifying objectClass (uid is passed separately)
      await plugin.addEntry('testfixed', {
        cn: 'Test Fixed',
        sn: 'Fixed',
      });

      // Construct the DN
      const dn = `${plugin.mainAttribute}=testfixed,${plugin.base}`;

      // Retrieve the created entry directly from LDAP
      const searchResult = await plugin.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: ['*'],
        },
        dn
      );

      expect(searchResult.searchEntries).to.have.lengthOf(1);
      const user = searchResult.searchEntries[0];

      expect(user.objectClass).to.be.an('array');
      expect(user.objectClass).to.include.members([
        'top',
        'inetOrgPerson',
        'organizationalPerson',
        'person',
      ]);

      // Cleanup
      await plugin.deleteEntry('testfixed');
    });

    it('should reject creation with different objectClass value', async function () {
      this.timeout(5000);

      try {
        await plugin.addEntry('testfixed', {
          cn: 'Test Fixed',
          sn: 'Fixed',
          objectClass: ['top', 'person'], // Wrong objectClass
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        // Error message should indicate the objectClass is fixed
        expect(err.message).to.match(/fixed|objectClass/i);
      }
    });

    it('should reject modification of objectClass via replace', async function () {
      this.timeout(5000);

      // First create a valid user
      await plugin.addEntry('testfixed', {
        cn: 'Test Fixed',
        sn: 'Fixed',
      });

      // Try to modify objectClass
      try {
        await plugin.modifyEntry('testfixed', {
          replace: {
            objectClass: ['top', 'person'],
          },
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.match(/fixed and cannot be modified/i);
      }

      // Cleanup
      await plugin.deleteEntry('testfixed');
    });

    it('should reject modification of objectClass via add', async function () {
      this.timeout(5000);

      // First create a valid user
      await plugin.addEntry('testfixed', {
        cn: 'Test Fixed',
        sn: 'Fixed',
      });

      // Try to add to objectClass
      try {
        await plugin.modifyEntry('testfixed', {
          add: {
            objectClass: ['posixAccount'],
          },
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.match(/fixed and cannot be modified/i);
      }

      // Cleanup
      await plugin.deleteEntry('testfixed');
    });

    it('should reject deletion of objectClass', async function () {
      this.timeout(5000);

      // First create a valid user
      await plugin.addEntry('testfixed', {
        cn: 'Test Fixed',
        sn: 'Fixed',
      });

      // Try to delete objectClass
      try {
        await plugin.modifyEntry('testfixed', {
          delete: ['objectClass'],
        });
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.match(/fixed and cannot be deleted/i);
      }

      // Cleanup
      await plugin.deleteEntry('testfixed');
    });

    it('should allow modification of non-fixed attributes', async function () {
      this.timeout(5000);

      // First create a valid user
      await plugin.addEntry('testfixed', {
        cn: 'Test Fixed',
        sn: 'Fixed',
      });

      // Modify a non-fixed attribute - should work
      await plugin.modifyEntry('testfixed', {
        replace: {
          cn: 'Modified Name',
        },
      });

      // Construct the DN
      const dn = `${plugin.mainAttribute}=testfixed,${plugin.base}`;

      // Verify the modification via direct LDAP search
      const searchResult = await plugin.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: ['cn'],
        },
        dn
      );

      expect(searchResult.searchEntries).to.have.lengthOf(1);
      const user = searchResult.searchEntries[0];
      expect(user.cn).to.equal('Modified Name');

      // Cleanup
      await plugin.deleteEntry('testfixed');
    });
  });
});
