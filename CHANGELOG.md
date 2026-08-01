# Changelog

## v0.6.0 (2026-08-01)

### Breaking Changes

- `plugins/twake/appAccounts*`: applicative entries are built from an allowlist
  (`--applicative-account-attribute`) instead of the whole user entry minus
  `--ldap-operational-attribute`. An attribute not named there is no longer
  copied into the applicative branch — name it to keep it (#103)

- `plugins/twake/appAccountsConsistency`: a mail change now deletes the app
  accounts instead of recreating them without their password. They could not
  authenticate, yet were still listed and still counted against
  `--max-app-accounts` (#103)

### Security

- `lib/utils`: a DN read from a JSON body was parsed by looping on its
  `.length`, so `{"length": 1e100}` hung the worker (CWE-834). `parseDn()` and
  `unescapeDnValue()` now answer 400 on a non-string

- `plugins/ldap/groups`: `member`, `targetOrgDn` and `newCn` were forwarded
  without a type check, unlike the equivalent organization and flat-branch
  endpoints; a non-string now gets a 400

- `lsc-plugin`: jackson-databind 2.17.2 → 2.22.1, clearing five advisories
  (CVE-2026-54512, CVE-2026-54513, CVE-2026-54514, CVE-2026-54515,
  CVE-2026-59888)

## v0.5.0 (2026-08-01)

### Features

- `plugins/ldap/raw` + `browser/ldap-browser`: read-only low-level browsing of
  the directory — root DSE, parsed schema (RFC 4512, `SUP` chains resolved),
  any entry by DN with its operational attributes, the children of a node, and
  arbitrary searches. Access is bounded by `--ldap-raw-base`, narrowed by the
  authorization plugins, and credential attributes (`userPassword` and its
  Samba, Kerberos and AD counterparts) are stripped unless
  `--ldap-raw-show-secrets` says otherwise. The browser library ships a tree, a
  schema-annotated attribute table and a filter search, demo page at
  `/static/examples/web/ldap-browser.html`

- `lib/auth`: `--auth-path-prefix` scopes an authentication plugin to path
  prefixes, so one server can serve populations that authenticate differently —
  `/api/m` behind a token, `/api/admin` behind OIDC. A credential is only valid
  on the branch it was scoped to, and a plugin left unscoped guards everything
  no other plugin claims. Authentication is dispatched from a single layer the
  server mounts, so declaration order no longer decides what is protected and
  the most specific claim wins. A route outside every prefix with no unscoped
  plugin is served without authentication: those routes are named in a warning
  at startup. Plugins extending `AuthBase` no longer mount a middleware of
  their own: `api()` registers them with the dispatcher, so a third-party
  plugin that called `super.api(app)` keeps working, but one that relied on
  where its layer sat in the stack no longer can

### Bug fixes

- `bin`: a plugin loaded with overrides (`module:name:{json}`) received a
  server view built by spreading, so it carried the data but none of the
  methods and any `this.server.something()` threw

- `bin`: the error middleware was never replaced, only stacked — the lookup
  used Express 4's `app._router`, which Express 5 renamed

- `bin`: a plugin registered under a name already taken was dropped at `info`
  level, so its routes answered 404 with nothing in the log to explain it; now
  a warning naming the plugin and how to load one twice

- `plugins/auth/rateLimit`: warn when `core/auth/trustedProxy` is absent. The
  limiter keys on `X-Forwarded-For`, which is forgeable without it, and the
  brute-force protection is then decorative

- `plugins/twake/appAccountsApi`: never report a password operation that did
  not happen. `POST` used to return `200` with a password that authenticated
  nowhere when the principal update failed, and `DELETE` removed an app account
  while leaving its credential valid. Both now return `500`; `DELETE` keeps the
  account so the call stays replayable, and a password already absent counts as
  revoked (#105)

### Internal

- Tooling and tests, no runtime change: coverage is measured and gated in CI
  (`npm run coverage`, `npm run coverage:check` — 86.6% of statements on server
  code), the fourteen ESLint errors are cleared and CI now runs lint and format
  checks, and tests wait on the condition they expect instead of a fixed delay

## v0.4.7 (2026-07-26)

### Features

- `plugins/weblogs`: let any plugin enrich the access log line. The entry said
  _that_ a request happened, never _what_ was requested, so on `POST` / `DELETE`
  routes carrying their parameters in the body the URL alone was useless for
  auditing. A handler can now set `req.logDetails = { … }` and those fields are
  merged into the single `notice` entry emitted when the response completes — no
  second log line to correlate by timestamp. Core fields (`method`, `url`,
  `status`, `duration`, `ip`, `user`, `error`) always take precedence, so a
  plugin cannot spoof them (#104)

## v0.4.6 (2026-07-17)

### Features

- docker images amd64 + arm64
- CI: automated release pipeline triggered on `vX.Y.Z` tags. Each tag now
  builds and pushes multi-arch (amd64 + arm64) Docker images to
  `ghcr.io/linagora/ldap-rest` and `docker.io/yadd/ldap-rest`, publishes the
  Helm chart as an OCI artifact to `oci://ghcr.io/linagora/charts/ldap-rest`,
  publishes the npm package (via npm OIDC Trusted Publishing, with a provenance
  attestation), and cuts a matching GitHub Release. Prerelease tags
  (`vX.Y.Z-rc.N`) are published to the npm `next` dist-tag (#101, #102)
- `helm/ldap-rest`: Helm chart for deploying ldap-rest on Kubernetes. Derived
  from the in-house deployment chart (same `env` / `secrets` /
  `externalFileConfig` values interface) with TCP probes, optional ingress and
  service account, and standard Helm labels (#101)

## v0.4.5 (2026-07-16)

### Features

- `bin/sync-james`: reconcile mail aliases in addition to quotas, as a catch-up
  for aliases that were not propagated to James (e.g. when the event-based sync
  failed).

## v0.4.4 (2026-07-10)

### Features

- `plugins/twake/calendarResources`: propagate LDAP user identity changes
  (email, first name, last name) to the Twake Calendar registered users via the
  WebAdmin API. Registered users are keyed by an internal id and
  `GET /registeredUsers` exposes no filter, so the plugin lists the registered
  users, locates the entry by email, then `PATCH /registeredUsers?id={id}` with
  the LDAP values. The sync is driven by the configured mail / first name / last
  name attributes — `--calendar-firstname-attribute` (default `givenName`) and
  `--calendar-lastname-attribute` (default `sn`) (#100)

### Bug Fixes

- `plugins/twake/james`: use the standard Apache James / Twake-Mail WebAdmin
  routes. The forwards and JMAP identities calls targeted routes that do not
  exist and silently returned 404: forwards now use
  `/address/forwards/{mail}/targets/{forward}` (was
  `/domains/{domain}/forwards/…`) and identities `/users/{mail}/identities` (was
  `/jmap/identities/{mail}`). The mailbox rename call also gains the required
  `force` query parameter and is now skipped when the new mail is empty instead
  of renaming the mailbox to a literal `null` address (#99)
- `plugins/scim`: force usernames to lowercase on SCIM user creation (#96)

## v0.4.3 (2026-07-08)

### Bug Fixes

- `plugins/twake/clouderyProvision`: skip instance creation when an instance
  already exists for the computed FQDN. The instance slug is deterministic, so
  when a user is re-imported after their LDAP entry was recreated while the
  Cloudery instance survived, the existing instance is now reused instead of
  letting Cloudery mint a numbered duplicate (`slug2`). The existence lookup
  fails open: if it errors, provisioning falls through to create as before (#94)

### Misc

- Dockerfile: add the missing `DM_CLOUDERY_INVITED_ATTRIBUTE="twakeInvited"`
  environment default, backing the invited-attribute feature introduced in
  v0.4.1

## v0.4.2 (2026-07-06)

### Bug Fixes

- `plugins/twake/clouderyProvision`: force `cn` to the `userName` when
  provisioning B2B users. The core SCIM mapping sets `cn` from
  `name.formatted`, which is not the desired value for B2B provisioning (#93)

### Misc

- `plugins/twake/clouderyProvision`: added detailed provisioning logs

## v0.4.1 (2026-06-30)

### Features

- `plugins/twake/clouderyProvision`: provisioned B2B users are now marked as
  pending invitation. On provisioning, the configurable invited attribute
  (`twakeInvited` by default, set via `cloudery_invited_attribute` /
  `DM_CLOUDERY_INVITED_ATTRIBUTE`) is written as `"TRUE"` on the user entry;
  the registration app clears it to `"FALSE"` once onboarding completes (#90)

## v0.4.0 (2026-06-19)

### Breaking Changes

- `core/twake/appAccountsApi`: the `:user` path param of the app-account
  endpoints is now resolved against the **mail** attribute (globally unique) by
  default, instead of the LDAP `uid`. `uid` is not unique across the directory,
  so the previous lookup could create/list/delete app accounts against the
  wrong same-named user (#88). Callers must now pass the principal email as
  `:user`. Set `app_accounts_user_attribute=uid`
  (`DM_APP_ACCOUNTS_USER_ATTRIBUTE=uid`) to restore the previous `:user = uid`
  contract — only safe where uid is unique directory-wide. Generated
  app-account uids are now prefixed from the (sanitized) resolved `:user`
  value: `<sanitized-mail>_c<digits>` by default, still `<uid>_c<digits>` in
  uid mode
- Authorization denials from `core/auth/authzPerBranch` now return **403** for
  every operation (read, write, move, delete); previously read and move
  denials surfaced as `500`. This aligns it with `core/auth/authzDynamic`

### Bug Fixes

- SCIM writes now honour `core/auth/authzPerBranch` (#80). `core/scim` did not
  propagate the authenticated request down to the LDAP action layer, so the
  `ldap{add,modify,delete}request` authorization hooks ran without `req.user`
  and `shouldSkipAuthorization` allowed the write unconditionally — an identity
  restricted to one branch could create or delete entries in any branch via
  SCIM. The request is now threaded through every SCIM `ldap.add/modify/delete`.
  `ldap.delete` also gained a `req` argument and `AuthzBase` now implements a
  `ldapdeleterequest` hook (it enforced no delete permission before). The
  `authzDynamic` path was unaffected (it reads its token from AsyncLocalStorage)
- `core/twake/appAccountsApi`: escape LDAP filter metacharacters in principal
  and uid lookups, reject ambiguous principal lookups with `409` instead of
  silently using the first match, and guarantee a generated app-account uid is
  unique across the whole applicative branch (prevents cross-user collisions in
  the shared branch)

## v0.3.10 (2026-06-19)

### Bug Fixes

- `core/twake/appAccountsApi`: drop the unused `core/auth/token` dependency
  (#83). It auto-loaded the token-auth plugin and registered its global
  middleware, forcing Bearer auth on the app-accounts endpoints and
  returning `401` under HMAC-only deployments. The plugin never reads
  `req.user` or the token, so the dependency enabled nothing; the endpoints
  now use the deployment's configured authentication like every other API
  plugin
- `core/twake/appAccountsConsistency`: harden the re-entrancy guard so that
  deleting a single app account no longer cascades into deleting the user's
  other app accounts and principal entry (#84). The guard compared the
  configured `applicative_account_base` as a plain string suffix, which
  false-negatived on DN-format differences (case, whitespace around
  separators, escaped commas, multi-valued RDN ordering) returned by the
  server, letting the plugin's own delete event slip through and trigger the
  delete-by-mail cascade. It now relies on new `normalizeDn` / `isDnInBranch`
  helpers in `lib/utils` for a robust RDN-by-RDN comparison (`normalizeDn`
  avoids a ReDoS-prone regex flagged by CodeQL). The previously
  load-time-skipped `appAccounts*` test suites now actually run in CI, plus a
  regression test covering the single-delete case
- `sync-app-accounts`: fix the bulk backfill CLI, which previously could
  not create any principal account and never returned control. A
  base-scoped search on a missing entry raises `noSuchObject` instead of
  returning an empty set, so it is now treated as "absent" and the missing
  principal is created. Attributes that come back as empty arrays (a
  requested-but-absent attribute) are skipped to avoid `add` errors
  (`no values for attribute type`). The script now fails fast with a clear
  message when `applicative_account_base` does not exist, drops a broken
  `unbind()` teardown call, and exits cleanly once finished (pooled LDAP
  connections were keeping the process alive after the summary)

## v0.3.9 (2026-06-18)

### Bug Fixes

- `core/twake/appAccountsConsistency`: ignore mail-change events whose DN
  originates in the applicative branch (`applicative_account_base`). Those
  entries are outputs of the plugin, never source users, so reacting to the
  plugin's own writes caused idempotent `AlreadyExists` churn and, during a
  mail change, a re-entrant deletion cascade that could drop a user's app
  accounts. This makes it safe to nest `applicative_account_base` under
  `ldap_base`

## v0.3.8 (2026-06-18)

### Improvements

- `core/twake/clouderyProvision`: provisioned users now carry their
  organization role and phone numbers. The role is read from a request
  header (`--cloudery-org-role-header`, `DM_CLOUDERY_ORG_ROLE_HEADER`,
  default `x-cloudery-org-role`), falling back to
  `--cloudery-default-org-role` (`DM_CLOUDERY_DEFAULT_ORG_ROLE`, default
  `member`), and is written back to the LDAP entry under
  `--cloudery-org-role-attribute` (`DM_CLOUDERY_ORG_ROLE_ATTRIBUTE`,
  default `twakeOrganizationRole`). Phone numbers are taken from
  `--cloudery-phones-attribute` (`DM_CLOUDERY_PHONES_ATTRIBUTE`, default
  `twakePhones`) and sent during provisioning

## v0.3.7 (2026-06-17)

### New Features

- `core/twake/cozyProvision` and `core/twake/clouderyProvision`: the
  RabbitMQ routing keys for the user-created and user-deleted events are
  now configurable via `--cozy-user-created-routing-key`
  (`DM_COZY_USER_CREATED_ROUTING_KEY`) and
  `--cozy-user-deleted-routing-key` (`DM_COZY_USER_DELETED_ROUTING_KEY`),
  defaulting to `user.created` and `domain.user.deleted`

## v0.3.6 (2026-06-17)

### New Features

- New plugin `core/twake/clouderyProvision`: hooks the SCIM lifecycle to
  provision a Cloudery instance on user create and tear it down on delete.
  It writes the returned workspace FQDN and organization id back onto the
  LDAP entry, and publishes the `user.created` and
  `domain.user.deleted` events. Provisioning is gated on workflow success,
  and the deletion event is only emitted once the instance is actually
  destroyed
- `core/scim/baseResolver`: support resolving the SCIM insertion base from
  a request header, gated to a configured root and never overriding an
  explicit per-user map entry, so one shared auth token can serve every
  organization
- New shared `rabbitmq` plugin, extracted from `cozyProvision`, so any
  plugin can publish lifecycle events on a common connection
- New `lsc-plugin`: an LSC destination plugin (Java) that routes sync
  writes through ldap-rest's HTTP API instead of binding LDAP directly, so
  they benefit from ACL, schema validation, audit, and the downstream
  provisioning hooks. Supports Bearer and HMAC-SHA256 auth and maps the
  CREATE/UPDATE/DELETE/MODRDN operations onto the matching endpoints

### Build

- `rollup`: resolve external builtins and dependency subpaths

### Dependencies

- Update dependencies

## v0.3.5 (2026-05-18)

### Bug Fixes

- `core/twake/appAccountsConsistency`: rename the config key
  `ldap_operational_attributes` to `ldap_operational_attribute`, matching
  the documented CLI/env option `--ldap-operational-attribute`, so the
  configured operational-attribute list is actually applied. Also strip
  `dn` unconditionally from entries before `ldap.add`, preventing
  `LDAP add error: UndefinedTypeError: dn` failures when the operational
  attribute list is misconfigured
- `core/twake/cozyProvision`: destroy the Cozy instance on SCIM delete
  via `DELETE /instances/<domain>` on the Cozy admin API before
  publishing the `b2b` / `domain.user.deleted` event. A 404 is treated
  as success so the lifecycle stays idempotent, and the b2b event is
  emitted even when the destroy fails so peer instances still drop
  their contact cards. Avoids leftover instances silently re-attaching
  on re-import
- `core/twake/cozyProvision`: set `OIDCID` on `POST /instances` to the
  SCIM `userName`, so the OIDC callback no longer fails with
  `Invalid sub: <sub> != ""` for SCIM-provisioned users

### Build

- Docker image now uses `node:24-alpine` instead of `node:22-alpine`

### Dependencies

- Update `express-rate-limit` to 8.5.2, `fast-xml-builder` and other
  transitive deps

## v0.3.4 (2026-05-05)

### Bug Fixes

- `core/twake/cozyProvision`: a series of fixes so SCIM-provisioned
  users land on a usable Cozy instance

## v0.3.3 (2026-05-05)

### Bug Fixes

- `core/scim`: pass hook payloads as spread args to `launchHooks`
  instead of wrapping them in an array. SCIM `*done` hooks
- `core/twake/cozyProvision`: rename the user identifier in the
  `auth/user.created` message body from `sub` to `twakeId`

## v0.3.2 (2026-05-04)

### New Features

- New plugin `core/twake/cozyProvision`: hooks the SCIM lifecycle to
  provision a Cozy instance after user creation and to publish
  `auth` / `user.created` and `b2b` / `domain.user.deleted` events
  on RabbitMQ.
- New plugin `core/auth/authzPerRoute`: restricts requests by HTTP method
  and path glob based on `req.user`

### Tests

- Widen TTL margins in `cache-manager` tests to deflake CI

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
