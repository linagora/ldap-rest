/**
 * Global test setup using Mocha root hooks
 * This approach works better with tsx/cjs
 *
 * Strategy:
 * - If external LDAP env vars are set → use them
 * - If not → start embedded LDAP server in Docker
 */

import {
  getGlobalTestLdapServer,
  stopGlobalTestLdapServer,
  LdapTestServer,
} from './helpers/ldapServer';
import { hasExternalLdap } from './helpers/env';

// Export the global server reference so other modules can access it
export let globalServer: LdapTestServer | null = null;

// Track whether we started an embedded server (to clean it up later)
let usingEmbeddedLdap = false;

export const mochaHooks = {
  async beforeAll(this: Mocha.Context) {
    this.timeout(120000); // 2 minutes for LDAP server startup
    console.log('\n🚀 Setting up global test environment...\n');

    try {
      // Check if external LDAP is configured
      if (hasExternalLdap()) {
        console.log('✓ Using external LDAP server');
        console.log(`  URL: ${process.env.DM_LDAP_URL}`);
        console.log(`  Base DN: ${process.env.DM_LDAP_BASE}`);
        console.log('');
        usingEmbeddedLdap = false;
      } else {
        console.log('ℹ️  No external LDAP configured, starting embedded LDAP server...\n');

        // Start embedded LDAP server
        globalServer = await getGlobalTestLdapServer();
        usingEmbeddedLdap = true;

        // Set environment variables for all tests
        const envVars = globalServer.getEnvVars();
        Object.entries(envVars).forEach(([key, value]) => {
          process.env[key] = value;
        });

        console.log('✓ Embedded LDAP server ready');
        console.log(`  URL: ${envVars.DM_LDAP_URL}`);
        console.log(`  Base DN: ${envVars.DM_LDAP_BASE}`);
        console.log('');
      }

      // Set James mock URL (tests will use nock)
      process.env.DM_JAMES_WEBADMIN_URL =
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000';
      process.env.DM_JAMES_WEBADMIN_TOKEN =
        process.env.DM_JAMES_WEBADMIN_TOKEN || 'test-token';

    } catch (err) {
      console.error('❌ Failed to setup test environment:', err);
      throw err;
    }
  },

  async afterAll() {
    console.log('\n🧹 Cleaning up global test environment...\n');

    try {
      // Only stop the embedded LDAP server if we started it
      if (usingEmbeddedLdap) {
        await stopGlobalTestLdapServer();
        console.log('✓ Embedded LDAP server stopped\n');
      } else {
        console.log('✓ External LDAP server left running\n');
      }
    } catch (err) {
      console.error('❌ Failed to cleanup test environment:', err);
    }
  },
};
