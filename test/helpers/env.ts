/**
 * Test helper utilities for environment variable checks
 * @module test/helpers/env
 */

/**
 * Check if required LDAP environment variables are set
 * If not, skip the test with a warning message
 *
 * @param context - Mocha test context (this)
 * @param vars - Array of required environment variable names
 * @returns true if all vars are set, false otherwise
 */
export function skipIfMissingEnvVars(
  context: Mocha.Context,
  vars: string[]
): boolean {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.warn(
      `Skipping test: Required env vars not set: ${missing.join(', ')}`
    );
    context.skip();
    return false;
  }
  return true;
}

/**
 * Common LDAP environment variables
 */
export const LDAP_ENV_VARS = [
  'DM_LDAP_DN',
  'DM_LDAP_PWD',
  'DM_LDAP_BASE',
] as const;

/**
 * LDAP environment variables including top organization
 */
export const LDAP_ENV_VARS_WITH_ORG = [
  ...LDAP_ENV_VARS,
  'DM_LDAP_TOP_ORGANIZATION',
] as const;

/**
 * James environment variables
 */
export const JAMES_ENV_VARS = [
  'DM_JAMES_WEBADMIN_URL',
  'DM_JAMES_WEBADMIN_TOKEN',
] as const;

/**
 * Combined LDAP and James environment variables
 */
export const LDAP_AND_JAMES_ENV_VARS = [
  ...LDAP_ENV_VARS,
  ...JAMES_ENV_VARS,
] as const;
