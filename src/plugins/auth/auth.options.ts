/**
 * The authentication and authorization plugin options, at their historical
 * path.
 *
 * Each plugin declares its own, next to its class; this module keeps the
 * former `./plugin-auth-auth.options` sub-path exporting all of them. See
 * `docs/development/modularization-plan.md`.
 */
export {
  authzOptions,
  type AuthzOptions,
} from '@ldap-rest/authz-scope/options';
export {
  crowdsecOptions,
  crowdsecOptionsOf,
} from '@ldap-rest/auth-crowdsec/options';
export type { CrowdsecOptions } from '@ldap-rest/auth-crowdsec/options';
export {
  dynamicOptions,
  dynamicOptionsOf,
} from '@ldap-rest/authz-dynamic/options';
export type { DynamicOptions } from '@ldap-rest/authz-dynamic/options';
export { fakeOptions, type FakeOptions } from '@ldap-rest/auth-fake/options';
export { hmacOptions, hmacOptionsOf } from '@ldap-rest/auth-hmac/options';
export type { HmacOptions } from '@ldap-rest/auth-hmac/options';
export {
  linid1Options,
  type Linid1Options,
} from '@ldap-rest/authz-linid1/options';
export { llngOptions, type LlngOptions } from '@ldap-rest/auth-llng/options';
export { openidconnectOptions } from '@ldap-rest/auth-openidconnect/options';
export type { OpenidconnectOptions } from '@ldap-rest/auth-openidconnect/options';
export {
  perBranchOptions,
  perBranchOptionsOf,
} from '@ldap-rest/authz-perbranch/options';
export type { PerBranchOptions } from '@ldap-rest/authz-perbranch/options';
export {
  perRouteOptions,
  type PerRouteOptions,
} from '@ldap-rest/authz-perroute/options';
export {
  rateLimitOptions,
  rateLimitOptionsOf,
} from '@ldap-rest/auth-ratelimit/options';
export type { RateLimitOptions } from '@ldap-rest/auth-ratelimit/options';
export { tokenOptions, type TokenOptions } from '@ldap-rest/auth-token/options';
export { totpOptions, totpOptionsOf } from '@ldap-rest/auth-totp/options';
export type { TotpOptions } from '@ldap-rest/auth-totp/options';
export { trustedProxyOptions } from '@ldap-rest/auth-trustedproxy/options';
export type { TrustedProxyOptions } from '@ldap-rest/auth-trustedproxy/options';
