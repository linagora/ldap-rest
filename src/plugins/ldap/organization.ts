/**
 * @deprecated Use `core/ldap/organizations` instead. This file is a
 * backwards-compatibility shim for setups that still load the plugin under
 * the historical (singular) filename. It will be removed in a future major
 * release.
 */
import LdapOrganizations from './organizations';

console.warn(
  '[ldap-rest] Plugin `core/ldap/organization` is deprecated; use `core/ldap/organizations` instead.'
);

export default LdapOrganizations;
