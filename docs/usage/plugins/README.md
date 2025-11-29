# Plugins

LDAP-Rest is extensible through a plugin system. This section documents all available plugins.

## LDAP Plugins

LDAP entity management:

| Plugin                                   | Description                                             |
| ---------------------------------------- | ------------------------------------------------------- |
| [flat-generic](ldap/flat-generic.md)     | Generic LDAP entity management (users, positions, etc.) |
| [groups](ldap/groups.md)                 | LDAP group management with member validation            |
| [organizations](ldap/organizations.md)   | Hierarchical organization management                    |
| [bulk-import](ldap/bulk-import.md)       | Bulk import from CSV                                    |
| [trash](ldap/trash.md)                   | Trash system (soft delete)                              |
| [external-users](ldap/external-users.md) | Automatic external contact creation                     |
| [on-change](ldap/on-change.md)           | LDAP change detection                                   |

## Authentication Plugins

Secure API access:

| Plugin                 | Description                              |
| ---------------------- | ---------------------------------------- |
| [token](auth/token.md) | Bearer token authentication              |
| [totp](auth/totp.md)   | TOTP authentication (time-based codes)   |
| [hmac](auth/hmac.md)   | HMAC-SHA256 signing for backend services |
| [llng](auth/llng.md)   | LemonLDAP::NG SSO integration            |
| [oidc](auth/oidc.md)   | OpenID Connect / OAuth 2.0               |

## Authorization Plugins

Access control:

| Plugin                                       | Description                     |
| -------------------------------------------- | ------------------------------- |
| [authz-per-branch](auth/authz-per-branch.md) | Branch-level LDAP authorization |
| [authz-linid1](auth/authz-linid1.md)         | LinID 1.x integration           |

## Security Plugins

Protection and rate limiting:

| Plugin                                 | Description                       |
| -------------------------------------- | --------------------------------- |
| [trusted-proxy](auth/trusted-proxy.md) | X-Forwarded-For header validation |
| [rate-limit](auth/rate-limit.md)       | Request rate limiting             |
| [crowdsec](auth/crowdsec.md)           | IP blocking via CrowdSec          |

## Integration Plugins

Connect to external systems:

| Plugin                                                   | Description                  |
| -------------------------------------------------------- | ---------------------------- |
| [james-mail](integrations/james-mail.md)                 | Apache James synchronization |
| [james-mailboxes](integrations/james-mailboxes.md)       | Apache James team mailboxes  |
| [calendar-resources](integrations/calendar-resources.md) | Twake calendar resources     |
| [app-accounts](integrations/app-accounts.md)             | Applicative accounts API     |

## Utility Plugins

| Plugin                          | Description        |
| ------------------------------- | ------------------ |
| [static](utilities/static.md)   | Static file server |
| [weblogs](utilities/weblogs.md) | HTTP logging       |

## Plugin Dependencies

Some plugins require other plugins:

```
core/twake/james
  └─ requires: core/ldap/onChange

core/ldap/externalUsersInGroups
  └─ requires: core/ldap/groups

core/auth/authzPerBranch
  └─ requires: An authentication plugin
```

See [the complete dependencies matrix](../../plugin-development/dependencies.md).

## Load Order

Authentication plugins are loaded first to secure API endpoints. The order is defined in `src/plugins/priority.json`.
