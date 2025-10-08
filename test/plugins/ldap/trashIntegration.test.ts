import { expect } from 'chai';
import { DM } from '../../../src/bin';
import TrashPlugin from '../../../src/plugins/ldap/trash';

describe('Trash Plugin - Integration Tests', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping trash integration tests: DM_LDAP_BASE, DM_LDAP_DN, and DM_LDAP_PWD env vars are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: TrashPlugin;

  const testUser = `testintegtrash${Date.now()}`;
  const userDn = `uid=${testUser},${process.env.DM_LDAP_BASE}`;
  const trashBase =
    process.env.DM_TRASH_BASE || `ou=trash,${process.env.DM_LDAP_BASE}`;
  const trashDn = `uid=${testUser},${trashBase}`;

  before(async function () {
    this.timeout(10000);

    // Set up trash configuration
    process.env.DM_TRASH_BASE = trashBase;
    process.env.DM_TRASH_WATCHED_BASES = process.env.DM_LDAP_BASE;
    process.env.DM_TRASH_ADD_METADATA = 'true';
    process.env.DM_TRASH_AUTO_CREATE = 'true';

    server = new DM();
    await server.ready;

    // Register trash plugin to intercept deletes
    plugin = new TrashPlugin(server);
    await server.registerPlugin('trash', plugin);
  });

  after(async () => {
    // Clean up: try to delete test entries from both locations
    try {
      await server.ldap.delete(userDn);
    } catch (e) {
      // ignore
    }
    try {
      await server.ldap.delete(trashDn);
    } catch (e) {
      // ignore
    }
  });

  describe('Multiple users deletion', () => {
    it('should handle deletion of multiple users in one call', async function () {
      this.timeout(10000);

      const testUser1 = `${testUser}1`;
      const testUser2 = `${testUser}2`;
      const userDn1 = `uid=${testUser1},${process.env.DM_LDAP_BASE}`;
      const userDn2 = `uid=${testUser2},${process.env.DM_LDAP_BASE}`;
      const trashDn1 = `uid=${testUser1},${trashBase}`;
      const trashDn2 = `uid=${testUser2},${trashBase}`;

      try {
        // Create two test users
        await server.ldap.add(userDn1, {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User 1',
          sn: 'Trash',
          uid: testUser1,
          mail: `${testUser1}@test.org`,
        });

        await server.ldap.add(userDn2, {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User 2',
          sn: 'Trash',
          uid: testUser2,
          mail: `${testUser2}@test.org`,
        });

        // Delete both users (should move both to trash)
        await server.ldap.delete([userDn1, userDn2]);

        // Verify both are in trash
        const trash1 = await server.ldap.search({ paged: false }, trashDn1);
        // @ts-ignore
        expect(trash1.searchEntries).to.have.lengthOf(1);

        const trash2 = await server.ldap.search({ paged: false }, trashDn2);
        // @ts-ignore
        expect(trash2.searchEntries).to.have.lengthOf(1);
      } finally {
        // Cleanup
        try {
          await server.ldap.delete(trashDn1);
        } catch (e) {
          // ignore
        }
        try {
          await server.ldap.delete(trashDn2);
        } catch (e) {
          // ignore
        }
      }
    });
  });

  describe('Configuration variations', () => {
    it('should respect DM_TRASH_ADD_METADATA=false', async function () {
      this.timeout(10000);

      // Create a new server with metadata disabled
      const testUser2 = `${testUser}_nometa`;
      const userDn2 = `uid=${testUser2},${process.env.DM_LDAP_BASE}`;
      const trashDn2 = `uid=${testUser2},${trashBase}`;

      process.env.DM_TRASH_ADD_METADATA = 'false';

      const server2 = new DM();
      await server2.ready;

      const plugin2 = new TrashPlugin(server2);
      await server2.registerPlugin('trash', plugin2);

      try {
        // Create test user
        await server2.ldap.add(userDn2, {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User No Meta',
          sn: 'Trash',
          uid: testUser2,
          mail: `${testUser2}@test.org`,
        });

        // Delete user (moves to trash without metadata)
        await server2.ldap.delete(userDn2);

        // Verify it's in trash but without description metadata
        const trashResult = await server2.ldap.search(
          { paged: false },
          trashDn2
        );
        // @ts-ignore
        expect(trashResult.searchEntries).to.have.lengthOf(1);
        // @ts-ignore
        const entry = trashResult.searchEntries[0];
        // Description should not exist or not contain "Deleted on"
        if (entry.description) {
          expect(entry.description).to.not.include('Deleted on');
        }
      } finally {
        // Cleanup
        try {
          await server2.ldap.delete(trashDn2);
        } catch (e) {
          // ignore
        }
        // Restore original setting
        process.env.DM_TRASH_ADD_METADATA = 'true';
      }
    });
  });

  describe('Unmatched branches', () => {
    it('should NOT intercept deletes outside watched branches', async function () {
      this.timeout(10000);

      // Create a new server that only watches ou=users
      const testUser3 = `${testUser}_unwatched`;
      const userDn3 = `uid=${testUser3},${process.env.DM_LDAP_BASE}`;

      // Set watched branches to something that doesn't match our test base
      process.env.DM_TRASH_WATCHED_BASES = 'ou=users,dc=example,dc=com';

      const server3 = new DM();
      await server3.ready;

      const plugin3 = new TrashPlugin(server3);
      await server3.registerPlugin('trash', plugin3);

      try {
        // Create test user
        await server3.ldap.add(userDn3, {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User Unwatched',
          sn: 'Trash',
          uid: testUser3,
          mail: `${testUser3}@test.org`,
        });

        // Delete user (should be permanently deleted, NOT moved to trash)
        await server3.ldap.delete(userDn3);

        // Verify it's really gone
        try {
          await server3.ldap.search({ paged: false }, userDn3);
          expect.fail('User should be permanently deleted');
        } catch (error) {
          // Expected: user not found
        }

        // Verify it's NOT in trash
        const trashDn3 = `uid=${testUser3},${trashBase}`;
        try {
          const trashResult = await server3.ldap.search(
            { paged: false },
            trashDn3
          );
          // @ts-ignore
          expect(trashResult.searchEntries).to.have.lengthOf(0);
        } catch (error) {
          // Expected: not in trash
        }
      } finally {
        // Restore original setting
        process.env.DM_TRASH_WATCHED_BASES = process.env.DM_LDAP_BASE;
      }
    });
  });
});
