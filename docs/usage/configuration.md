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

| CLI Option      | Plural Form      | Environment Variable |
| --------------- | ---------------- | -------------------- |
| `--plugin`      | `--plugins`      | `DM_PLUGINS`         |
| `--auth-token`  | `--auth-tokens`  | `DM_AUTH_TOKENS`     |
| `--auth-totp`   | `--auth-totps`   | `DM_AUTH_TOTP`       |
| `--auth-hmac`   | `--auth-hmacs`   | `DM_AUTH_HMAC`       |
| `--ldap-url`    | `--ldap-urls`    | `DM_LDAP_URL`        |
| `--mail-domain` | `--mail-domains` | `DM_MAIL_DOMAIN`     |

### LDAP Connection

| Variable       | CLI           | Description                                       |
| -------------- | ------------- | ------------------------------------------------- |
| `DM_LDAP_URL`  | `--ldap-url`  | LDAP server URL(s) (comma-separated for failover) |
| `DM_LDAP_DN`   | `--ldap-dn`   | Bind DN                                           |
| `DM_LDAP_PWD`  | `--ldap-pwd`  | Password                                          |
| `DM_LDAP_BASE` | `--ldap-base` | Base DN for searches                              |

### Server

| Variable       | CLI           | Description                                 |
| -------------- | ------------- | ------------------------------------------- |
| `DM_PORT`      | `--port`      | Listen port (default: 8081)                 |
| `DM_LOG_LEVEL` | `--log-level` | Log level: error, warn, notice, info, debug |

### Plugins

| Variable    | CLI        | Description                       |
| ----------- | ---------- | --------------------------------- |
| `DM_PLUGIN` | `--plugin` | Plugins to load (comma-separated) |

### Authentication

| Variable                | CLI                    | Description                                 |
| ----------------------- | ---------------------- | ------------------------------------------- |
| `DM_AUTH_TOKENS`        | `--auth-token`         | Authentication tokens                       |
| `DM_AUTH_TOTP`          | `--auth-totp`          | TOTP configuration (secret:name:digits)     |
| `DM_AUTH_HMAC`          | `--auth-hmac`          | HMAC configuration (service-id:secret:name) |
| `DM_LLNG_INI`           | `--llng-ini`           | Path to lemonldap-ng.ini                    |
| `DM_OIDC_SERVER`        | `--oidc-server`        | OpenID Connect server URL                   |
| `DM_OIDC_CLIENT_ID`     | `--oidc-client-id`     | OIDC Client ID                              |
| `DM_OIDC_CLIENT_SECRET` | `--oidc-client-secret` | OIDC Client secret                          |
| `DM_BASE_URL`           | `--base-url`           | Public URL for OIDC callbacks               |

### Security

| Variable               | CLI                   | Description               |
| ---------------------- | --------------------- | ------------------------- |
| `DM_TRUSTED_PROXIES`   | `--trusted-proxy`     | Trusted proxy IPs/CIDR    |
| `DM_RATE_LIMIT_WINDOW` | `--rate-limit-window` | Rate limiting window (ms) |
| `DM_RATE_LIMIT_MAX`    | `--rate-limit-max`    | Max requests per window   |
| `DM_CROWDSEC_URL`      | `--crowdsec-url`      | CrowdSec API URL          |
| `DM_CROWDSEC_API_KEY`  | `--crowdsec-api-key`  | CrowdSec API key          |

### Schemas

| Variable                 | CLI                     | Description         |
| ------------------------ | ----------------------- | ------------------- |
| `DM_LDAP_FLAT_SCHEMA`    | `--ldap-flat-schema`    | Entity schema path  |
| `DM_BULK_IMPORT_SCHEMAS` | `--bulk-import-schemas` | Bulk import schemas |

### Static Files

| Variable         | CLI             | Description            |
| ---------------- | --------------- | ---------------------- |
| `DM_STATIC_PATH` | `--static-path` | Static files directory |

### Apache James

| Variable                  | CLI                      | Description                |
| ------------------------- | ------------------------ | -------------------------- |
| `DM_JAMES_WEBADMIN_URL`   | `--james-webadmin-url`   | James WebAdmin API URL     |
| `DM_JAMES_WEBADMIN_TOKEN` | `--james-webadmin-token` | James authentication token |

## Configuration File

Use a `.env` file or shell script:

```bash
# ~/.ldap-rest-config
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="password"
export DM_LDAP_BASE="dc=example,dc=com"
export DM_PLUGIN="core/auth/token,core/ldap/flatGeneric"
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
