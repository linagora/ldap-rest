# REST API Guide

This guide covers the Mini-DM REST API for managing LDAP users, groups, and organizations. The API follows REST conventions and returns JSON responses.

## Table of Contents

- [Getting Started](#getting-started)
- [Authentication](#authentication)
- [Configuration API](#configuration-api)
- [Organizations API](#organizations-api)
- [Users API](#users-api)
- [Groups API](#groups-api)
- [Error Handling](#error-handling)

---

## Getting Started

### Base URL

All API endpoints are prefixed with `/api/v1` by default:

```
http://localhost:8081/api/v1
```

### Content Type

All requests and responses use JSON:

```
Content-Type: application/json
```

### Request Headers

Required headers for all requests:

```http
Accept: application/json
```

For authenticated endpoints, include the authentication token:

```http
Authorization: Bearer your-token-here
```

---

## Authentication

Mini-DM supports multiple authentication methods. Choose the one that fits your infrastructure.

### 1. No Authentication (Development Only)

For development and testing, you can run Mini-DM without authentication:

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com
```

**Warning:** Never use this in production environments.

### 2. Token Bearer Authentication

Simple stateless authentication using bearer tokens.

**Configuration:**

```bash
--plugin core/auth/token \
--auth-token "secret-token-1" \
--auth-token "secret-token-2"
```

**Usage:**

```bash
curl -H "Authorization: Bearer secret-token-1" \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users
```

**Use Cases:**

- Development and testing
- Service-to-service communication
- CI/CD pipelines
- Simple deployments without SSO

### 3. OpenID Connect

OAuth 2.0 / OpenID Connect authentication for modern web applications.

**Configuration:**

```bash
--plugin core/auth/openidconnect \
--oidc-issuer https://auth.example.com \
--oidc-client-id mini-dm \
--oidc-client-secret your-secret
```

**Usage:**

After obtaining an access token from your OIDC provider:

```bash
curl -H "Authorization: Bearer oidc-access-token" \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users
```

### 4. LemonLDAP::NG

Integration with LemonLDAP::NG Web SSO solution.

**Configuration:**

```bash
--plugin core/auth/llng \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini
```

The plugin reads user information from the `Lm-Remote-User` header set by LemonLDAP::NG.

---

## Configuration API

The Configuration API exposes available features, endpoints, and schemas. Your application can discover capabilities at runtime.

### Get Configuration

Retrieve the complete API configuration including all available resources and their endpoints.

**Endpoint:** `GET /api/v1/config`

**Example Request:**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/config
```

**Example Response:**

```json
{
  "apiPrefix": "/api",
  "ldapBase": "dc=example,dc=com",
  "features": {
    "flatResources": [
      {
        "name": "standardUser",
        "singularName": "user",
        "pluralName": "users",
        "mainAttribute": "uid",
        "objectClass": [
          "top",
          "inetOrgPerson",
          "organizationalPerson",
          "person"
        ],
        "base": "ou=users,dc=example,dc=com",
        "schema": {
          "strict": true,
          "attributes": {
            "uid": {
              "type": "string",
              "required": true,
              "role": "identifier"
            },
            "cn": {
              "type": "string",
              "required": true
            },
            "sn": {
              "type": "string",
              "required": true
            },
            "mail": {
              "type": "string",
              "required": false,
              "role": "primaryEmail"
            }
          }
        },
        "schemaUrl": "/static/schemas/standard/users.json",
        "endpoints": {
          "list": "/api/v1/ldap/users",
          "get": "/api/v1/ldap/users/:id",
          "create": "/api/v1/ldap/users",
          "update": "/api/v1/ldap/users/:id",
          "delete": "/api/v1/ldap/users/:id"
        }
      }
    ],
    "groups": {
      "enabled": true,
      "base": "ou=groups,dc=example,dc=com",
      "mainAttribute": "cn",
      "objectClass": ["top", "groupOfNames"],
      "endpoints": {
        "list": "/api/v1/ldap/groups",
        "get": "/api/v1/ldap/groups/:id",
        "create": "/api/v1/ldap/groups",
        "update": "/api/v1/ldap/groups/:id",
        "delete": "/api/v1/ldap/groups/:id",
        "addMember": "/api/v1/ldap/groups/:id/members",
        "removeMember": "/api/v1/ldap/groups/:id/members/:memberId"
      }
    },
    "organizations": {
      "enabled": true,
      "topOrganization": "ou=organization,dc=example,dc=com",
      "organizationClass": ["top", "organizationalUnit"],
      "linkAttribute": "departmentNumber",
      "pathAttribute": "displayName",
      "pathSeparator": " / ",
      "maxSubnodes": 50,
      "endpoints": {
        "getTop": "/api/v1/ldap/organizations",
        "get": "/api/v1/ldap/organizations/:dn",
        "getSubnodes": "/api/v1/ldap/organizations/:dn/subnodes",
        "searchSubnodes": "/api/v1/ldap/organizations/:dn/subnodes/search"
      }
    }
  }
}
```

**Response Fields:**

- `apiPrefix`: API URL prefix (default: `/api`)
- `ldapBase`: LDAP base DN
- `features.flatResources`: Array of flat LDAP resources (users, positions, etc.)
- `features.groups`: Group management configuration (if enabled)
- `features.organizations`: Organization tree configuration (if enabled)

---

## Organizations API

Manage hierarchical organizational units (OUs) in your LDAP directory.

### Get Top Organization

Retrieve the top-level organization entry.

**Endpoint:** `GET /api/v1/ldap/organizations/top`

**Example Request:**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/organizations/top
```

**Example Response:**

```json
{
  "dn": "ou=organization,dc=example,dc=com",
  "objectClass": ["organizationalUnit", "top"],
  "ou": "organization",
  "description": "Root organization"
}
```

### Get Organization by DN

Retrieve a specific organization by its Distinguished Name.

**Endpoint:** `GET /api/v1/ldap/organizations/:dn`

**Parameters:**

- `:dn` - URL-encoded Distinguished Name

**Example Request:**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/organizations/ou%3Dit%2Cou%3Dorganization%2Cdc%3Dexample%2Cdc%3Dcom
```

**Example Response:**

```json
{
  "dn": "ou=it,ou=organization,dc=example,dc=com",
  "objectClass": ["organizationalUnit", "top"],
  "ou": "it",
  "description": "IT Department"
}
```

### Get Organization Subnodes

Retrieve all child organizational units and linked entities (users/groups) for an organization.

**Endpoint:** `GET /api/v1/ldap/organizations/:dn/subnodes`

**Parameters:**

- `:dn` - URL-encoded Distinguished Name

**Response Limit:** Returns up to 50 linked entities by default (configurable via `--ldap-organization-max-subnodes`)

**Example Request:**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/organizations/ou%3Dit%2Cou%3Dorganization%2Cdc%3Dexample%2Cdc%3Dcom/subnodes
```

**Example Response:**

```json
[
  {
    "dn": "ou=engineering,ou=it,ou=organization,dc=example,dc=com",
    "objectClass": ["organizationalUnit", "top"],
    "ou": "engineering",
    "description": "Engineering Team"
  },
  {
    "dn": "uid=john.doe,ou=users,dc=example,dc=com",
    "objectClass": ["inetOrgPerson", "top"],
    "uid": "john.doe",
    "cn": "John Doe",
    "departmentNumber": "ou=it,ou=organization,dc=example,dc=com"
  }
]
```

### Search Organization Subnodes

Search for subnodes matching a query string within an organization.

**Endpoint:** `GET /api/v1/ldap/organizations/:dn/subnodes/search?q=query`

**Parameters:**

- `:dn` - URL-encoded Distinguished Name
- `q` - Search query (required)

**Example Request:**

```bash
curl -H "Accept: application/json" \
     "http://localhost:8081/api/v1/ldap/organizations/ou%3Dit%2Cou%3Dorganization%2Cdc%3Dexample%2Cdc%3Dcom/subnodes/search?q=john"
```

**Example Response:**

```json
[
  {
    "dn": "uid=john.doe,ou=users,dc=example,dc=com",
    "objectClass": ["inetOrgPerson", "top"],
    "uid": "john.doe",
    "cn": "John Doe",
    "mail": "john.doe@example.com",
    "departmentNumber": "ou=it,ou=organization,dc=example,dc=com"
  }
]
```

### Create Organization

Create a new organizational unit.

**Endpoint:** `POST /api/v1/ldap/organizations`

**Request Body:**

```json
{
  "ou": "marketing",
  "parentDn": "ou=organization,dc=example,dc=com",
  "description": "Marketing Department"
}
```

**Required Fields:**

- `ou` - Organizational unit name

**Optional Fields:**

- `parentDn` - Parent organization DN (defaults to top organization)
- Additional LDAP attributes as needed

**Example Request:**

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "ou": "marketing",
       "parentDn": "ou=organization,dc=example,dc=com",
       "description": "Marketing Department"
     }' \
     http://localhost:8081/api/v1/ldap/organizations
```

**Example Response:**

```json
{
  "success": true,
  "dn": "ou=marketing,ou=organization,dc=example,dc=com"
}
```

### Update Organization

Modify an existing organization using LDAP modify operations.

**Endpoint:** `PUT /api/v1/ldap/organizations/:dn`

**Parameters:**

- `:dn` - URL-encoded Distinguished Name

**Request Body Format:**

```json
{
  "replace": {
    "description": "Updated Marketing Department"
  },
  "add": {
    "telephoneNumber": "+1-555-0100"
  },
  "delete": ["postalCode"]
}
```

**Operations:**

- `replace` - Replace attribute values
- `add` - Add new attribute values
- `delete` - Remove attributes (array of attribute names) or specific values (object)

**Example Request:**

```bash
curl -X PUT \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "replace": {
         "description": "Marketing and Communications"
       }
     }' \
     http://localhost:8081/api/v1/ldap/organizations/ou%3Dmarketing%2Cou%3Dorganization%2Cdc%3Dexample%2Cdc%3Dcom
```

**Example Response:**

```json
{
  "success": true
}
```

### Delete Organization

Delete an organizational unit. The organization must be empty (no linked users/groups).

**Endpoint:** `DELETE /api/v1/ldap/organizations/:dn`

**Parameters:**

- `:dn` - URL-encoded Distinguished Name

**Example Request:**

```bash
curl -X DELETE \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/organizations/ou%3Dmarketing%2Cou%3Dorganization%2Cdc%3Dexample%2Cdc%3Dcom
```

**Example Response:**

```json
{
  "success": true
}
```

**Error Response (non-empty organization):**

```json
{
  "error": "Organization ou=marketing,ou=organization,dc=example,dc=com is not empty"
}
```

---

## Users API

Manage user entries in your LDAP directory. User endpoints are dynamically configured based on loaded schemas.

### List Users

Retrieve all users or filter by attributes.

**Endpoint:** `GET /api/v1/ldap/users`

**Query Parameters:**

- `match` - Filter value (partial match with wildcards)
- `attribute` - Attribute name to filter on
- `attributes` - Comma-separated list of attributes to return

**Example Request (all users):**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users
```

**Example Request (filtered):**

```bash
curl -H "Accept: application/json" \
     "http://localhost:8081/api/v1/ldap/users?match=john&attribute=cn"
```

**Example Response:**

```json
[
  {
    "dn": "uid=john.doe,ou=users,dc=example,dc=com",
    "uid": "john.doe",
    "cn": "John Doe",
    "sn": "Doe",
    "givenName": "John",
    "mail": "john.doe@example.com",
    "telephoneNumber": "+1-555-0123"
  },
  {
    "dn": "uid=jane.smith,ou=users,dc=example,dc=com",
    "uid": "jane.smith",
    "cn": "Jane Smith",
    "sn": "Smith",
    "givenName": "Jane",
    "mail": "jane.smith@example.com"
  }
]
```

### Get User

Retrieve a specific user by UID or DN.

**Endpoint:** `GET /api/v1/ldap/users/:id`

**Parameters:**

- `:id` - User UID or URL-encoded DN

**Example Request (by UID):**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users/john.doe
```

**Example Request (by DN):**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users/uid%3Djohn.doe%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom
```

**Example Response:**

```json
{
  "dn": "uid=john.doe,ou=users,dc=example,dc=com",
  "objectClass": ["inetOrgPerson", "organizationalPerson", "person", "top"],
  "uid": "john.doe",
  "cn": "John Doe",
  "sn": "Doe",
  "givenName": "John",
  "mail": "john.doe@example.com",
  "telephoneNumber": "+1-555-0123",
  "departmentNumber": "ou=it,ou=organization,dc=example,dc=com"
}
```

### Create User

Add a new user to the LDAP directory.

**Endpoint:** `POST /api/v1/ldap/users`

**Request Body:**

```json
{
  "uid": "alice.johnson",
  "cn": "Alice Johnson",
  "sn": "Johnson",
  "givenName": "Alice",
  "mail": "alice.johnson@example.com",
  "telephoneNumber": "+1-555-0124",
  "userPassword": "{SSHA}hashedpassword"
}
```

**Required Fields:** Depends on your schema. Typically:

- `uid` - User identifier
- `cn` - Common name
- `sn` - Surname

**Example Request:**

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "uid": "alice.johnson",
       "cn": "Alice Johnson",
       "sn": "Johnson",
       "givenName": "Alice",
       "mail": "alice.johnson@example.com"
     }' \
     http://localhost:8081/api/v1/ldap/users
```

**Example Response:**

```json
{
  "success": true,
  "dn": "uid=alice.johnson,ou=users,dc=example,dc=com"
}
```

### Update User

Modify an existing user using LDAP modify operations.

**Endpoint:** `PUT /api/v1/ldap/users/:id`

**Parameters:**

- `:id` - User UID or URL-encoded DN

**Request Body Format:**

```json
{
  "replace": {
    "mail": "alice.j@example.com",
    "telephoneNumber": "+1-555-0199"
  },
  "add": {
    "mailAlternateAddress": ["alice.johnson@example.com"]
  },
  "delete": ["mobile"]
}
```

**Operations:**

- `replace` - Replace attribute values
- `add` - Add new attribute values (for multi-valued attributes)
- `delete` - Remove attributes (array) or specific values (object)

**Example Request:**

```bash
curl -X PUT \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "replace": {
         "telephoneNumber": "+1-555-0200"
       }
     }' \
     http://localhost:8081/api/v1/ldap/users/alice.johnson
```

**Example Response:**

```json
{
  "success": true
}
```

### Delete User

Remove a user from the LDAP directory. The user is automatically removed from all groups.

**Endpoint:** `DELETE /api/v1/ldap/users/:id`

**Parameters:**

- `:id` - User UID or URL-encoded DN

**Example Request:**

```bash
curl -X DELETE \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/users/alice.johnson
```

**Example Response:**

```json
{
  "success": true
}
```

---

## Groups API

Manage LDAP groups and their members.

### List Groups

Retrieve all groups or filter by name.

**Endpoint:** `GET /api/v1/ldap/groups`

**Query Parameters:**

- `match` - Filter groups by CN (supports LDAP filter format or simple string)
- `attributes` - Comma-separated list of attributes to return

**Example Request (all groups):**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/groups
```

**Example Request (filtered):**

```bash
curl -H "Accept: application/json" \
     "http://localhost:8081/api/v1/ldap/groups?match=admin*"
```

**Example Response:**

```json
{
  "admins": {
    "dn": "cn=admins,ou=groups,dc=example,dc=com",
    "cn": "admins",
    "member": [
      "uid=john.doe,ou=users,dc=example,dc=com",
      "uid=jane.smith,ou=users,dc=example,dc=com"
    ]
  },
  "developers": {
    "dn": "cn=developers,ou=groups,dc=example,dc=com",
    "cn": "developers",
    "member": ["uid=alice.johnson,ou=users,dc=example,dc=com"]
  }
}
```

### Get Group

Retrieve a specific group by CN or DN.

**Endpoint:** `GET /api/v1/ldap/groups/:cn`

**Parameters:**

- `:cn` - Group CN or URL-encoded DN

**Example Request:**

```bash
curl -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/groups/admins
```

**Example Response:**

```json
{
  "dn": "cn=admins,ou=groups,dc=example,dc=com",
  "objectClass": ["groupOfNames", "top"],
  "cn": "admins",
  "description": "System Administrators",
  "member": [
    "uid=john.doe,ou=users,dc=example,dc=com",
    "uid=jane.smith,ou=users,dc=example,dc=com"
  ]
}
```

### Create Group

Add a new group to the LDAP directory.

**Endpoint:** `POST /api/v1/ldap/groups`

**Request Body:**

```json
{
  "cn": "developers",
  "description": "Development Team",
  "member": ["uid=alice.johnson,ou=users,dc=example,dc=com"]
}
```

**Required Fields:**

- `cn` - Group common name

**Optional Fields:**

- `member` - Array of member DNs
- `description` - Group description
- Additional LDAP attributes as needed

**Note:** Groups require at least one member. If no members are provided, a dummy member is automatically added.

**Example Request:**

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "cn": "developers",
       "description": "Development Team",
       "member": ["uid=alice.johnson,ou=users,dc=example,dc=com"]
     }' \
     http://localhost:8081/api/v1/ldap/groups
```

**Example Response:**

```json
{
  "success": true,
  "dn": "cn=developers,ou=groups,dc=example,dc=com"
}
```

### Update Group

Modify an existing group using LDAP modify operations.

**Endpoint:** `PUT /api/v1/ldap/groups/:cn`

**Parameters:**

- `:cn` - Group CN or URL-encoded DN

**Request Body Format:**

```json
{
  "replace": {
    "description": "Software Development Team"
  },
  "add": {
    "businessCategory": "Engineering"
  },
  "delete": ["seeAlso"]
}
```

**Important:** Do not use this endpoint to add/remove members. Use the dedicated member management endpoints instead.

**Example Request:**

```bash
curl -X PUT \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "replace": {
         "description": "Software Development Team"
       }
     }' \
     http://localhost:8081/api/v1/ldap/groups/developers
```

**Example Response:**

```json
{
  "success": true
}
```

### Delete Group

Remove a group from the LDAP directory.

**Endpoint:** `DELETE /api/v1/ldap/groups/:cn`

**Parameters:**

- `:cn` - Group CN or URL-encoded DN

**Example Request:**

```bash
curl -X DELETE \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/groups/developers
```

**Example Response:**

```json
{
  "success": true
}
```

### Add Group Member

Add one or more users to a group.

**Endpoint:** `POST /api/v1/ldap/groups/:cn/members`

**Parameters:**

- `:cn` - Group CN or URL-encoded DN

**Request Body:**

```json
{
  "member": "uid=bob.wilson,ou=users,dc=example,dc=com"
}
```

Or multiple members:

```json
{
  "member": [
    "uid=bob.wilson,ou=users,dc=example,dc=com",
    "uid=carol.white,ou=users,dc=example,dc=com"
  ]
}
```

**Example Request:**

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -H "Accept: application/json" \
     -d '{
       "member": "uid=bob.wilson,ou=users,dc=example,dc=com"
     }' \
     http://localhost:8081/api/v1/ldap/groups/developers/members
```

**Example Response:**

```json
{
  "success": true
}
```

### Remove Group Member

Remove a user from a group.

**Endpoint:** `DELETE /api/v1/ldap/groups/:cn/members/:memberId`

**Parameters:**

- `:cn` - Group CN or URL-encoded DN
- `:memberId` - URL-encoded member DN

**Example Request:**

```bash
curl -X DELETE \
     -H "Accept: application/json" \
     http://localhost:8081/api/v1/ldap/groups/developers/members/uid%3Dbob.wilson%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom
```

**Example Response:**

```json
{
  "success": true
}
```

---

## Error Handling

### HTTP Status Codes

| Status Code | Description                            |
| ----------- | -------------------------------------- |
| 200         | Success                                |
| 201         | Created                                |
| 400         | Bad Request - Invalid input            |
| 401         | Unauthorized - Authentication required |
| 403         | Forbidden - Insufficient permissions   |
| 404         | Not Found - Resource doesn't exist     |
| 409         | Conflict - Resource already exists     |
| 500         | Internal Server Error                  |

### Error Response Format

All errors return a JSON object with an error message:

```json
{
  "error": "Description of the error"
}
```

### Common Errors

#### 400 Bad Request

**Missing Required Fields:**

```json
{
  "error": "Attribute \"sn\" is required"
}
```

**Invalid Attribute Format:**

```json
{
  "error": "Invalid value for attribute \"uid\": must match ^[a-zA-Z0-9._-]{1,255}$"
}
```

**Invalid LDAP Filter:**

```json
{
  "error": "Invalid match query"
}
```

#### 401 Unauthorized

**Missing Authentication:**

```json
{
  "error": "Unauthorized"
}
```

**Invalid Token:**

```json
{
  "error": "Unauthorized"
}
```

#### 404 Not Found

**User Not Found:**

```json
{
  "error": "User not found"
}
```

**Group Not Found:**

```json
{
  "error": "Group not found"
}
```

**Organization Not Found:**

```json
{
  "error": "Organization ou=marketing,ou=organization,dc=example,dc=com not found"
}
```

#### 409 Conflict

**Duplicate Entry:**

```json
{
  "error": "Failed to add user uid=john.doe,ou=users,dc=example,dc=com: Entry Already Exists"
}
```

#### 500 Internal Server Error

**LDAP Connection Error:**

```json
{
  "error": "LDAP bind error"
}
```

**General Server Error:**

```json
{
  "error": "Internal server error: <details>"
}
```

---

## Tips and Best Practices

### URL Encoding

Always URL-encode DNs when using them in URL paths:

```javascript
const dn = 'uid=john.doe,ou=users,dc=example,dc=com';
const encoded = encodeURIComponent(dn);
// Result: uid%3Djohn.doe%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom
```

### LDAP Attributes are Arrays

LDAP attributes are always returned as arrays, even for single-valued attributes:

```json
{
  "uid": "john.doe", // Actually stored as ["john.doe"]
  "cn": "John Doe", // Actually stored as ["John Doe"]
  "mail": "john@example.com" // Actually stored as ["john@example.com"]
}
```

When sending data, you can use either format:

```json
{
  "uid": "john.doe",
  "cn": ["John Doe"],
  "mail": ["john@example.com", "jdoe@example.com"]
}
```

### Modify Operations

Use the correct operation type:

- **replace**: Change an existing value (creates if doesn't exist)
- **add**: Add values to multi-valued attributes (error if already exists)
- **delete**: Remove attributes or specific values

### Pagination

For large result sets, consider implementing client-side pagination or use LDAP paging (controlled server-side).

### Schema Validation

Always check the schema via `/api/v1/config` to understand:

- Required attributes
- Attribute types and formats
- Allowed values and patterns

### Testing

Use the Configuration API to discover available endpoints before making requests:

```bash
# 1. Get configuration
CONFIG=$(curl -s http://localhost:8081/api/v1/config)

# 2. Extract users endpoint
USERS_ENDPOINT=$(echo $CONFIG | jq -r '.features.flatResources[0].endpoints.list')

# 3. Use endpoint
curl -s $USERS_ENDPOINT
```

---

## Next Steps

- **[API Reference](./REFERENCE.md)** - Complete reference with all HTTP status codes and formats
- **[Browser Libraries](../browser/LIBRARIES.md)** - Pre-built JavaScript clients
- **[Examples](../examples/EXAMPLES.md)** - Integration examples for React, Vue, and Vanilla JS
- **[Schemas](../schemas/SCHEMAS.md)** - Understanding and creating JSON schemas
