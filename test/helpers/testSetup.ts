/**
 * Global test setup
 * Manages a single LDAP server instance for all tests
 * @module test/helpers/testSetup
 */

import {
  LdapTestServer,
  getGlobalTestLdapServer,
  stopGlobalTestLdapServer,
} from './ldapServer';

let globalServer: LdapTestServer | null = null;

/**
 * Setup global test environment
 * Called once before all tests
 */
export default async function mochaGlobalSetup() {
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

/**
 * Teardown global test environment
 * Called once after all tests
 */
export async function mochaGlobalTeardown() {
  console.log('\n🧹 Cleaning up global test environment...\n');

  try {
    await stopGlobalTestLdapServer();
    console.log('✓ LDAP server stopped\n');
  } catch (err) {
    console.error('❌ Failed to cleanup test environment:', err);
  }
}

/**
 * Get the global LDAP server instance
 * Use this in tests that need direct access to the server
 */
export function getTestLdapServer(): LdapTestServer {
  // Import from setup.ts which holds the actual reference
  const { globalServer } = require('../setup');
  if (!globalServer) {
    throw new Error('Global LDAP server not initialized. Did you run setup?');
  }
  return globalServer;
}
