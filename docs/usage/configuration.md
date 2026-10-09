# Configuration

All LDAP-Rest configuration options.

## Table of Contents

- [Environment Variables](#environment-variables)
  - [Array Options](#array-options)
- [General Options](#general-options)
- [LDAP Connection](#ldap-connection)
- [Special Attributes](#special-attributes)
- [Plugin Options](#plugin-options)
  - [LDAP Plugins](#ldap-plugins)
    - [core/ldap/organizations](#coreldaporganizations)
    - [core/ldap/groups](#coreldapgroups)
    - [core/ldap/externalUsersInGroups](#coreldapexternalusersingroups)
    - [core/ldap/flatGeneric](#coreldapflatgeneric)
    - [core/ldap/bulkImport](#coreldapbulkimport)
    - [core/ldap/trash](#coreldaptrash)
    - [core/ldap/onChange](#coreldaponchange)
    - [core/ldap/departmentSync](#coreldapdepartmentsync)
  - [Authentication Plugins](#authentication-plugins)
    - [core/auth/token](#coreauthtoken)
    - [core/auth/totp](#coreauthtotp)
    - [core/auth/hmac](#coreauthhmac)
    - [core/auth/llng](#coreauthllng)
    - [core/auth/openidconnect](#coreauthopenidconnect)
    - [core/auth/fake](#coreauthfake)
    - [core/bcl](#corebcl)
  - [Authorization Plugins](#authorization-plugins)
    - [Common to every authorization plugin](#common-to-every-authorization-plugin)
    - [core/auth/authzPerBranch](#coreauthauthzperbranch)
    - [core/auth/authzScope](#coreauthauthzscope)
    - [core/auth/authzPerRoute](#coreauthauthzperroute)
    - [core/auth/authzLinid1](#coreauthauthzlinid1)
  - [Security Plugins](#security-plugins)
    - [core/auth/rateLimit](#coreauthratelimit)
    - [core/auth/crowdsec](#coreauthcrowdsec)
    - [core/auth/trustedProxy](#coreauthtrustedproxy)
  - [Twake Integration Plugins](#twake-integration-plugins)
    - [core/twake/james](#coretwakejames)
    - [core/twake/calendar](#coretwakecalendar)
    - [core/twake/applicativeAccounts](#coretwakeapplicativeaccounts)
    - [core/twake/appAccountsConsistency](#coretwakeappaccountsconsistency)
  - [Utility Plugins](#utility-plugins)
    - [core/static](#corestatic)
    - [core/weblogs](#coreweblogs)
    - [core/storage](#corestorage)
    - [core/configApi](#coreconfigapi)
- [Configuration File](#configuration-file)
- [LDAP Failover](#ldap-failover)
- [Log Levels (`--log-level`)](#log-levels---log-level)

## Environment Variables

All CLI options can be set via environment variables with the `DM_` prefix.

### Array Options

Some options accept multiple values (e.g., `--plugin`, `--auth-token`, `--ldap-url`). These can be configured in several ways:

**Via CLI - repeat the option, or give it comma-separated values:**

```bash
ldap-rest --plugin core/auth/token --plugin core/ldap/flatGeneric,core/ldap/groups
```

Only options holding identifiers split on commas: `--plugin`, `--mail-domain`,
`--ldap-url`, the object class options (`--user-class`, `--group-class`,
`--ldap-organization-class`, `--external-branch-class`,
`--scim-user-object-class`, `--scim-group-object-class`,
`--twake-space-class`), the attribute
options (`--ldap-raw-hidden-attribute`, `--applicative-account-attribute`,
`--ldap-operational-attribute`, `--twake-tombstone-clear-attributes`),
`--twake-tombstone-reasons`, `--authz-for`, `--authz-dynamic-bypass` and
`--trusted-proxy`. Any other
option takes each value whole, so a DN or a secret keeps its commas.

**Via CLI - use plural form with comma-separated values:**

```bash
ldap-rest --plugins core/auth/token,core/ldap/flatGeneric,core/ldap/groups
```

The plural form splits like the environment variable, see below. Give a
DN with the repeated singular option, or separate DNs with `;` in the plural
form:

```bash
ldap-rest --ldap-raw-base ou=users,dc=example,dc=com --ldap-raw-base ou=groups,dc=example,dc=com
```

**Via environment variable - use `;` or `,` as separator:**

```bash
# Semicolon separator (preferred for values containing commas)
export DM_PLUGINS="core/auth/token;core/ldap/flatGeneric;core/ldap/groups"

# Comma separator
export DM_PLUGINS="core/auth/token,core/ldap/flatGeneric,core/ldap/groups"
```

The split depends on what the option holds. The plural form splits the same
way:

- Options holding identifiers (the list above): a value containing `;` is
  split on `;` and spaces, any other on `,` and spaces. A value starting with
  `;` is split on `;` too.
- Options holding DNs or DN expressions (`--ldap-raw-base`,
  `--james-mailing-list-branch`, `--twake-tombstone-dn`,
  `--twake-tombstone-group-bases`, `--twake-instance-dn`): split on `;` only,
  never on `,` nor spaces, as a DN holds both.
  `DM_LDAP_RAW_BASE="ou=My Unit,dc=example,dc=com"` is one DN; separate
  several DNs with `;`.
- `--auth-hmac` (`id:secret:name`) and `--auth-totp` (`secret:name[:digits]`):
  split on `;` if the value contains one, else on `,`, and on newlines (one
  entry per line), never on spaces, so a name keeps its spaces. A list
  separated by spaces is read as one entry: for HMAC the services after the
  first cannot authenticate, and for TOTP the entry is refused. Any entry that
  cannot work stops the server: an HMAC one with an empty id, secret or name or
  fewer than 3 fields, a TOTP one with an empty secret or name, too many
  fields, a secret that is not Base32 or digits that are not an integer from 6
  to 10.
- Any other option (tokens, paths, rules...): split on `;` if
  the value contains one, else on `,`, and on spaces. `DM_AUTH_TOKENS="t1 t2"`
  and `DM_AUTH_TOKENS="t1,t2"` are two tokens, and padded base64 secrets
  (`YWJj=,ZGVm=`) split on the comma.

Empty items are dropped, and each item is trimmed. A variable that is empty,
only holds whitespace or only holds separators (`;`, `${A:-};${B:-}`), such as
`${VAR:-}` in a compose file, counts as unset: the default applies, so an
environment variable cannot give an empty list to an option whose default is
not empty. The exception is `DM_LDAP_URL`, whose default `ldap://localhost` is
a guess: an empty value stops the server. The same
goes for an empty number or JSON value such as `DM_PORT=`. A number option
takes an integer only: `DM_PORT=abc`, `DM_PORT=1e3`, `--port 80abc` and
`--port --log-level debug` stop the server, and so does an empty number on the
command line, as an empty array value does.
The plural form of an option takes `;` before `,` too: `--auth-tokens 'a;b,c'`
is `a` and `b,c`.

Values given on the command line replace the default, and are added to those
of the environment variable. An empty value on the command line, such as an
unset variable expanding to nothing, stops the server: leave the option out
to keep the default.

## General Options

| CLI              | Plural           | Env               | Default          | Description                                 |
| ---------------- | ---------------- | ----------------- | ---------------- | ------------------------------------------- |
| `--port`         |                  | `DM_PORT`         | `8081`           | Listen port                                 |
| `--plugin`       | `--plugins`      | `DM_PLUGINS`      | `[]`             | Plugins to load                             |
| `--log-level`    |                  | `DM_LOG_LEVEL`    | `notice`         | Log level: error, warn, notice, info, debug |
| `--logger`       |                  | `DM_LOGGER`       | `console`        | Logger type                                 |
| `--api-prefix`   |                  | `DM_API_PREFIX`   | `/api`           | API URL prefix                              |
| `--mail-domain`  | `--mail-domains` | `DM_MAIL_DOMAIN`  | `[]`             | Mail domains                                |
| `--schemas-path` |                  | `DM_SCHEMAS_PATH` | `static/schemas` | Path to JSON schemas                        |

A schema file named by an option may extend another one, shipped or not, and
hold only the differences:
[extending a schema](../client-development/schemas/README.md#extending-a-schema).

## LDAP Connection

| CLI                          | Plural           | Env                      | Default                            | Description                                 |
| ---------------------------- | ---------------- | ------------------------ | ---------------------------------- | ------------------------------------------- |
| `--ldap-url`                 | `--ldap-urls`    | `DM_LDAP_URL`            | `ldap://localhost`                 | LDAP server URL(s)                          |
| `--ldap-dn`                  |                  | `DM_LDAP_DN`             | `cn=admin,dc=example,dc=com`       | Bind DN                                     |
| `--ldap-pwd`                 |                  | `DM_LDAP_PWD`            | `admin`                            | Password                                    |
| `--ldap-base`                |                  | `DM_LDAP_BASE`           |                                    | Base DN for searches (required)             |
| `--ldap-user-main-attribute` |                  | `DM_LDAP_USER_ATTRIBUTE` | `uid`                              | User identifier attribute                   |
| `--ldap-cache-max`           |                  | `DM_LDAP_CACHE_MAX`      | `1000`                             | Max cache entries                           |
| `--ldap-cache-ttl`           |                  | `DM_LDAP_CACHE_TTL`      | `0`                                | Search cache TTL (seconds), `0` disables it |
| `--ldap-pool-size`           |                  | `DM_LDAP_POOL_SIZE`      | `5`                                | Connection pool size                        |
| `--ldap-connection-ttl`      |                  | `DM_LDAP_CONNECTION_TTL` | `60`                               | Connection TTL (seconds)                    |
| `--user-class`               | `--user-classes` | `DM_USER_CLASSES`        | `top,twakeAccount,twakeWhitePages` | Default user objectClasses                  |

### The search cache

`--ldap-cache-ttl` holds the answers of non-paginated, base-scope searches —
single-entry lookups by DN — for that many seconds. It is **off by default**:
until the branch storing a result was repaired, nothing was ever cached, so no
deployment has run with it on, and a cache that silently serves stale entries
is not something to switch on for everyone at once.

Writes made through this service (add, modify, rename, move, delete) drop what
they change, the moved subtree included. Writes made anywhere else do not:
another replica of this service, an LSC synchronisation, a hand-run
`ldapmodify`. Each process caches on its own, and only its own writes drop what
it cached. Turn the cache on when this service is the only writer, or when
serving an entry up to `--ldap-cache-ttl` seconds old is acceptable; leave it
at `0` otherwise.

## Special Attributes

| CLI                        | Env                         | Default                 | Description            |
| -------------------------- | --------------------------- | ----------------------- | ---------------------- |
| `--mail-attribute`         | `DM_MAIL_ATTRIBUTE`         | `mail`                  | Email attribute        |
| `--quota-attribute`        | `DM_QUOTA_ATTRIBUTE`        | `mailQuotaSize`         | Quota attribute        |
| `--delegation-attribute`   | `DM_DELEGATION_ATTRIBUTE`   | `twakeDelegatedUsers`   | Delegation attribute   |
| `--alias-attribute`        | `DM_ALIAS_ATTRIBUTE`        | `mailAlternateAddress`  | Email alias attribute  |
| `--forward-attribute`      | `DM_FORWARD_ATTRIBUTE`      | `mailForwardingAddress` | Forward attribute      |
| `--display-name-attribute` | `DM_DISPLAY_NAME_ATTRIBUTE` | `displayName`           | Display name attribute |

## Plugin Options

### LDAP Plugins

#### `core/ldap/organizations`

| CLI                                  | Plural                        | Env                                   | Default                                  | Description                |
| ------------------------------------ | ----------------------------- | ------------------------------------- | ---------------------------------------- | -------------------------- |
| `--ldap-top-organization`            |                               | `DM_LDAP_TOP_ORGANIZATION`            |                                          | Top organization DN        |
| `--ldap-organization-class`          | `--ldap-organization-classes` | `DM_LDAP_ORGANIZATION_CLASSES`        | `top,organizationalUnit,twakeDepartment` | Organization objectClasses |
| `--ldap-organization-link-attribute` |                               | `DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE` | `twakeDepartmentLink`                    | Link attribute             |
| `--ldap-organization-path-attribute` |                               | `DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE` | `twakeDepartmentPath`                    | Path attribute             |
| `--ldap-organization-path-separator` |                               | `DM_LDAP_ORGANIZATION_PATH_SEPARATOR` | `/`                                      | Path separator             |
| `--ldap-organization-max-subnodes`   |                               | `DM_LDAP_ORGANIZATION_MAX_SUBNODES`   | `50`                                     | Max subnodes returned      |

#### `core/ldap/groups`

| CLI                                | Plural            | Env                             | Default                            | Description                 |
| ---------------------------------- | ----------------- | ------------------------------- | ---------------------------------- | --------------------------- |
| `--ldap-group-base`                |                   | `DM_LDAP_GROUP_BASE`            |                                    | Groups base DN              |
| `--ldap-groups-main-attribute`     |                   | `DM_LDAP_GROUPS_MAIN_ATTRIBUTE` | `cn`                               | Group identifier attribute  |
| `--group-class`                    | `--group-classes` | `DM_GROUP_CLASSES`              | `top,groupOfNames`                 | Group objectClasses         |
| `--group-allow-unexistent-members` |                   | `DM_ALLOW_UNEXISTENT_MEMBERS`   | `false`                            | Allow non-existent members  |
| `--group-default-attributes`       |                   | `DM_GROUP_DEFAULT_ATTRIBUTES`   | `{}`                               | Default attributes (JSON)   |
| `--group-dummy-user`               |                   | `DM_GROUP_DUMMY_USER`           | `cn=fakeuser`                      | Dummy user for empty groups |
| `--group-schema`                   |                   | `DM_GROUP_SCHEMA`               | `static/schemas/twake/groups.json` | Group JSON schema path      |

#### `core/ldap/externalUsersInGroups`

| CLI                         | Plural                      | Env                          | Default                         | Description                 |
| --------------------------- | --------------------------- | ---------------------------- | ------------------------------- | --------------------------- |
| `--external-members-branch` |                             | `DM_EXTERNAL_MEMBERS_BRANCH` | `ou=contacts,dc=example,dc=com` | External contacts branch    |
| `--external-branch-class`   | `--external-branch-classes` | `DM_EXTERNAL_BRANCH_CLASSES` | `top,inetOrgPerson`             | External user objectClasses |

#### `core/ldap/flatGeneric`

| CLI                       | Plural                | Env                        | Default | Description                                                                                                                           |
| ------------------------- | --------------------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--ldap-flat-schema`      | `--ldap-flat-schemas` | `DM_LDAP_FLAT_SCHEMA`      | `[]`    | Entity schema path(s)                                                                                                                 |
| `--ldap-flat-auto-repair` |                       | `DM_LDAP_FLAT_AUTO_REPAIR` | `true`  | Add the auxiliary class a write needs to an entry lacking it — [details](plugins/ldap/flat-generic.md#entries-created-by-other-tools) |

#### `core/ldap/bulkImport`

| CLI                           | Env                            | Default    | Description              |
| ----------------------------- | ------------------------------ | ---------- | ------------------------ |
| `--bulk-import-schemas`       | `DM_BULK_IMPORT_SCHEMAS`       |            | Bulk import schemas path |
| `--bulk-import-max-file-size` | `DM_BULK_IMPORT_MAX_FILE_SIZE` | `10485760` | Max file size (bytes)    |
| `--bulk-import-batch-size`    | `DM_BULK_IMPORT_BATCH_SIZE`    | `100`      | Batch size               |

#### `core/ldap/trash`

| CLI                     | Env                      | Default | Description                 |
| ----------------------- | ------------------------ | ------- | --------------------------- |
| `--trash-base`          | `DM_TRASH_BASE`          |         | Trash container DN          |
| `--trash-watched-bases` | `DM_TRASH_WATCHED_BASES` |         | `;`-separated DNs to watch  |
| `--trash-add-metadata`  | `DM_TRASH_ADD_METADATA`  | `true`  | Add deletion metadata       |
| `--trash-auto-create`   | `DM_TRASH_AUTO_CREATE`   | `true`  | Auto-create trash container |

#### `core/ldap/onChange`

Monitors LDAP modifications and triggers hooks for attribute changes. No configuration options - uses [Special Attributes](#special-attributes) settings.

**Hooks triggered:**

- `onLdapChange` - Any LDAP modification
- `onLdapMailChange` - Mail attribute changes
- `onLdapQuotaChange` - Quota attribute changes
- `onLdapAliasChange` - Alias attribute changes
- `onLdapForwardChange` - Forward attribute changes
- `onLdapDisplayNameChange` - Display name changes (`--display-name-attribute`, else cn, else givenName and sn)

#### `core/ldap/departmentSync`

Maintains consistency of department links when organizations are renamed/moved: it recomputes the path of the organization and of its sub-organizations (those already holding one), then updates the link and path of the entries linked to any of them. The attributes are those the loaded schemas declare through the `organizationPath` and `organizationLink` roles, then the configured `--ldap-organization-path-attribute` and `--ldap-organization-link-attribute`. No configuration options of its own - uses [core/ldap/organizations](#coreldaporganizations) settings.

#### `core/ldap/raw`

Read-only low-level browsing (root DSE, schema, entries). See [raw plugin](plugins/ldap/raw.md).

| CLI                           | Plural                         | Env                             | Default       | Description                                                          |
| ----------------------------- | ------------------------------ | ------------------------------- | ------------- | -------------------------------------------------------------------- |
| `--ldap-raw-base`             | `--ldap-raw-bases`             | `DM_LDAP_RAW_BASE`              | `--ldap-base` | Subtrees exposed by the API                                          |
| `--ldap-raw-hidden-attribute` | `--ldap-raw-hidden-attributes` | `DM_LDAP_RAW_HIDDEN_ATTRIBUTES` | `[]`          | Extra attributes never returned                                      |
| `--ldap-raw-show-secrets`     |                                | `DM_LDAP_RAW_SHOW_SECRETS`      | `false`       | Serve credential attributes                                          |
| `--ldap-raw-max-results`      |                                | `DM_LDAP_RAW_MAX_RESULTS`       | `200`         | Max entries per search/listing                                       |
| `--ldap-raw-schema-cache-ttl` |                                | `DM_LDAP_RAW_SCHEMA_CACHE_TTL`  | `3600`        | Schema cache lifetime (seconds), shared with the object class repair |

### Authentication Plugins

#### Common to every authentication plugin

| CLI                  | Plural                 | Env                   | Default | Description                                 |
| -------------------- | ---------------------- | --------------------- | ------- | ------------------------------------------- |
| `--auth-path-prefix` | `--auth-path-prefixes` | `DM_AUTH_PATH_PREFIX` | `[]`    | Restrict this plugin to these path prefixes |

Empty means the plugin guards every path. Scoping several instances to different prefixes lets one server serve populations that authenticate differently — see [Serving several populations from one server](plugins/auth/README.md#serving-several-populations-from-one-server), including the routes it can leave unauthenticated.

#### `core/auth/token`

| CLI            | Plural          | Env              | Default | Description           |
| -------------- | --------------- | ---------------- | ------- | --------------------- |
| `--auth-token` | `--auth-tokens` | `DM_AUTH_TOKENS` | `[]`    | Authentication tokens |

#### `core/auth/fake`

| CLI                | Env                 | Default | Description                                    |
| ------------------ | ------------------- | ------- | ---------------------------------------------- |
| `--auth-fake-user` | `DM_AUTH_FAKE_USER` |         | Identity every request is served as (required) |

Development only, refused with `NODE_ENV=production` — see [Fake Authentication](plugins/auth/fake.md).

#### `core/auth/totp`

| CLI                  | Plural         | Env                   | Default | Description                      |
| -------------------- | -------------- | --------------------- | ------- | -------------------------------- |
| `--auth-totp`        | `--auth-totps` | `DM_AUTH_TOTP`        | `[]`    | TOTP config (secret:name:digits) |
| `--auth-totp-window` |                | `DM_AUTH_TOTP_WINDOW` | `1`     | Validation window                |
| `--auth-totp-step`   |                | `DM_AUTH_TOTP_STEP`   | `30`    | Time step (seconds)              |

#### `core/auth/hmac`

| CLI                  | Plural         | Env                   | Default  | Description                          |
| -------------------- | -------------- | --------------------- | -------- | ------------------------------------ |
| `--auth-hmac`        | `--auth-hmacs` | `DM_AUTH_HMAC`        | `[]`     | HMAC config (service-id:secret:name) |
| `--auth-hmac-window` |                | `DM_AUTH_HMAC_WINDOW` | `120000` | Time window (ms)                     |

#### `core/auth/llng`

| CLI                      | Env                       | Default                              | Description                                                                                        |
| ------------------------ | ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `--llng-ini`             | `DM_LLNG_INI`             | `/etc/lemonldap-ng/lemonldap-ng.ini` | LemonLDAP::NG config path                                                                          |
| `--llng-username-header` | `DM_LLNG_USERNAME_HEADER` |                                      | Header LLNG exports with the login, published as `req.userName` (see [llng](plugins/auth/llng.md)) |

#### `core/auth/openidconnect`

| CLI                     | Env                      | Default | Description                                                                             |
| ----------------------- | ------------------------ | ------- | --------------------------------------------------------------------------------------- |
| `--oidc-server`         | `DM_OIDC_SERVER`         |         | OIDC server URL                                                                         |
| `--oidc-client-id`      | `DM_OIDC_CLIENT_ID`      |         | OIDC Client ID                                                                          |
| `--oidc-client-secret`  | `DM_OIDC_CLIENT_SECRET`  |         | OIDC Client Secret                                                                      |
| `--oidc-username-claim` | `DM_OIDC_USERNAME_CLAIM` | `sub`   | Claim naming the caller, published as `req.userName` (see [OIDC](plugins/auth/oidc.md)) |
| `--base-url`            | `DM_BASE_URL`            |         | Public URL for callbacks                                                                |

#### `core/bcl`

Back-Channel Logout: a logout performed at the provider ends the session here
on the next request. Needs `core/storage`, and refuses to start without it —
see [Back-Channel Logout](plugins/auth/back-channel-logout.md).

| CLI               | Env                | Default  | Description                 |
| ----------------- | ------------------ | -------- | --------------------------- |
| `--bcl-retention` | `DM_BCL_RETENTION` | `604800` | Seconds a tombstone is kept |

### Authorization Plugins

#### Common to every authorization plugin

| CLI                       | Env                        | Default    | Description                                                                                                                                                                                                                       |
| ------------------------- | -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--authz-unresolved-user` | `DM_AUTHZ_UNRESOLVED_USER` | `deny`     | What an authenticated identity the plugin cannot resolve means: `deny` refuses the operation, `allow` lets it through with a warning                                                                                              |
| `--authz-identity`        | `DM_AUTHZ_IDENTITY`        | `req.user` | Which value rules are keyed on: `req.user`, this server's identifier for the caller, or `req.userName`, the caller under a name a person would use. See [what a rule is keyed on](plugins/auth/README.md#what-a-rule-is-keyed-on) |
| `--authz-for`             | `DM_AUTHZ_FOR`             |            | The authentication plugins, by instance name, whose requests the plugin judges; unset, every authenticated request. Meant for a plugin's own overrides: `{"authz_for":["oidc"]}`                                                  |
| `--authz-combine`         | `DM_AUTHZ_COMBINE`         | `false`    | Let two plugins judging the LDAP operations of the same requests start together, as an AND                                                                                                                                        |

`--authz-unresolved-user` is read by the plugins that resolve an identity
before judging it — `core/auth/authzPerBranch` and `core/auth/authzLinid1`.
`core/auth/authzPerRoute` matches the identity as it stands and
`core/auth/authzDynamic` judges a token, so neither resolves anything and
neither reads it. A value other than `deny` or `allow` is refused at startup.

An **anonymous** request is not this case: it carries no identity, and every
authorization plugin skips it as before. This is about a caller the
authenticator admitted whose identity the authorization model cannot place —
`authzLinid1` looking up a `uid` that does not exist, typically because the
authenticator publishes something else. `allow` is the behaviour every plugin
had before 0.8.3, and it is an open door where `authzLinid1` is loaded: see
[the note](upgrading.md#an-identity-that-does-not-resolve-is-refused).

`--authz-for` and `--authz-combine` say how plugins loaded together compose:
without them, two plugins judging the LDAP operations of the same requests
are refused at startup — see [several authorization
plugins](plugins/auth/README.md#several-authorization-plugins).

`--authz-for` takes one name per occurrence: repeat it
(`--authz-for oidc --authz-for authToken`), or give the environment variable
a list (`DM_AUTHZ_FOR="oidc authToken"`). A second word after the value —
`--authz-for oidc authToken` — is refused rather than dropped, as it is after
every option taking a list.

`--authz-identity` is a different question, and the paragraphs above are not
about it: `core/auth/authzPerRoute` and the SCIM base map read it as well,
since a route rule and the base a SCIM operation is served from are keyed on
whichever of the two names it selects. A value other than `req.user` or
`req.userName` is refused at startup.

#### `core/auth/authzPerBranch`

| CLI                               | Env                                | Default                                          | Description                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--authz-per-branch-config`       | `DM_AUTHZ_PER_BRANCH_CONFIG`       | `{default:{read:true,write:false,delete:false}}` | Authorization config (JSON)                                                                                                                                                                                                                                                                                                                     |
| `--authz-per-branch-cache-ttl`    | `DM_AUTHZ_PER_BRANCH_CACHE_TTL`    | `60`                                             | Cache TTL (seconds)                                                                                                                                                                                                                                                                                                                             |
| `--authz-filter-attached-entries` | `DM_AUTHZ_FILTER_ATTACHED_ENTRIES` | `false`                                          | Judge an attached entry by the organization it hangs off, and filter listings accordingly. Honoured by `authzPerBranch`; always on under `authzLinid1`; does nothing under `authzDynamic`.                                                                                                                                                      |
| `--authz-transit-branch`          | `DM_AUTHZ_TRANSIT_BRANCH`          |                                                  | Organization entries are handed over through when they are judged by attachment: every administrator sees and may claim what is there, and puts an entry there with write on the organization it leaves. An entry attached to no organization is in transit too. See [authzLinid1](plugins/auth/authz-linid1.md#transit-handing-an-entry-over). |

#### `core/auth/authzScope`

| CLI                    | Env                     | Default | Description                                                                                                                                                    |
| ---------------------- | ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--authz-scope-source` | `DM_AUTHZ_SCOPE_SOURCE` |         | The plugin, by instance name, that describes a caller's scope when several judge them; unset, the first loaded. See [authz-scope](plugins/auth/authz-scope.md) |

#### `core/auth/authzPerRoute`

| CLI                 | Env                   | Default | Description                                                            |
| ------------------- | --------------------- | ------- | ---------------------------------------------------------------------- |
| `--authz-per-route` | `DM_AUTHZ_PER_ROUTES` | `[]`    | Per-user route ACL rules (see [docs](plugins/auth/authz-per-route.md)) |

#### `core/auth/authzLinid1`

| CLI                             | Env                              | Default               | Description           |
| ------------------------------- | -------------------------------- | --------------------- | --------------------- |
| `--authz-local-admin-attribute` | `DM_AUTHZ_LOCAL_ADMIN_ATTRIBUTE` | `twakeLocalAdminLink` | Local admin attribute |

### Security Plugins

#### `core/auth/rateLimit`

| CLI                      | Env                       | Default  | Description              |
| ------------------------ | ------------------------- | -------- | ------------------------ |
| `--rate-limit-window-ms` | `DM_RATE_LIMIT_WINDOW_MS` | `900000` | Time window (ms, 15 min) |
| `--rate-limit-max`       | `DM_RATE_LIMIT_MAX`       | `100`    | Max requests per window  |

#### `core/auth/crowdsec`

| CLI                    | Env                     | Default                              | Description         |
| ---------------------- | ----------------------- | ------------------------------------ | ------------------- |
| `--crowdsec-url`       | `DM_CROWDSEC_URL`       | `http://localhost:8080/v1/decisions` | CrowdSec API URL    |
| `--crowdsec-api-key`   | `DM_CROWDSEC_API_KEY`   |                                      | CrowdSec API key    |
| `--crowdsec-cache-ttl` | `DM_CROWDSEC_CACHE_TTL` | `60`                                 | Cache TTL (seconds) |

#### `core/auth/trustedProxy`

| CLI                           | Plural              | Env                            | Default     | Description            |
| ----------------------------- | ------------------- | ------------------------------ | ----------- | ---------------------- |
| `--trusted-proxy`             | `--trusted-proxies` | `DM_TRUSTED_PROXIES`           | `[]`        | Trusted proxy IPs/CIDR |
| `--trusted-proxy-auth-header` |                     | `DM_TRUSTED_PROXY_AUTH_HEADER` | `Auth-User` | User header name       |

### Twake Integration Plugins

#### `core/twake/james`

| CLI                              | Plural                          | Env                               | Default                 | Description                 |
| -------------------------------- | ------------------------------- | --------------------------------- | ----------------------- | --------------------------- |
| `--james-webadmin-url`           |                                 | `DM_JAMES_WEBADMIN_URL`           | `http://localhost:8000` | James WebAdmin API URL      |
| `--james-webadmin-token`         |                                 | `DM_JAMES_WEBADMIN_TOKEN`         |                         | James authentication token  |
| `--james-signature-template`     |                                 | `DM_JAMES_SIGNATURE_TEMPLATE`     |                         | Email signature template    |
| `--james-concurrency`            |                                 | `DM_JAMES_CONCURRENCY`            | `10`                    | James API concurrency       |
| `--james-init-delay`             |                                 | `DM_JAMES_INIT_DELAY`             | `1000`                  | Init delay (ms)             |
| `--james-mailing-list-branch`    | `--james-mailing-list-branches` | `DM_JAMES_MAILING_LIST_BRANCHES`  | `[]`                    | Mailing list branches       |
| `--james-mailbox-type-attribute` |                                 | `DM_JAMES_MAILBOX_TYPE_ATTRIBUTE` | `twakeMailboxType`      | Mailbox type attribute      |
| `--ldap-concurrency`             |                                 | `DM_LDAP_CONCURRENCY`             | `10`                    | LDAP operations concurrency |

#### `core/twake/calendar`

Formerly `core/twake/calendarResources`, still accepted as a deprecated alias.

| CLI                               | Env                                | Default                 | Description                   |
| --------------------------------- | ---------------------------------- | ----------------------- | ----------------------------- |
| `--calendar-webadmin-url`         | `DM_CALENDAR_WEBADMIN_URL`         | `http://localhost:8080` | Calendar API URL              |
| `--calendar-webadmin-token`       | `DM_CALENDAR_WEBADMIN_TOKEN`       |                         | Calendar authentication token |
| `--calendar-concurrency`          | `DM_CALENDAR_CONCURRENCY`          | `10`                    | API concurrency               |
| `--calendar-resource-base`        | `DM_CALENDAR_RESOURCE_BASE`        |                         | Resource base DN              |
| `--calendar-resource-objectclass` | `DM_CALENDAR_RESOURCE_OBJECTCLASS` |                         | Resource objectClass          |
| `--calendar-resource-creator`     | `DM_CALENDAR_RESOURCE_CREATOR`     |                         | Resource creator              |
| `--calendar-resource-domain`      | `DM_CALENDAR_RESOURCE_DOMAIN`      |                         | Resource domain               |
| `--calendar-firstname-attribute`  | `DM_CALENDAR_FIRSTNAME_ATTRIBUTE`  | `givenName`             | Registered user first name    |
| `--calendar-lastname-attribute`   | `DM_CALENDAR_LASTNAME_ATTRIBUTE`   | `sn`                    | Registered user last name     |

#### `core/twake/applicativeAccounts`

| CLI                               | Plural                             | Env                                 | Default       | Description                           |
| --------------------------------- | ---------------------------------- | ----------------------------------- | ------------- | ------------------------------------- |
| `--applicative-account-base`      |                                    | `DM_APPLICATIVE_ACCOUNT_BASE`       |               | Applicative accounts base DN          |
| `--max-app-accounts`              |                                    | `DM_MAX_APP_ACCOUNTS`               | `5`           | Max accounts per user                 |
| `--applicative-account-attribute` | `--applicative-account-attributes` | `DM_APPLICATIVE_ACCOUNT_ATTRIBUTES` | _(see below)_ | Attributes copied from the user entry |
| `--ldap-operational-attribute`    | `--ldap-operational-attributes`    | `DM_LDAP_OPERATIONAL_ATTRIBUTES`    | _(see below)_ | Operational attributes to exclude     |

Default copied attributes: `objectClass`, `cn`, `sn`, `givenName`, `displayName`, `description` — plus the configured mail attribute, always.

This is an **allowlist**: an attribute the user entry carries but that is not
named here is not copied into the applicative branch. That branch is only ever
read to bind with `uid` and `userPassword`, so anything else has no reason to
be duplicated there — and a new attribute added to the user schema later stays
out unless someone opts in.

Default operational attributes: `dn`, `controls`, `structuralObjectClass`, `entryUUID`, `entryDN`, `subschemaSubentry`, `modifyTimestamp`, `modifiersName`, `createTimestamp`, `creatorsName`, `userPassword`

Operational attributes are only used when an applicative entry is **recreated
from its own current state** (on a mail change): they are what the directory
generates and would refuse on an `add`. `userPassword` is in that list on
purpose — a mail change forces every client to be reconfigured anyway, so app
accounts are deliberately reissued without a password.

#### `core/twake/appAccountsConsistency`

Automatically creates/updates/deletes applicative account entries when users are created/modified/deleted. No configuration options - uses [core/twake/applicativeAccounts](#coretwakeapplicativeaccounts) settings.

**Requires:** `core/ldap/onChange`

#### `core/twake/lifecycleEvents`

| CLI                                      | Env                                       | Default                      | Description                                                                                                      |
| ---------------------------------------- | ----------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--twake-lifecycle-role-attribute`       | `DM_TWAKE_LIFECYCLE_ROLE_ATTRIBUTE`       |                              | Role attribute                                                                                                   |
| `--twake-lifecycle-lock-attribute`       | `DM_TWAKE_LIFECYCLE_LOCK_ATTRIBUTE`       | `--scim-user-lock-attribute` | Lock attribute                                                                                                   |
| `--twake-lifecycle-lock-value`           | `DM_TWAKE_LIFECYCLE_LOCK_VALUE`           | see description              | Value marking an account locked: SCIM's with SCIM's attribute, required with another than `pwdAccountLockedTime` |
| `--twake-lifecycle-deleted-attribute`    | `DM_TWAKE_LIFECYCLE_DELETED_ATTRIBUTE`    |                              | Attribute marking a tombstone                                                                                    |
| `--twake-lifecycle-deleted-value`        | `DM_TWAKE_LIFECYCLE_DELETED_VALUE`        | `TRUE`                       | Value marking a tombstone                                                                                        |
| `--twake-lifecycle-deleted-at-attribute` | `DM_TWAKE_LIFECYCLE_DELETED_AT_ATTRIBUTE` |                              | Deletion date attribute                                                                                          |
| `--twake-lifecycle-deleted-at-format`    | `DM_TWAKE_LIFECYCLE_DELETED_AT_FORMAT`    | `iso8601`                    | `iso8601` or `generalizedTime`                                                                                   |
| `--twake-lifecycle-rules`                | `DM_TWAKE_LIFECYCLE_RULES`                |                              | Rules: a JSON file, or the JSON itself                                                                           |
| `--twake-lifecycle-member-attribute`     | `DM_TWAKE_LIFECYCLE_MEMBER_ATTRIBUTE`     | `member`                     | Attribute holding a group's members                                                                              |

See [lifecycle events](plugins/integrations/lifecycle-events.md).

**Requires:** `core/ldap/onChange`, `core/rabbitmq`

#### `core/twake/instances`

| CLI                                              | Env                                               | Default                               | Description                                               |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `--twake-instance-dn`                            | `DM_TWAKE_INSTANCE_DN`                            | `[]`                                  | DN expressions of the accounts to equip                   |
| `--twake-instance-skip-attribute`                | `DM_TWAKE_INSTANCE_SKIP_ATTRIBUTE`                |                                       | Attribute marking an account with no instance             |
| `--twake-instance-skip-value`                    | `DM_TWAKE_INSTANCE_SKIP_VALUE`                    |                                       | Its value                                                 |
| `--twake-instance-provider`                      | `DM_TWAKE_INSTANCE_PROVIDER`                      | `cloudery`                            | `cloudery` or `cozy-stack`                                |
| `--twake-instance-id`                            | `DM_TWAKE_INSTANCE_ID`                            | `{uid}`                               | Instance id template                                      |
| `--twake-instance-fqdn-attribute`                | `DM_TWAKE_INSTANCE_FQDN_ATTRIBUTE`                | `twakeWorkspaceUrl`                   | Address attribute                                         |
| `--twake-instance-sent-attribute`                | `DM_TWAKE_INSTANCE_SENT_ATTRIBUTE`                | `twakeCreatedEventAt`                 | Date the creation event was sent                          |
| `--twake-instance-locale`                        | `DM_TWAKE_INSTANCE_LOCALE`                        | `en`, `fr` with cozy-stack            | Locale when the entry has none                            |
| `--twake-instance-timeout`                       | `DM_TWAKE_INSTANCE_TIMEOUT`                       | `30000`                               | Milliseconds a provider call may take                     |
| `--twake-instance-cloudery-url`                  | `DM_TWAKE_INSTANCE_CLOUDERY_URL`                  |                                       | Cloudery API                                              |
| `--twake-instance-cloudery-token`                | `DM_TWAKE_INSTANCE_CLOUDERY_TOKEN`                |                                       | Its token                                                 |
| `--twake-instance-cloudery-domain`               | `DM_TWAKE_INSTANCE_CLOUDERY_DOMAIN`               |                                       | Domain of the instances                                   |
| `--twake-instance-cloudery-offer`                | `DM_TWAKE_INSTANCE_CLOUDERY_OFFER`                | `b2b_twake_default`                   | Offer of an account's instance, or one per DN expression  |
| `--twake-instance-cloudery-organization-offer`   | `DM_TWAKE_INSTANCE_CLOUDERY_ORGANIZATION_OFFER`   |                                       | Offer of an organization's instance                       |
| `--twake-instance-cozy-url`                      | `DM_TWAKE_INSTANCE_COZY_URL`                      |                                       | cozy-stack admin API                                      |
| `--twake-instance-cozy-user`                     | `DM_TWAKE_INSTANCE_COZY_USER`                     | `admin`                               | Its user                                                  |
| `--twake-instance-cozy-passphrase`               | `DM_TWAKE_INSTANCE_COZY_PASSPHRASE`               |                                       | Its passphrase                                            |
| `--twake-instance-cozy-domain`                   | `DM_TWAKE_INSTANCE_COZY_DOMAIN`                   |                                       | Domain of the instances                                   |
| `--twake-instance-cozy-context`                  | `DM_TWAKE_INSTANCE_COZY_CONTEXT`                  | `default`                             | cozy-stack context                                        |
| `--twake-instance-cozy-apps`                     | `DM_TWAKE_INSTANCE_COZY_APPS`                     | `home,drive,settings,notes,dataproxy` | Apps installed on a new instance                          |
| `--twake-instance-cozy-org-id`                   | `DM_TWAKE_INSTANCE_COZY_ORG_ID`                   |                                       | Organization id when the DN gives none                    |
| `--twake-instance-cozy-org-domain`               | `DM_TWAKE_INSTANCE_COZY_ORG_DOMAIN`               |                                       | Organization domain when the DN gives none                |
| `--twake-instance-auth-exchange`                 | `DM_TWAKE_INSTANCE_AUTH_EXCHANGE`                 | `auth`                                | Exchange of account events                                |
| `--twake-instance-b2b-exchange`                  | `DM_TWAKE_INSTANCE_B2B_EXCHANGE`                  | `b2b`                                 | Exchange of organization events                           |
| `--twake-instance-user-created-key`              | `DM_TWAKE_INSTANCE_USER_CREATED_KEY`              | `user.created`                        | Routing key of an account's creation                      |
| `--twake-instance-organization-created-key`      | `DM_TWAKE_INSTANCE_ORGANIZATION_CREATED_KEY`      | `organization.created`                | Routing key of an organization's creation                 |
| `--twake-instance-workplace-created-key`         | `DM_TWAKE_INSTANCE_WORKPLACE_CREATED_KEY`         | `workplace.created`                   | Routing key the Cloudery announces on                     |
| `--twake-instance-queue`                         | `DM_TWAKE_INSTANCE_QUEUE`                         | `workplace.created.ldap-rest`         | Queue shared by the replicas                              |
| `--twake-instance-organization-base`             | `DM_TWAKE_INSTANCE_ORGANIZATION_BASE`             |                                       | Branch of the organization entries                        |
| `--twake-instance-organization-id-attribute`     | `DM_TWAKE_INSTANCE_ORGANIZATION_ID_ATTRIBUTE`     | `ou`                                  | Attribute holding an organization's id                    |
| `--twake-instance-organization-domain-attribute` | `DM_TWAKE_INSTANCE_ORGANIZATION_DOMAIN_ATTRIBUTE` | `twakeDomain`                         | Attribute holding an organization's domain                |
| `--twake-instance-organization-name-attribute`   | `DM_TWAKE_INSTANCE_ORGANIZATION_NAME_ATTRIBUTE`   | `description`                         | Attribute holding an organization's name                  |
| `--twake-instance-organization-fqdn-attribute`   | `DM_TWAKE_INSTANCE_ORGANIZATION_FQDN_ATTRIBUTE`   |                                       | Address attribute of an organization (empty: not written) |

See [instances](plugins/integrations/instances.md).

**Requires:** `core/rabbitmq`

#### `core/twake/tombstone`

Reads the `--twake-lifecycle-*` attributes above, and:

| CLI                                  | Env                                   | Default             | Description                               |
| ------------------------------------ | ------------------------------------- | ------------------- | ----------------------------------------- |
| `--twake-lifecycle-reason-attribute` | `DM_TWAKE_LIFECYCLE_REASON_ATTRIBUTE` |                     | Deletion reason attribute                 |
| `--twake-tombstone-dn`               | `DM_TWAKE_TOMBSTONE_DN`               | `[]`                | DN patterns of entries kept as tombstones |
| `--twake-tombstone-default-reason`   | `DM_TWAKE_TOMBSTONE_DEFAULT_REASON`   | `deleted`           | Reason when none is given                 |
| `--twake-tombstone-reason-header`    | `DM_TWAKE_TOMBSTONE_REASON_HEADER`    | `x-deletion-reason` | Request header carrying the reason        |
| `--twake-tombstone-reasons`          | `DM_TWAKE_TOMBSTONE_REASONS`          | `[]`                | Accepted reasons (empty: any)             |
| `--twake-tombstone-clear-attributes` | `DM_TWAKE_TOMBSTONE_CLEAR_ATTRIBUTES` | `[]`                | Attributes removed from a tombstone       |
| `--twake-tombstone-erase-min-age`    | `DM_TWAKE_TOMBSTONE_ERASE_MIN_AGE`    | `2592000`           | Seconds before a tombstone may be erased  |
| `--twake-tombstone-group-bases`      | `DM_TWAKE_TOMBSTONE_GROUP_BASES`      | `--ldap-group-base` | Where memberships are removed at erase    |

See [tombstone](plugins/integrations/tombstone.md).

#### `core/twake/groups`

Extends `core/ldap/groups`, whose options it reads too.

| CLI                                           | Env                                            | Default            | Description                                           |
| --------------------------------------------- | ---------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `--twake-group-base`                          | `DM_TWAKE_GROUP_BASE`                          |                    | Group branch of an organization, with `{org}`         |
| `--twake-group-user-base`                     | `DM_TWAKE_GROUP_USER_BASE`                     |                    | User branch of an organization, with `{org}`          |
| `--twake-group-organization-dn`               | `DM_TWAKE_GROUP_ORGANIZATION_DN`               |                    | Organization entry, with `{org}` (empty: not checked) |
| `--twake-group-organization-status-attribute` | `DM_TWAKE_GROUP_ORGANIZATION_STATUS_ATTRIBUTE` | `twakeOrgStatus`   | Organization status attribute                         |
| `--twake-group-organization-deleted-value`    | `DM_TWAKE_GROUP_ORGANIZATION_DELETED_VALUE`    | `deleted`          | Status of a deleted organization                      |
| `--twake-group-display-name-attribute`        | `DM_TWAKE_GROUP_DISPLAY_NAME_ATTRIBUTE`        | `twakeDisplayName` | Group display name attribute                          |
| `--twake-group-color-attribute`               | `DM_TWAKE_GROUP_COLOR_ATTRIBUTE`               | `twakeGroupColor`  | Group color attribute                                 |
| `--twake-group-created-at-attribute`          | `DM_TWAKE_GROUP_CREATED_AT_ATTRIBUTE`          | `twakeCreatedAt`   | Group creation date attribute                         |
| `--twake-group-max-page-limit`                | `DM_TWAKE_GROUP_MAX_PAGE_LIMIT`                | `1000`             | Largest page, and most users added at once            |
| `--twake-group-member-fields`                 | `DM_TWAKE_GROUP_MEMBER_FIELDS`                 | `{}`               | Member profile fields over the defaults, as JSON      |

See [groups](plugins/integrations/groups.md).

#### `core/twake/spaces`

Requires `core/twake/groups`, whose options it reads for users, groups and the
organization entry, and `core/ldap/onChange`; with `--rabbitmq-url`, it
requires `core/rabbitmq` and reads the organization domain from
`--twake-instance-organization-domain-attribute`.

| CLI                                    | Env                                     | Default                                | Description                                        |
| -------------------------------------- | --------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `--twake-space-base`                   | `DM_TWAKE_SPACE_BASE`                   |                                        | Space branch of an organization, with `{org}`      |
| `--twake-space-class`                  | `DM_TWAKE_SPACE_CLASS`                  | `top,twakeSpace`                       | Object classes of a space                          |
| `--twake-space-display-name-attribute` | `DM_TWAKE_SPACE_DISPLAY_NAME_ATTRIBUTE` | `twakeDisplayName`                     | Space name attribute                               |
| `--twake-space-admin-attribute`        | `DM_TWAKE_SPACE_ADMIN_ATTRIBUTE`        | `twakeSpaceAdmin`                      | DNs holding the admin role                         |
| `--twake-space-editor-attribute`       | `DM_TWAKE_SPACE_EDITOR_ATTRIBUTE`       | `twakeSpaceEditor`                     | DNs holding the editor role                        |
| `--twake-space-viewer-attribute`       | `DM_TWAKE_SPACE_VIEWER_ATTRIBUTE`       | `twakeSpaceViewer`                     | DNs holding the viewer role                        |
| `--twake-space-user-role-attribute`    | `DM_TWAKE_SPACE_USER_ROLE_ATTRIBUTE`    |                                        | User attribute holding `<space id>:<role>`, if set |
| `--twake-space-exchange`               | `DM_TWAKE_SPACE_EXCHANGE`               | `space`                                | Topic exchange of the space events                 |
| `--twake-space-sync-queue`             | `DM_TWAKE_SPACE_SYNC_QUEUE`             | `twake.space.sync.requested.ldap-rest` | Queue of the space sync requests                   |

See [spaces](plugins/integrations/spaces.md).

### Utility Plugins

#### `core/static`

| CLI             | Env              | Default  | Description            |
| --------------- | ---------------- | -------- | ---------------------- |
| `--static-path` | `DM_STATIC_PATH` | `static` | Static files directory |
| `--static-name` | `DM_STATIC_NAME` | `static` | URL path prefix        |

#### `core/weblogs`

Web access logging plugin. No configuration options - just add the plugin to enable access logs.

#### `core/storage`

Keyed storage with a deadline, for the plugins that need to keep something —
see [Storage](plugins/utilities/storage.md).

| CLI                           | Env                            | Default              | Description                                      |
| ----------------------------- | ------------------------------ | -------------------- | ------------------------------------------------ |
| `--storage-backend`           | `DM_STORAGE_BACKEND`           |                      | `ldap`, `file`, `postgres` or `valkey`; required |
| `--storage-sweep-interval`    | `DM_STORAGE_SWEEP_INTERVAL`    | `600`                | Seconds between two expiry passes                |
| `--storage-ldap-base`         | `DM_STORAGE_LDAP_BASE`         |                      | Branch the `ldap` backend writes to              |
| `--storage-ldap-object-class` | `DM_STORAGE_LDAP_OBJECT_CLASS` | `applicationProcess` | Object class of the entries it writes            |
| `--storage-file-directory`    | `DM_STORAGE_FILE_DIRECTORY`    |                      | Directory the `file` backend writes to           |
| `--storage-postgres-url`      | `DM_STORAGE_POSTGRES_URL`      |                      | Connection string of the `postgres` backend      |
| `--storage-postgres-table`    | `DM_STORAGE_POSTGRES_TABLE`    | `ldap_rest_storage`  | Table it writes to                               |
| `--storage-valkey-url`        | `DM_STORAGE_VALKEY_URL`        |                      | URL of the `valkey` backend                      |
| `--storage-valkey-prefix`     | `DM_STORAGE_VALKEY_PREFIX`     | `ldap-rest:`         | Prefix of the keys it writes                     |

#### `core/configApi`

Exposes API configuration at `/api/v1/config` for client applications. Returns available features, schemas, and endpoints. No configuration options.

## Configuration File

Use a `.env` file or shell script:

```bash
# ~/.ldap-rest-config
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="password"
export DM_LDAP_BASE="dc=example,dc=com"
export DM_PLUGINS="core/auth/token,core/ldap/flatGeneric"
export DM_AUTH_TOKENS="secret-token"
export DM_LOG_LEVEL="notice"
```

```bash
# Load and start
source ~/.ldap-rest-config
ldap-rest
```

## LDAP Failover

For high availability, specify multiple servers:

```bash
DM_LDAP_URL="ldap://ldap1.example.com,ldap://ldap2.example.com,ldap://ldap3.example.com"
```

The system will:

1. Try each URL in order
2. Use the first successful connection
3. Automatically failover if connection fails
4. Log failover events

## Log Levels _(`--log-level`)_

| Level    | Description                                  |
| -------- | -------------------------------------------- |
| `error`  | Errors only                                  |
| `warn`   | Warnings and errors                          |
| `notice` | Web access logs (recommended for production) |
| `info`   | General information                          |
| `debug`  | Everything, including debug output           |

The `notice` level is ideal for production as it shows web access logs without flooding with general info messages.
