# Changelog

## v0.1.9 (2026-02-23)

### Security

- Add `escapeDnValue()` to all DN constructions to prevent LDAP injection attacks
- Add `validateDnValue()` to reject control characters and invisible Unicode in DN values
- Fix DN extraction regex to properly handle escaped commas

### New Features

- Export `escapeDnValue`, `escapeLdapFilter`, and `validateDnValue` utilities for plugins

### Tests

- Add comprehensive test suite for LDAP DN utilities (31 tests)

## v0.1.8 (2026-02-09)

### New Features

- Add `deleteUserData` method to James plugin for GDPR data deletion
- Add `deleteUserData` method to Calendar Resources plugin for GDPR data deletion

### Maintenance

- Update dependencies
- Fix lint errors and improve TypeScript typing

## v0.1.7 (2025-01-20)

### New Features

- Add `passwordPolicy` plugin for OpenLDAP ppolicy administration

### Improvements

- Add race condition protection to LDAP connection pool cleanup
- Fix memory leak in Modal: use DisposableComponent for event cleanup
- Add log before rejections
- Add some standard schemas (automountMaps, devices, dhcpHosts, dnsRecords,
  netgroups, posixAccounts, posixGroups, sshPublicKeys, sudoRules)

### Maintenance

- Update dependencies and require diff>=8.0.3
- Fix links in documentation
- Improve TypeScript exports

## v0.1.6 (2025-12-01)

- Export ldapActions types

## v0.1.5 (2025-12-01)

- Improve documentation and exports

## v0.1.4 (2025-11-29)

- Optimization & security
- Improve tests

## v0.1.3 (2025-11-25)

- Add plugin `core/auth/trustedProxy` - use `Auth-User` header when set
- Improve error reporting with proper HTTP codes
- User quota usage feature into James plugin

## v0.1.2 (2025-11-07)

- Run Docker container as non-root user
- Fix load order to keep logs
- Fix dependencies

## v0.1.1 (2025-11-05)

- Fix exports
- Export all utils
- Add SECURITY.md

## v0.1.0 (2025-11-03)

- New plugins
- Multiple LDAP URLs
- Add robust error handling to prevent server crashes
- Expose configuration via configApi
- Add Docker Swarm example
- Add log level "notice"
- Add OBM schemas
- Export abstract classes in package.json
- Remove dead code from ldapActions and ldapFlat
- Fix embedded LDAP server timing and reliability in tests

## v0.0.1 (2025-10-16)

- **Initial release**
