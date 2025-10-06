# Mini-DM Documentation

Complete documentation for mini-dm plugins and features.

## Table of Contents

### Core Plugins

#### LDAP Management

- **[ldapFlatGeneric](ldapFlatGeneric.md)** - Schema-driven LDAP entity management (users, positions, etc.)
- **[ldapFlat](ldapFlat.md)** - Legacy flat LDAP plugin (deprecated, use ldapFlatGeneric)
- **[ldapGroups](ldapGroups.md)** - LDAP group management with member validation
- **[ldapOrganizations](ldapOrganizations.md)** - Hierarchical organization tree management
- **[ldapExternalUsersInGroups](ldapExternalUsersInGroups.md)** - Auto-create external contacts in groups
- **[onChange](onChange.md)** - Detect and react to LDAP attribute changes

#### Authentication & Authorization

- **[authentication](authentication.md)** - Complete authentication guide (Token, LLNG, OpenID Connect)
- **[authzPerBranch](authzPerBranch.md)** - Branch-level authorization and access control

#### Utilities

- **[static](static.md)** - Serve static files and JSON schemas with config replacement
- **[weblogs](weblogs.md)** - HTTP request logging and monitoring

### Integration Plugins

#### Twake

- **[twakeJames](twakeJames.md)** - Apache James mail server synchronization

## Quick Start

### Basic LDAP Server

Minimal setup with user management:

```bash
mini-dm \
  --plugin core/ldap/flatGeneric \
  --ldap-url ldap://localhost:389 \
  --ldap-dn "cn=admin,dc=example,dc=com" \
  --ldap-pwd "password" \
  --ldap-base "dc=example,dc=com" \
  --ldap-flat-schema ./schemas/standard/users.json
```

### With Authentication

Add token authentication:

```bash
mini-dm \
  --plugin core/auth/token \
  --plugin core/ldap/flatGeneric \
  --auth-token "secret-token" \
  --ldap-flat-schema ./schemas/standard/users.json \
  ...
```

### Complete Setup

Full-featured LDAP management with web UI:

```bash
mini-dm \
  --plugin core/auth/token \
  --plugin core/ldap/flatGeneric \
  --plugin core/ldap/groups \
  --plugin core/ldap/organization \
  --plugin core/ldap/externalUsersInGroups \
  --plugin core/static \
  --plugin core/weblogs \
  --ldap-flat-schema ./schemas/standard/users.json \
  --auth-token "admin-token" \
  --static-path ./static \
  ...
```

## Plugin Categories

### LDAP Entities

Plugins for managing different LDAP entity types:

| Plugin            | Entity Type              | Features                            |
| ----------------- | ------------------------ | ----------------------------------- |
| ldapFlatGeneric   | Users, Positions, Custom | Schema-driven, Validation, Pointers |
| ldapGroups        | Groups                   | Member validation, Nested groups    |
| ldapOrganizations | Organizational Units     | Tree navigation, Search             |

### Authentication

Secure API access:

| Plugin         | Type          | Use Case                     |
| -------------- | ------------- | ---------------------------- |
| token          | Bearer tokens | Development, APIs, Scripts   |
| llng           | LemonLDAP::NG | Enterprise SSO               |
| openidconnect  | OAuth2/OIDC   | Cloud identity, Social login |
| authzPerBranch | Authorization | Branch-level access control  |

### Integration

Connect to external systems:

| Plugin                | Integrates With | Purpose              |
| --------------------- | --------------- | -------------------- |
| onChange              | Any             | Detect LDAP changes  |
| twake/james           | Apache James    | Mail server sync     |
| externalUsersInGroups | Groups          | Auto-create contacts |

### Utilities

Support plugins:

| Plugin  | Purpose               |
| ------- | --------------------- |
| static  | Serve web UI, schemas |
| weblogs | Request logging       |

## Plugin Dependencies

Some plugins require others:

```
twake/james
  └─ requires: core/ldap/onChange

core/ldap/externalUsersInGroups
  └─ requires: core/ldap/groups

core/auth/authzPerBranch
  └─ requires: Any authentication plugin (token, llng, openidconnect)
```

## Configuration

### Environment Variables

All CLI options can be set via environment variables:

```bash
# LDAP connection
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="password"
export DM_LDAP_BASE="dc=example,dc=com"

# Plugins
export DM_PLUGIN="core/auth/token,core/ldap/flatGeneric"
export DM_AUTH_TOKENS="token1,token2"
export DM_LDAP_FLAT_SCHEMA="./schemas/users.json"

# Start server
mini-dm
```

### Configuration Files

Use `.env` files or shell scripts:

```bash
# Load configuration
source ~/.mini-dm-config

# Start server
mini-dm
```

## Schemas

### Standard Schemas

Located in `./static/schemas/standard/`:

- `users.json` - Standard inetOrgPerson users
- `groups.json` - Standard groupOfNames groups
- `organizations.json` - Organizational units

### Twake Schemas

Located in `./static/schemas/twake/`:

- `users.json` - Twake users with custom attributes
- `groups.json` - Twake static groups
- `positions.json` - Twake positions/roles
- `organizations.json` - Twake organizations
- `nomenclature/*.json` - Reference data (status, delivery mode, etc.)

### Active Directory Schemas

Located in `./static/schemas/ad/`:

- `users.json` - AD user accounts
- `groups.json` - AD security groups
- `organizations.json` - AD organizational units

## API Endpoints

### Entity Management

Generated by `ldapFlatGeneric`:

```
GET    /api/v1/ldap/{pluralName}           # List entries
GET    /api/v1/ldap/{pluralName}/{id}      # Get entry
POST   /api/v1/ldap/{pluralName}           # Create entry
PUT    /api/v1/ldap/{pluralName}/{id}      # Modify entry
DELETE /api/v1/ldap/{pluralName}/{id}      # Delete entry
```

### Groups

Provided by `ldapGroups`:

```
GET    /api/v1/ldap/groups                 # List groups
GET    /api/v1/ldap/groups/{cn}            # Get group
POST   /api/v1/ldap/groups                 # Create group
PUT    /api/v1/ldap/groups/{cn}            # Modify group
DELETE /api/v1/ldap/groups/{cn}            # Delete group
```

### Organizations

Provided by `ldapOrganizations`:

```
GET    /api/v1/ldap/organizations/top                        # Get top organization(s)
GET    /api/v1/ldap/organizations/{dn}/subnodes             # List sub-organizations
GET    /api/v1/ldap/organizations/{dn}/subnodes/search      # Search in organization
POST   /api/v1/ldap/organizations                           # Create organization
PUT    /api/v1/ldap/organizations/{dn}                      # Modify organization
DELETE /api/v1/ldap/organizations/{dn}                      # Delete organization
```

### Static Files

Provided by `static`:

```
GET    /static/*                           # Serve static files
GET    /static/schemas/*.json              # Serve schemas (with config replacement)
```

## Command-Line Tools

### cleanup-external-users

Remove orphaned external contacts:

```bash
# Preview deletions
cleanup-external-users --dry-run

# Delete with verbose output
cleanup-external-users --verbose

# Delete silently (for cron)
cleanup-external-users --quiet

# Show help
cleanup-external-users --help
```

See also: [ldapExternalUsersInGroups.md](ldapExternalUsersInGroups.md)

## Hooks System

Plugins can register hooks to intercept and modify operations:

### Common Hooks

- `ldap{Entity}add` - Before adding entry
- `ldap{Entity}adddone` - After adding entry
- `ldap{Entity}modify` - Before modifying entry
- `ldap{Entity}modifydone` - After modifying entry
- `ldap{Entity}delete` - Before deleting entry
- `ldap{Entity}deletedone` - After deleting entry
- `onLdapChange` - Any LDAP change
- `onLdapMailChange` - Mail attribute changed
- `onLdapQuotaChange` - Quota attribute changed
- `ldapsearchrequest` - Before LDAP search
- `getOrganisationTop` - Before returning organization tree top

See individual plugin documentation for specific hooks.

## Development

### Creating Custom Plugins

1. Extend `DmPlugin` base class
2. Define plugin name and dependencies
3. Implement `api()` method for REST endpoints
4. Register hooks for LDAP operations
5. Load plugin via `--plugin path/to/plugin`

Example:

```typescript
import DmPlugin from '../abstract/plugin';
import type { Express } from 'express';
import type { Hooks } from '../hooks';

export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';

  dependencies = {
    onChange: 'core/ldap/onChange',
  };

  api(app: Express): void {
    app.get('/api/v1/my-endpoint', async (req, res) => {
      res.json({ message: 'Hello from MyPlugin' });
    });
  }

  hooks: Hooks = {
    onLdapChange: async (dn, changes) => {
      this.logger.info(`LDAP change detected: ${dn}`);
    },
  };
}
```

### Plugin Priorities

Some plugins must load before others. See `src/plugins/priority.json`:

```json
[
  "core/auth/token",
  "core/auth/llng",
  "core/auth/openidconnect",
  "core/auth/authzPerBranch"
]
```

Authentication plugins load first to secure API endpoints.

## Troubleshooting

### Common Issues

1. **Plugin not found**: Check plugin name matches exactly
2. **LDAP connection failed**: Verify URL, DN, and password
3. **Schema validation failed**: Check schema syntax and required fields
4. **404 on API**: Ensure plugin providing endpoint is loaded
5. **Permission denied**: Check authentication and authorization config

### Debug Mode

Enable detailed logging:

```bash
mini-dm --log-level debug ...
```

### Testing

Run test suite:

```bash
# All tests
source ~/.test-env && npm run test:dev

# Single test file
source ~/.test-env && npm run test:one test/path/to/file.test.ts
```

See `DEVELOPMENT.md` for more testing information.

## Support

- **Issues**: https://github.com/linagora/mini-dm/issues
- **Documentation**: https://github.com/linagora/mini-dm/tree/master/docs
- **Examples**: See `DEVELOPMENT.md` and plugin documentation

## License

AGPL-3.0 - See LICENSE file for details.
