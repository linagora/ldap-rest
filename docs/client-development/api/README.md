# REST API

LDAP-Rest REST API documentation.

## Overview

The LDAP-Rest REST API exposes endpoints for managing LDAP entities.

## Documentation

- **[rest-api.md](rest-api.md)** - Complete API usage guide
- **[reference.md](reference.md)** - Technical reference (HTTP codes, headers, URL encoding)
- **[openapi.md](openapi.md)** - OpenAPI specification

## Authentication

All API requests require authentication. See the [authentication documentation](../../usage/plugins/auth/README.md).

### Token Example

```bash
curl -H "Authorization: Bearer your-token" \
  http://localhost:8081/api/v1/ldap/users
```

## Main Endpoints

### Entities (ldapFlatGeneric)

```
GET    /api/v1/ldap/{pluralName}           # List
GET    /api/v1/ldap/{pluralName}/{id}      # Get
POST   /api/v1/ldap/{pluralName}           # Create
PUT    /api/v1/ldap/{pluralName}/{id}      # Modify
DELETE /api/v1/ldap/{pluralName}/{id}      # Delete
```

### Groups

```
GET    /api/v1/ldap/groups
GET    /api/v1/ldap/groups/{cn}
POST   /api/v1/ldap/groups
PUT    /api/v1/ldap/groups/{cn}
DELETE /api/v1/ldap/groups/{cn}
```

### Organizations

```
GET    /api/v1/ldap/organizations/top
GET    /api/v1/ldap/organizations/{dn}/subnodes
POST   /api/v1/ldap/organizations
PUT    /api/v1/ldap/organizations/{dn}
DELETE /api/v1/ldap/organizations/{dn}
```

### Configuration

```
GET    /api/v1/config     # Available capabilities and schemas
```

## Response Codes

| Code | Description               |
| ---- | ------------------------- |
| 200  | Success                   |
| 201  | Created                   |
| 400  | Invalid request           |
| 401  | Not authenticated         |
| 403  | Access forbidden          |
| 404  | Not found                 |
| 409  | Conflict (existing entry) |
| 500  | Server error              |
