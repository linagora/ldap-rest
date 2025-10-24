/**
 * Mocha global teardown
 * Stops LDAP server after all tests
 */

import { stopGlobalTestLdapServer } from './ldapServer';

export async function mochaGlobalTeardown() {
  console.log('\n🧹 Cleaning up global test environment...\n');

  try {
    await stopGlobalTestLdapServer();
    console.log('✓ LDAP server stopped\n');
  } catch (err) {
    console.error('❌ Failed to cleanup test environment:', err);
  }
}
