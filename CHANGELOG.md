# Changelog

## Unreleased

### New Features

- New plugin `core/twake/cozyProvision`: hooks the SCIM lifecycle to
  provision a Cozy instance after user creation and to publish
  `auth` / `user.created` and `b2b` / `domain.user.deleted` events
  on RabbitMQ. Reads `cozy_admin_url`, `cozy_admin_passphrase`,
  `cozy_org_id`, `cozy_org_domain` and `rabbitmq_url` from config.
  - Cozy admin call uses HTTP Basic with the configured passphrase;
    `409 Conflict` is treated as idempotent success
  - `@linagora/rabbitmq-client` is declared as an `optionalDependency`:
    if not installed at runtime, AMQP publishes are skipped with a
    one-time warning
  - `workplaceFqdn` is composed as `${id}.${cozy_org_domain}`

## v0.3.1 (2026-04-29)

### New Features

- OpenAPI generator now parses `@openapi` and `@openapi-component`
  YAML directives in route JSDoc, so plugins are self-documenting
  (summary, description, parameters, requestBody, responses, security,
  tags, reusable component schemas via `$ref`)
  - it skips routes that have no `@openapi` block and logs a
    `Skipping undocumented route` warning, so the published
    reference reflects intentionally-documented endpoints only
  - it now recognises `TwakePlugin` and `AuthzBase` descendants and
    walks `src/abstract/`, covering the James plugin and the generic
    `LdapFlat` CRUD surface (with a `{resource}` path placeholder)
- Annotate every API-exposing plugin with OpenAPI metadata: SCIM 2.0
  (Users, Groups, Bulk, Discovery), `ldapOrganizations`, `ldapGroups`,
  `ldapPasswordPolicy`, `ldapBulkImport`, `twake/appAccountsApi`,
  `twake/james`, `static`, `configApi`, `hello/helloworld`,
  `authzDynamic`, plus the abstract `LdapFlat` routes — 51 operations
  across 10 tags, backed by 30 component schemas

### Documentation

- Add `docs/plugin-development/openapi.md` guide explaining the
  generator contract and the YAML directives
- Fix broken link to `hooks.md` in README

### Bug Fixes

- Rename `core/ldap/organization` plugin source file to
  `organizations.ts` so the documented plugin name
  `core/ldap/organizations` actually loads; keep the singular path
  as a deprecated alias that emits a one-time warning at module load
  (slated for removal at the next major release)
- Word the plugin-path deprecation warning around the plugin path
  itself, not around the loading entry point (`DM_PLUGINS`)

### Security

- Harden DN handling and LDAP filter escaping in the
  `ldapOrganizations` plugin:
  - `moveOrganization` now uses `getRdn()` / `isChildOf()` instead of
    `dn.split(',')[0]` and `endsWith()`, so escaped commas,
    multi-valued RDNs and attribute-name casing differences no longer
    bypass the descendant / same-location checks
  - Replace `topOrg.replace(/^ou=[^,]+,/, '')` with `getParentDn()` in
    both call sites, going through the existing DN parser
  - `escapeLdapFilter()` the request-controlled `dn` and `objectClass`
    query parameter in `getOrganisationSubnodes`, and the path segment
    in `checkDeptPath`, closing LDAP filter injection vectors
  - Throw `NotFoundError` / `BadRequestError` / `ConflictError`
    instead of plain `Error`, so HTTP responses carry meaningful 4xx
    codes (404 / 400 / 409) instead of a generic 500
  - Stop double-wrapping caught LDAP errors that would otherwise lose
    their original status code
- `ConfigApi.getTop` now points at `/v1/ldap/organizations/top` (the
  actual GET route) instead of the collection root that only accepts
  POST

## v0.3.0 (2026-04-25)

### New Features

- Add `core/scim` plugin: SCIM 2.0 identity provisioning endpoint
  (`/scim/v2/Users` and `/scim/v2/Groups`), with per-tenant LDAP base
  resolution via `--scim-user-base-template` / `--scim-group-base-template`
- Add `core/auth/authzDynamic` plugin: bearer-token authentication and
  per-branch authorization sourced from a dedicated LDAP branch, with
  in-memory cache (TTL + optional reload endpoint), constant-time
  password verification, and `AsyncLocalStorage`-scoped ACL enforcement
  on every downstream LDAP operation

### Security

- Enforce base-DN scope in `LdapFlat` operations: full DNs must be a
  direct child of the configured base, blocking sibling-branch access
  via crafted DNs
- Reject escaped-comma DN injection in `LdapFlat.resolveDn`: the parent
  DN check now uses parsed RDN components, so payloads like
  `cn=pwn\,ou=titles,ou=…` can no longer bypass a textual suffix check
- Detect DNs by `mainAttribute=` prefix instead of looking for a comma,
  so RDN values that legally contain commas (e.g. `Smith, John`) are no
  longer misclassified as DNs
- Address CodeQL and Copilot findings on the SCIM and authzDynamic
  plugins
- Update dependencies

## v0.2.2 (2026-04-08)

### New Features

- Update Twake-Drive plugin to be add a data deletion method

### Security

- Update dependencies

## v0.2.1 (2026-03-02)

### Bug Fixes

- Fix Twake Drive plugin authentication: use Basic Auth instead of Bearer token
  for Cozy Admin API compatibility

## v0.2.0 (2026-03-02)

### New Features

- Add `twake/drive` plugin for Twake Drive (Cozy) integration:
  - Propagate email address changes to Twake Drive via Admin API
  - Propagate display name changes with fallback logic (displayName → cn → givenName+sn)
  - Propagate disk quota changes (`twakeDriveQuota` attribute)
  - Support domain template for flexible domain generation (e.g., `{uid}.company.cloud`)
  - Public methods: `blockInstance()`, `unblockInstance()`, `syncUserToCozy()`,
    `getCozyDomain()`, `getDisplayNameFromDN()`, `getMailFromDN()`, `getDriveQuotaFromDN()`
  - Add `onLdapDriveQuotaChange` hook for drive quota change detection
  - Add `--drive-quota-attribute` configuration option

### Security

- Update dependencies
- Add domain validation to prevent URL injection attacks in Twake Drive plugin
- Add warning log when authentication token is not configured for Twake plugins

### Documentation

- Add comprehensive documentation for Twake Drive plugin

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
