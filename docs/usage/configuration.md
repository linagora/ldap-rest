# Configuration

All LDAP-Rest configuration options.

## Environment Variables

All CLI options can be set via environment variables with the `DM_` prefix.

### Array Options

Some options accept multiple values (e.g., `--plugin`, `--auth-token`, `--ldap-url`). These can be configured in several ways:

**Via CLI - repeat the option:**

```bash
ldap-rest --plugin core/auth/token --plugin core/ldap/flatGeneric --plugin core/ldap/groups
```

**Via CLI - use plural form with comma-separated values:**

```bash
ldap-rest --plugins core/auth/token,core/ldap/flatGeneric,core/ldap/groups
```

**Via environment variable - use `;` or `,` as separator:**

```bash
# Semicolon separator (preferred for values containing commas)
export DM_PLUGINS="core/auth/token;core/ldap/flatGeneric;core/ldap/groups"

# Comma separator
export DM_PLUGINS="core/auth/token,core/ldap/flatGeneric,core/ldap/groups"
```

> **Note:** If the value contains a semicolon, it will be used as the separator. Otherwise, commas are used. Whitespace around separators is ignored.

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

## LDAP Connection

| CLI                          | Plural           | Env                      | Default                            | Description                |
| ---------------------------- | ---------------- | ------------------------ | ---------------------------------- | -------------------------- |
| `--ldap-url`                 | `--ldap-urls`    | `DM_LDAP_URL`            | `ldap://localhost`                 | LDAP server URL(s)         |
| `--ldap-dn`                  |                  | `DM_LDAP_DN`             | `cn=admin,dc=example,dc=com`       | Bind DN                    |
| `--ldap-pwd`                 |                  | `DM_LDAP_PWD`            | `admin`                            | Password                   |
| `--ldap-base`                |                  | `DM_LDAP_BASE`           |                                    | Base DN for searches       |
| `--ldap-user-main-attribute` |                  | `DM_LDAP_USER_ATTRIBUTE` | `uid`                              | User identifier attribute  |
| `--ldap-cache-max`           |                  | `DM_LDAP_CACHE_MAX`      | `1000`                             | Max cache entries          |
| `--ldap-cache-ttl`           |                  | `DM_LDAP_CACHE_TTL`      | `300`                              | Cache TTL (seconds)        |
| `--ldap-pool-size`           |                  | `DM_LDAP_POOL_SIZE`      | `5`                                | Connection pool size       |
| `--ldap-connection-ttl`      |                  | `DM_LDAP_CONNECTION_TTL` | `60`                               | Connection TTL (seconds)   |
| `--user-class`               | `--user-classes` | `DM_USER_CLASSES`        | `top,twakeAccount,twakeWhitePages` | Default user objectClasses |

## Special Attributes

| CLI                        | Env                         | Default                 | Description            |
| -------------------------- | --------------------------- | ----------------------- | ---------------------- |
| `--mail-attribute`         | `DM_MAIL_ATTRIBUTE`         | `mail`                  | Email attribute        |
| `--quota-attribute`        | `DM_QUOTA_ATTRIBUTE`        | `mailQuota`             | Quota attribute        |
| `--delegation-attribute`   | `DM_DELEGATION_ATTRIBUTE`   | `twakeDelegatedUsers`   | Delegation attribute   |
| `--alias-attribute`        | `DM_ALIAS_ATTRIBUTE`        | `mailAlternateAddress`  | Email alias attribute  |
| `--forward-attribute`      | `DM_FORWARD_ATTRIBUTE`      | `mailForwardingAddress` | Forward attribute      |
| `--display-name-attribute` | `DM_DISPLAY_NAME_ATTRIBUTE` | `displayName`           | Display name attribute |

## Plugin Options

### Organizations (`core/ldap/organizations`)

| CLI                                  | Plural                        | Env                                   | Default                                  | Description                |
| ------------------------------------ | ----------------------------- | ------------------------------------- | ---------------------------------------- | -------------------------- |
| `--ldap-top-organization`            |                               | `DM_LDAP_TOP_ORGANIZATION`            |                                          | Top organization DN        |
| `--ldap-organization-class`          | `--ldap-organization-classes` | `DM_LDAP_ORGANIZATION_CLASSES`        | `top,organizationalUnit,twakeDepartment` | Organization objectClasses |
| `--ldap-organization-link-attribute` |                               | `DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE` | `twakeDepartmentLink`                    | Link attribute             |
| `--ldap-organization-path-attribute` |                               | `DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE` | `twakeDepartmentPath`                    | Path attribute             |
| `--ldap-organization-path-separator` |                               | `DM_LDAP_ORGANIZATION_PATH_SEPARATOR` | `/`                                      | Path separator             |
| `--ldap-organization-max-subnodes`   |                               | `DM_LDAP_ORGANIZATION_MAX_SUBNODES`   | `50`                                     | Max subnodes returned      |

### Groups (`core/ldap/groups`)

| CLI                                | Plural            | Env                             | Default                            | Description                 |
| ---------------------------------- | ----------------- | ------------------------------- | ---------------------------------- | --------------------------- |
| `--ldap-group-base`                |                   | `DM_LDAP_GROUP_BASE`            |                                    | Groups base DN              |
| `--ldap-groups-main-attribute`     |                   | `DM_LDAP_GROUPS_MAIN_ATTRIBUTE` | `cn`                               | Group identifier attribute  |
| `--group-class`                    | `--group-classes` | `DM_GROUP_CLASSES`              | `top,groupOfNames`                 | Group objectClasses         |
| `--group-allow-unexistent-members` |                   | `DM_ALLOW_UNEXISTENT_MEMBERS`   | `false`                            | Allow non-existent members  |
| `--group-default-attributes`       |                   | `DM_GROUP_DEFAULT_ATTRIBUTES`   | `{}`                               | Default attributes (JSON)   |
| `--group-dummy-user`               |                   | `DM_GROUP_DUMMY_USER`           | `cn=fakeuser`                      | Dummy user for empty groups |
| `--group-schema`                   |                   | `DM_GROUP_SCHEMA`               | `static/schemas/twake/groups.json` | Group JSON schema path      |

### External Users in Groups (`core/ldap/externalUsersInGroups`)

| CLI                         | Plural                      | Env                          | Default                         | Description                 |
| --------------------------- | --------------------------- | ---------------------------- | ------------------------------- | --------------------------- |
| `--external-members-branch` |                             | `DM_EXTERNAL_MEMBERS_BRANCH` | `ou=contacts,dc=example,dc=com` | External contacts branch    |
| `--external-branch-class`   | `--external-branch-classes` | `DM_EXTERNAL_BRANCH_CLASSES` | `top,inetOrgPerson`             | External user objectClasses |

### Flat Generic (`core/ldap/flatGeneric`)

| CLI                  | Plural                | Env                   | Default | Description           |
| -------------------- | --------------------- | --------------------- | ------- | --------------------- |
| `--ldap-flat-schema` | `--ldap-flat-schemas` | `DM_LDAP_FLAT_SCHEMA` | `[]`    | Entity schema path(s) |

### Bulk Import (`core/ldap/bulkImport`)

| CLI                           | Env                            | Default    | Description              |
| ----------------------------- | ------------------------------ | ---------- | ------------------------ |
| `--bulk-import-schemas`       | `DM_BULK_IMPORT_SCHEMAS`       |            | Bulk import schemas path |
| `--bulk-import-max-file-size` | `DM_BULK_IMPORT_MAX_FILE_SIZE` | `10485760` | Max file size (bytes)    |
| `--bulk-import-batch-size`    | `DM_BULK_IMPORT_BATCH_SIZE`    | `100`      | Batch size               |

### Trash (`core/ldap/trash`)

| CLI                     | Env                      | Default | Description                 |
| ----------------------- | ------------------------ | ------- | --------------------------- |
| `--trash-base`          | `DM_TRASH_BASE`          |         | Trash container DN          |
| `--trash-watched-bases` | `DM_TRASH_WATCHED_BASES` |         | DNs to watch for deletions  |
| `--trash-add-metadata`  | `DM_TRASH_ADD_METADATA`  | `true`  | Add deletion metadata       |
| `--trash-auto-create`   | `DM_TRASH_AUTO_CREATE`   | `true`  | Auto-create trash container |

### Static Files (`core/static`)

| CLI             | Env              | Default  | Description            |
| --------------- | ---------------- | -------- | ---------------------- |
| `--static-path` | `DM_STATIC_PATH` | `static` | Static files directory |
| `--static-name` | `DM_STATIC_NAME` | `static` | URL path prefix        |

### Token Authentication (`core/auth/token`)

| CLI            | Plural          | Env              | Default | Description           |
| -------------- | --------------- | ---------------- | ------- | --------------------- |
| `--auth-token` | `--auth-tokens` | `DM_AUTH_TOKENS` | `[]`    | Authentication tokens |

### TOTP Authentication (`core/auth/totp`)

| CLI                  | Plural         | Env                   | Default | Description                      |
| -------------------- | -------------- | --------------------- | ------- | -------------------------------- |
| `--auth-totp`        | `--auth-totps` | `DM_AUTH_TOTP`        | `[]`    | TOTP config (secret:name:digits) |
| `--auth-totp-window` |                | `DM_AUTH_TOTP_WINDOW` | `1`     | Validation window                |
| `--auth-totp-step`   |                | `DM_AUTH_TOTP_STEP`   | `30`    | Time step (seconds)              |

### HMAC Authentication (`core/auth/hmac`)

| CLI                  | Plural         | Env                   | Default  | Description                          |
| -------------------- | -------------- | --------------------- | -------- | ------------------------------------ |
| `--auth-hmac`        | `--auth-hmacs` | `DM_AUTH_HMAC`        | `[]`     | HMAC config (service-id:secret:name) |
| `--auth-hmac-window` |                | `DM_AUTH_HMAC_WINDOW` | `120000` | Time window (ms)                     |

### LemonLDAP::NG (`core/auth/llng`)

| CLI          | Env           | Default                              | Description               |
| ------------ | ------------- | ------------------------------------ | ------------------------- |
| `--llng-ini` | `DM_LLNG_INI` | `/etc/lemonldap-ng/lemonldap-ng.ini` | LemonLDAP::NG config path |

### OpenID Connect (`core/auth/openidconnect`)

| CLI                    | Env                     | Default | Description              |
| ---------------------- | ----------------------- | ------- | ------------------------ |
| `--oidc-server`        | `DM_OIDC_SERVER`        |         | OIDC server URL          |
| `--oidc-client-id`     | `DM_OIDC_CLIENT_ID`     |         | OIDC Client ID           |
| `--oidc-client-secret` | `DM_OIDC_CLIENT_SECRET` |         | OIDC Client Secret       |
| `--base-url`           | `DM_BASE_URL`           |         | Public URL for callbacks |

### Authorization Per Branch (`core/auth/authzPerBranch`)

| CLI                            | Env                             | Default                                          | Description                 |
| ------------------------------ | ------------------------------- | ------------------------------------------------ | --------------------------- |
| `--authz-per-branch-config`    | `DM_AUTHZ_PER_BRANCH_CONFIG`    | `{default:{read:true,write:false,delete:false}}` | Authorization config (JSON) |
| `--authz-per-branch-cache-ttl` | `DM_AUTHZ_PER_BRANCH_CACHE_TTL` | `60`                                             | Cache TTL (seconds)         |

### Authorization LinID 1.x (`core/auth/authzLinid1`)

| CLI                             | Env                              | Default               | Description           |
| ------------------------------- | -------------------------------- | --------------------- | --------------------- |
| `--authz-local-admin-attribute` | `DM_AUTHZ_LOCAL_ADMIN_ATTRIBUTE` | `twakeLocalAdminLink` | Local admin attribute |

### Rate Limiting (`core/auth/rateLimit`)

| CLI                      | Env                       | Default  | Description              |
| ------------------------ | ------------------------- | -------- | ------------------------ |
| `--rate-limit-window-ms` | `DM_RATE_LIMIT_WINDOW_MS` | `900000` | Time window (ms, 15 min) |
| `--rate-limit-max`       | `DM_RATE_LIMIT_MAX`       | `100`    | Max requests per window  |

### CrowdSec (`core/auth/crowdsec`)

| CLI                    | Env                     | Default                              | Description         |
| ---------------------- | ----------------------- | ------------------------------------ | ------------------- |
| `--crowdsec-url`       | `DM_CROWDSEC_URL`       | `http://localhost:8080/v1/decisions` | CrowdSec API URL    |
| `--crowdsec-api-key`   | `DM_CROWDSEC_API_KEY`   |                                      | CrowdSec API key    |
| `--crowdsec-cache-ttl` | `DM_CROWDSEC_CACHE_TTL` | `60`                                 | Cache TTL (seconds) |

### Trusted Proxy (`core/auth/trustedProxy`)

| CLI                           | Plural              | Env                            | Default     | Description            |
| ----------------------------- | ------------------- | ------------------------------ | ----------- | ---------------------- |
| `--trusted-proxy`             | `--trusted-proxies` | `DM_TRUSTED_PROXIES`           | `[]`        | Trusted proxy IPs/CIDR |
| `--trusted-proxy-auth-header` |                     | `DM_TRUSTED_PROXY_AUTH_HEADER` | `Auth-User` | User header name       |

### Apache James (`integrations/twake/james`)

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

### Calendar Resources (`integrations/twake/calendarResources`)

| CLI                               | Env                                | Default                 | Description                   |
| --------------------------------- | ---------------------------------- | ----------------------- | ----------------------------- |
| `--calendar-webadmin-url`         | `DM_CALENDAR_WEBADMIN_URL`         | `http://localhost:8080` | Calendar API URL              |
| `--calendar-webadmin-token`       | `DM_CALENDAR_WEBADMIN_TOKEN`       |                         | Calendar authentication token |
| `--calendar-concurrency`          | `DM_CALENDAR_CONCURRENCY`          | `10`                    | API concurrency               |
| `--calendar-resource-base`        | `DM_CALENDAR_RESOURCE_BASE`        |                         | Resource base DN              |
| `--calendar-resource-objectclass` | `DM_CALENDAR_RESOURCE_OBJECTCLASS` |                         | Resource objectClass          |
| `--calendar-resource-creator`     | `DM_CALENDAR_RESOURCE_CREATOR`     |                         | Resource creator              |
| `--calendar-resource-domain`      | `DM_CALENDAR_RESOURCE_DOMAIN`      |                         | Resource domain               |

### Applicative Accounts (`integrations/twake/applicativeAccounts`)

| CLI                            | Plural                          | Env                              | Default       | Description                       |
| ------------------------------ | ------------------------------- | -------------------------------- | ------------- | --------------------------------- |
| `--applicative-account-base`   |                                 | `DM_APPLICATIVE_ACCOUNT_BASE`    |               | Applicative accounts base DN      |
| `--max-app-accounts`           |                                 | `DM_MAX_APP_ACCOUNTS`            | `5`           | Max accounts per user             |
| `--ldap-operational-attribute` | `--ldap-operational-attributes` | `DM_LDAP_OPERATIONAL_ATTRIBUTES` | _(see below)_ | Operational attributes to exclude |

Default operational attributes: `dn`, `controls`, `structuralObjectClass`, `entryUUID`, `entryDN`, `subschemaSubentry`, `modifyTimestamp`, `modifiersName`, `createTimestamp`, `creatorsName`, `userPassword`

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

## Log Levels

| Level    | Description                                  |
| -------- | -------------------------------------------- |
| `error`  | Errors only                                  |
| `warn`   | Warnings and errors                          |
| `notice` | Web access logs (recommended for production) |
| `info`   | General information                          |
| `debug`  | Everything, including debug output           |

The `notice` level is ideal for production as it shows web access logs without flooding with general info messages.
