[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/linagora/ldap-rest)

# LDAP-Rest

Lite LinID directory manager is a lightweight directory manager that provides LDAP integration through a plugin-based architecture.
This system enables directory management operations with configurable authentication, extensible functionality through events/hooks,
and extensible REST API.

Core plugins also provide plugins that ensure LDAP data consistency.

## Key Features

- 🔒 **Robust Error Handling** - Server stays online even when plugins encounter errors
- 🔌 **Plugin Architecture** - Extensible through a powerful plugin system
- 🔐 **Flexible Authentication** - Support for multiple authentication methods
- 📊 **REST API** - Complete LDAP operations through REST endpoints
- 🎯 **Event Hooks** - Intercept and customize LDAP operations
- 🌐 **Browser Libraries** - Ready-to-use JavaScript components

## How it works

All configuration is done via command-line arguments and/or environment variables.
Example:

```shell
npx ldap-rest --ldap-base 'dc=example,dc=com' \
    --ldap-dn 'cn=admin,dc=example,dc=com' --ldap-pwd admin \
    --ldap-url ldap://localhost \
    --log-level notice \
    --plugin core/ldap/groups --ldap-group-base 'ou=groups,dc=example,dc=com' \
    --plugin core/ldap/externalUsersInGroups
```

### LDAP Failover

Multiple LDAP servers are supported for high availability:

```shell
--ldap-url ldap://ldap1.example.com,ldap://ldap2.example.com,ldap://ldap3.example.com
```

The system automatically tries each URL in order and fails over if a connection fails.

### Log Levels

LDAP-Rest uses syslog-style log levels:

- `error` - Only errors
- `warn` - Warnings and errors
- `notice` - Web access logs (recommended for production)
- `info` - General info + web logs
- `debug` - All debug output

Use `--log-level notice` for production to see web access logs without general info messages.

## Command-line options and environment variables

[ToDo]

See also [Typescript declarations](./src/config/args.ts).

## Documentation

### For Application Developers

- **[Developer Guide](./docs/DEVELOPER_GUIDE.md)** - Complete guide for building web applications using LDAP-Rest APIs and browser libraries
- **[Browser Examples](./examples/web/)** - Interactive demos of browser libraries (TOTP client, LDAP tree viewer, etc.)

### For Plugin Developers

- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute and develop plugins
- [Plugins](./src/plugins/README.md)
- [Hooks](./HOOKS.md)

### Authentication

- **[Authentication Guide](./docs/authentication.md)** - Token, TOTP, LemonLDAP::NG, OpenID Connect
- **[TOTP Client Demo](./examples/web/totp-client.html)** - Interactive TOTP generator and API client

## Copyright and license

[![Powered by LINAGORA](./docs/linagora.png)](https://linagora.com)

Copyright 2025-present [LINAGORA](https://linagora.com)

Licensed under [GNU AGPL-3.0](./LICENSE])
