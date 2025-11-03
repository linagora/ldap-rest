# LDAP-Rest Documentation

Complete documentation for ldap-rest plugins and features.

## Presentations

Interactive slide presentations about LDAP-Rest (using [presenterm](https://github.com/mfontanini/presenterm)):

- **[presenterm.md](./presenterm.md)** - English presentation
- **[presenterm-fr.md](./presenterm-fr.md)** - Présentation en français

To view:

```bash
presenterm docs/presenterm.md      # English
presenterm docs/presenterm-fr.md   # French
```

Topics covered:

- Architecture and plugin system
- LDAP consistency mechanisms
- Apache James integration
- REST API and JSON schemas
- Browser libraries
- Use cases and examples

## For Application Developers

If you want to build a web application that uses LDAP-Rest's APIs and browser libraries:

📖 **[Developer Guide](./DEVELOPER_GUIDE.md)** - Complete guide covering:

- REST API reference (Config, Users, Groups, Organizations)
- Browser libraries (LdapTreeViewer, LdapUserEditor)
- JSON schemas and roles
- Integration examples (React, Vue.js, Vanilla JavaScript)
- Authentication and security

## For Plugin Developers

If you want to extend LDAP-Rest with custom plugins, see below:

## Table of Contents

### Core Plugins

#### LDAP Management

- **[ldapFlatGeneric](ldapFlatGeneric.md)** - Schema-driven LDAP entity management (users, positions, etc.)
- **[ldapGroups](ldapGroups.md)** - LDAP group management with member validation
- **[ldapOrganizations](ldapOrganizations.md)** - Hierarchical organization tree management
- **[ldapBulkImport](ldapBulkImport.md)** - CSV-based bulk import for LDAP resources
- **[ldapExternalUsersInGroups](ldapExternalUsersInGroups.md)** - Auto-create external contacts in groups
- **[ldapTrash](ldapTrash.md)** - Soft delete system - moves entries to trash instead of deleting
- **[onChange](onChange.md)** - Detect and react to LDAP attribute changes

#### Authentication & Authorization

- **[authentication](authentication.md)** - Complete authentication guide (Token, LLNG, OpenID Connect)
- **[authzPerBranch](authzPerBranch.md)** - Branch-level authorization and access control
- **[authzLinid1](authzLinid1.md)** - LinID 1.x authorization integration

#### Security

- **crowdsec** - CrowdSec integration to block banned IPs (must be loaded before auth plugins)
- **rateLimit** - Rate limiting to prevent brute-force attacks (must be loaded before auth plugins)

#### Utilities

- **[static](static.md)** - Serve static files and JSON schemas with config replacement
- **[weblogs](weblogs.md)** - HTTP request logging and monitoring

### Integration Plugins

#### Twake

- **[twakeJames](twakeJames.md)** - Apache James mail server synchronization
- **[twakeCalendarResources](twakeCalendarResources.md)** - Twake Calendar resources synchronization
- **[twakeAppAccountsApi](twakeAppAccountsApi.md)** - Applicative accounts API (device/app-specific accounts)

## Quick Start

### Basic LDAP Server

Minimal setup with user management:

```bash
ldap-rest \
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
ldap-rest \
  --plugin core/auth/token \
  --plugin core/ldap/flatGeneric \
  --auth-token "secret-token" \
  --ldap-flat-schema ./schemas/standard/users.json \
  ...
```

### Complete Setup

Full-featured LDAP management with web UI:

```bash
ldap-rest \
  --plugin core/auth/token \
  --plugin core/ldap/flatGeneric \
  --plugin core/ldap/groups \
  --plugin core/ldap/organization \
  --plugin core/ldap/bulkImport \
  --plugin core/ldap/externalUsersInGroups \
  --plugin core/static \
  --plugin core/weblogs \
  --ldap-flat-schema ./schemas/standard/users.json \
  --bulk-import-schemas "users:./schemas/standard/users.json" \
  --auth-token "admin-token" \
  --static-path ./static \
  ...
```

## Plugin Categories

### LDAP Entities

Plugins for managing different LDAP entity types:

| Plugin                 | Entity Type              | Features                                      |
| ---------------------- | ------------------------ | --------------------------------------------- |
| core/ldap/flatGeneric  | Users, Positions, Custom | Schema-driven, Validation, Pointers           |
| core/ldap/groups       | Groups                   | Member validation, Nested groups              |
| core/ldap/organization | Organizational Units     | Tree navigation, Search                       |
| core/ldap/bulkImport   | Any (bulk operations)    | CSV import, Template generation, Multi-schema |
| core/ldap/trash        | Any (soft delete)        | Trash system, Recovery, Metadata              |

### Authentication

Secure API access:

| Plugin                   | Type          | Use Case                     |
| ------------------------ | ------------- | ---------------------------- |
| core/auth/token          | Bearer tokens | Development, APIs, Scripts   |
| core/auth/llng           | LemonLDAP::NG | Enterprise SSO               |
| core/auth/openidconnect  | OAuth2/OIDC   | Cloud identity, Social login |
| core/auth/authzPerBranch | Authorization | Branch-level access control  |
| core/auth/authzLinid1    | Authorization | LinID 1.x integration        |

### Security

Protection and rate limiting:

| Plugin              | Type          | Use Case                      |
| ------------------- | ------------- | ----------------------------- |
| core/auth/crowdsec  | IP blocking   | Block banned IPs via CrowdSec |
| core/auth/rateLimit | Rate limiting | Prevent brute-force attacks   |

### Integration

Connect to external systems:

| Plugin                          | Integrates With | Purpose                  |
| ------------------------------- | --------------- | ------------------------ |
| core/ldap/onChange              | Any             | Detect LDAP changes      |
| core/twake/james                | Apache James    | Mail server sync         |
| core/twake/appAccountsApi       | LDAP            | App-specific account API |
| core/ldap/externalUsersInGroups | Groups          | Auto-create contacts     |

### Utilities

Support plugins:

| Plugin       | Purpose               |
| ------------ | --------------------- |
| core/static  | Serve web UI, schemas |
| core/weblogs | Request logging       |

## Plugin Dependencies

Some plugins require others:

```
core/twake/james
  └─ requires: core/ldap/onChange

core/ldap/externalUsersInGroups
  └─ requires: core/ldap/groups

core/auth/authzPerBranch
  └─ requires: Any authentication plugin (core/auth/token, core/auth/llng, core/auth/openidconnect)
```

## Configuration

### Environment Variables

All CLI options can be set via environment variables:

```bash
# LDAP connection
export DM_LDAP_URL="ldap://localhost:389"  # or multiple URLs for failover
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="password"
export DM_LDAP_BASE="dc=example,dc=com"

# Plugins
export DM_PLUGIN="core/auth/token,core/ldap/flatGeneric"
export DM_AUTH_TOKENS="token1,token2"
export DM_LDAP_FLAT_SCHEMA="./schemas/users.json"

# Logging
export DM_LOG_LEVEL="notice"  # error, warn, notice, info, debug

# Start server
ldap-rest
```

### LDAP Failover

LDAP-Rest supports multiple LDAP servers for high availability. Provide multiple URLs separated by commas:

```bash
# Command line
--ldap-url ldap://ldap1.example.com,ldap://ldap2.example.com,ldap://ldap3.example.com

# Or via environment variable
export DM_LDAP_URL="ldap://ldap1.example.com,ldap://ldap2.example.com,ldap://ldap3.example.com"
```

The system will:
1. Try to connect to each URL in order
2. Use the first successful connection
3. Automatically failover to the next URL if the current connection fails
4. Log failover events for monitoring

### Log Levels

LDAP-Rest uses syslog-style log levels:

```bash
--log-level error   # Only errors
--log-level warn    # Warnings and errors
--log-level notice  # Web access logs (recommended for production)
--log-level info    # General info + web logs + warnings + errors
--log-level debug   # All messages including debug output
```

The **notice** level is ideal for production as it shows web access logs without flooding with general info messages.

### Configuration Files

Use `.env` files or shell scripts:

```bash
# Load configuration
source ~/.ldap-rest-config

# Start server
ldap-rest
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
POST   /api/v1/ldap/groups/{cn}/rename     # Rename group (change cn)
POST   /api/v1/ldap/groups/{cn}/move       # Move group to different organization
DELETE /api/v1/ldap/groups/{cn}            # Delete group
```

### Organizations

Provided by `ldapOrganizations`:

```
GET    /api/v1/ldap/organizations/top                        # Get top organization(s)
GET    /api/v1/ldap/organizations/{dn}/subnodes             # List sub-organizations and linked entities
GET    /api/v1/ldap/organizations/{dn}/subnodes/search      # Search in organization
POST   /api/v1/ldap/organizations                           # Create organization
PUT    /api/v1/ldap/organizations/{dn}                      # Modify organization
POST   /api/v1/ldap/organizations/{dn}/move                 # Move organization to different parent
DELETE /api/v1/ldap/organizations/{dn}                      # Delete organization
```

### Bulk Import

Provided by `ldapBulkImport`:

```
GET    /api/v1/ldap/bulk-import/{resource}/template.csv    # Generate CSV template from schema
POST   /api/v1/ldap/bulk-import/{resource}                 # Import entries from CSV file
```

**Parameters for POST**:

- `file` (multipart): CSV file to import
- `dryRun` (optional): Validate without creating (true/false)
- `updateExisting` (optional): Update existing entries (true/false)
- `continueOnError` (optional): Continue on errors (true/false, default: true)

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
ldap-rest --log-level debug ...
```

Available log levels (following syslog convention):
- `error` - Only errors
- `warn` - Warnings and errors
- `notice` - Web access logs, warnings and errors (recommended for production)
- `info` - General info messages, web logs, warnings and errors
- `debug` - All messages including debug output

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

- **Issues**: https://github.com/linagora/ldap-rest/issues
- **Documentation**: https://github.com/linagora/ldap-rest/tree/master/docs
- **Examples**: See `DEVELOPMENT.md` and plugin documentation

## License

[![Powered by LINAGORA](./linagora.png)](https://linagora.com)

License: [AGPL-3.0](../LICENSE), copyright 2025-present LINAGORA.
