/**
 * @deprecated Use `core/ldap/organizations` instead. This file is a
 * backwards-compatibility shim for setups that still load the plugin under
 * the historical (singular) filename. It will be removed in a future major
 * release.
 *
 * The warning is printed when this module is imported, which a server that
 * also names `core/ldap/organizations` never does: both spellings are one
 * plugin, and the second is a duplicate of the first.
 */
import LdapOrganizations from '@ldap-rest/ldap-organizations';

console.warn(
  '[ldap-rest] Plugin `core/ldap/organization` is deprecated; use `core/ldap/organizations` instead.'
);

export default LdapOrganizations;
