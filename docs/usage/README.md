# Usage - Getting Started

Getting started and usage guide for LDAP-Rest.

## Installation

```bash
npm install ldap-rest
```

## Quick Start

### Minimal Configuration

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

```bash
ldap-rest \
  --plugin core/auth/token \
  --plugin core/ldap/flatGeneric \
  --auth-token "secret-token" \
  --ldap-flat-schema ./schemas/standard/users.json \
  ...
```

### Complete Configuration

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

## LDAP Connection

### Single URL

```bash
--ldap-url ldap://localhost:389
```

### Failover (High Availability)

```bash
--ldap-url ldap://ldap1.example.com,ldap://ldap2.example.com,ldap://ldap3.example.com
```

The system will:

1. Try each URL in order
2. Use the first successful connection
3. Automatically failover on connection failure

## Log Levels

```bash
--log-level error   # Errors only
--log-level warn    # Warnings and errors
--log-level notice  # Web access logs (recommended for production)
--log-level info    # General information
--log-level debug   # Everything, including debug output
```

## Next Steps

- **[Configuration](configuration.md)** - CLI options and environment variables
- **[Plugins](plugins/README.md)** - Choose and configure plugins
- **[Troubleshooting](troubleshooting.md)** - Problem resolution
