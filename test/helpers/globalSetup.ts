/**
 * Mocha global setup
 * Starts LDAP server before all tests
 */

import { LdapTestServer, getGlobalTestLdapServer } from './ldapServer';

let globalServer: LdapTestServer | null = null;

export async function mochaGlobalSetup() {
  console.log('\n🚀 Setting up global test environment...\n');

  try {
    // Start LDAP server
    globalServer = await getGlobalTestLdapServer();

    // Set environment variables for all tests
    const envVars = globalServer.getEnvVars();
    Object.entries(envVars).forEach(([key, value]) => {
      process.env[key] = value;
    });

    // Also set test organization for org-related tests
    process.env.DM_LDAP_TOP_ORGANIZATION = 'dc=example,dc=com';

    // Set James mock URL (tests will use nock)
    process.env.DM_JAMES_WEBADMIN_URL =
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000';
    process.env.DM_JAMES_WEBADMIN_TOKEN =
      process.env.DM_JAMES_WEBADMIN_TOKEN || 'test-token';

    console.log('✓ LDAP server ready');
    console.log(`  URL: ${envVars.DM_LDAP_URI}`);
    console.log(`  Base DN: ${envVars.DM_LDAP_BASE}`);
    console.log('');
  } catch (err) {
    console.error('❌ Failed to setup test environment:', err);
    throw err;
  }
}
