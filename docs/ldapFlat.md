# LDAP Flat Plugin

The `ldapFlat` generic plugin allows you to manage LDAP entities in flat branches (non-hierarchical) through a simple schema-driven approach, without writing any code.

## Overview

The plugin automatically creates REST APIs for any flat LDAP structure by reading enriched JSON schemas. It's perfect for managing:
- Users
- Positions
- Nomenclature items (titles, list types, delivery modes, etc.)
- Any other flat LDAP entity

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/ldapFlat \
--ldap-flat-schema ./static/schemas/twake/users.json \
--ldap-flat-schema ./static/schemas/twake/positions.json \
--ldap-flat-schema ./static/schemas/twake/nomenclature/twakeTitle.json
```

Or using the plural alias:
```bash
--ldap-flat-schemas ./static/schemas/twake/users.json,./static/schemas/twake/positions.json
```

### Environment Variable

```bash
DM_LDAP_FLAT_SCHEMA="./path/to/schema1.json,./path/to/schema2.json"
```

## Schema Format

An enriched schema contains two main sections:

### 1. Entity Metadata

Describes how the plugin should handle this entity:

```json
{
  "entity": {
    "name": "twakeUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "twakeAccount", "twakeWhitePages"],
    "singularName": "user",
    "pluralName": "users",
    "base": "ou=users,{ldap_base}",
    "defaultAttributes": {}
  }
}
```

**Fields:**
- `name` (required): Unique name for this entity type, used as hook prefix (`ldap{name}`)
- `mainAttribute` (required): The RDN attribute (e.g., `uid`, `cn`)
- `objectClass` (required): Array of LDAP object classes to use
- `singularName` (required): Singular name for API paths (e.g., `/api/v1/ldap/user`)
- `pluralName` (required): Plural name for collection API paths (e.g., `/api/v1/ldap/users`)
- `base` (required): LDAP DN base with config placeholders support
- `defaultAttributes` (optional): Default attributes to add when creating entries

**Base Path Placeholders:**

The `base` field supports dynamic config value substitution:
- `{ldap_base}` → Replaced by `--ldap-base` value
- `{ldap_user_branch}` → Replaced by `--ldap-user-branch` value
- `{any_config_key}` → Replaced by corresponding config value

### 2. Attribute Validation Schema

Standard JSON schema for validating LDAP attributes:

```json
{
  "strict": true,
  "attributes": {
    "uid": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]{1,255}$",
      "required": true
    },
    "cn": {
      "type": "string",
      "required": true
    },
    "mail": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      "required": false
    }
  }
}
```

**Validation Rules:**
- `strict: true` → Reject attributes not defined in schema
- `type`: `string`, `array`, `number`, `boolean`
- `test`: Regular expression pattern for validation
- `required`: Whether the attribute is mandatory
- `default`: Default value if not provided

## Generated APIs

For each schema, the plugin automatically generates these REST endpoints:

### List Entities
```http
GET /api/v1/ldap/{pluralName}
```

**Query Parameters:**
- `match` (optional): Filter pattern for the main attribute
- `attribute` (optional): Attribute name to search (used with `match`)
- `attributes` (optional): Comma-separated list of attributes to return

**Example:**
```bash
curl "http://localhost:8081/api/v1/ldap/users?match=john&attribute=uid&attributes=uid,mail,cn"
```

**Response (200):**
```json
{
  "john.doe": {
    "dn": "uid=john.doe,ou=users,o=gov,c=mu",
    "uid": "john.doe",
    "mail": "john.doe@example.com",
    "cn": "John Doe"
  }
}
```

### Create Entity
```http
POST /api/v1/ldap/{pluralName}
```

**Request Body:**
```json
{
  "uid": "john.doe",
  "cn": "John Doe",
  "sn": "Doe",
  "mail": "john.doe@example.com"
}
```

**Response (201):**
```json
{
  "dn": "uid=john.doe,ou=users,o=gov,c=mu",
  "uid": "john.doe",
  "cn": "John Doe",
  "sn": "Doe",
  "mail": "john.doe@example.com"
}
```

### Modify Entity
```http
PUT /api/v1/ldap/{pluralName}/{id}
```

**Path Parameter:**
- `id`: Main attribute value OR full DN

**Request Body:**
```json
{
  "replace": {
    "mail": "new.email@example.com",
    "displayName": "John A. Doe"
  },
  "add": {
    "telephoneNumber": "+1234567890"
  },
  "delete": ["mobile"]
}
```

**Response (200):**
```json
{
  "success": true
}
```

### Delete Entity
```http
DELETE /api/v1/ldap/{pluralName}/{id}
```

**Path Parameter:**
- `id`: Main attribute value OR full DN

**Response (200):**
```json
{
  "success": true
}
```

## Examples

### Example 1: Managing Users

**Schema:** `static/schemas/twake/users.json`

```json
{
  "entity": {
    "name": "twakeUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "twakeAccount", "twakeWhitePages"],
    "singularName": "user",
    "pluralName": "users",
    "base": "{ldap_user_branch}"
  },
  "strict": true,
  "attributes": {
    "uid": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]{1,255}$",
      "required": true
    },
    "cn": { "type": "string", "required": true },
    "sn": { "type": "string", "required": true },
    "mail": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      "required": false
    },
    "twakeDepartmentLink": {
      "type": "string",
      "required": true
    },
    "twakeDepartmentPath": {
      "type": "string",
      "required": true
    }
  }
}
```

**Generated APIs:**
- `GET /api/v1/ldap/users` - List all users
- `POST /api/v1/ldap/users` - Create user
- `PUT /api/v1/ldap/users/{uid}` - Modify user
- `DELETE /api/v1/ldap/users/{uid}` - Delete user

### Example 2: Managing Job Positions

**Schema:** `static/schemas/twake/positions.json`

```json
{
  "entity": {
    "name": "twakePosition",
    "mainAttribute": "cn",
    "objectClass": ["top", "twakePosition"],
    "singularName": "position",
    "pluralName": "positions",
    "base": "ou=positions,{ldap_base}"
  },
  "strict": true,
  "attributes": {
    "cn": {
      "type": "string",
      "test": "^[a-zA-Z0-9 &/,.-]+$",
      "required": true
    },
    "description": {
      "type": "string",
      "required": false
    }
  }
}
```

**Generated APIs:**
- `GET /api/v1/ldap/positions`
- `POST /api/v1/ldap/positions`
- `PUT /api/v1/ldap/positions/{cn}`
- `DELETE /api/v1/ldap/positions/{cn}`

### Example 3: Managing Nomenclature (Titles)

**Schema:** `static/schemas/twake/nomenclature/twakeTitle.json`

```json
{
  "entity": {
    "name": "twakeTitle",
    "mainAttribute": "cn",
    "objectClass": ["top", "applicationProcess"],
    "singularName": "title",
    "pluralName": "titles",
    "base": "ou=twakeTitle,ou=nomenclature,{ldap_base}"
  },
  "strict": true,
  "attributes": {
    "cn": {
      "type": "string",
      "test": "^[a-zA-Z][a-zA-Z0-9 .]+$",
      "required": true
    },
    "description": {
      "type": "string",
      "required": false
    }
  }
}
```

**Generated APIs:**
- `GET /api/v1/ldap/titles`
- `POST /api/v1/ldap/titles`
- `PUT /api/v1/ldap/titles/{cn}`
- `DELETE /api/v1/ldap/titles/{cn}`

## Hooks

The plugin emits lifecycle hooks for each entity type, using the format `ldap{name}{action}`:

- `ldap{name}addrequest` - Before creating entry (can modify dn and attributes)
- `ldap{name}adddone` - After successful creation
- `ldap{name}modify` - Before modifying entry
- `ldap{name}modifydone` - After successful modification
- `ldap{name}rename` - Before renaming entry
- `ldap{name}delete` - Before deleting entry
- `ldap{name}deletedone` - After successful deletion

**Example:** For the `twakeUser` entity:
```javascript
hooks: {
  ldaptwakeUseraddrequest: async ([dn, entry, op]) => {
    // Validate or modify entry before creation
    console.log('Creating user:', dn);
    return [dn, entry, op];
  }
}
```

## Schema Variants

The repository includes three schema variants for common use cases:

### Twake Schemas (`static/schemas/twake/`)
- Uses Twake-specific attributes (`twakeDepartmentLink`, `twakeDepartmentPath`)
- Custom object classes (`twakeAccount`, `twakeWhitePages`)
- Best for Twake deployments

### Standard Schemas (`static/schemas/standard/`)
- Uses standard LDAP attributes (`departmentNumber`, `businessCategory`)
- Standard object classes (`inetOrgPerson`, `organizationalPerson`)
- Best for interoperability with other LDAP tools

### Active Directory Schemas (`static/schemas/ad/`)
- Uses Microsoft AD conventions (`sAMAccountName`, `userPrincipalName`)
- AD-specific attributes (`managedBy`, `memberOf`)
- Best for Active Directory integration

## Notes

- All entities must be in **flat branches** (non-hierarchical)
- For hierarchical structures (like organizations), use the dedicated `ldap/organization` plugin
- The plugin validates all inputs against the schema before performing LDAP operations
- Multiple instances can be created by providing multiple schema files
- Each instance operates independently with its own API endpoints

## See Also

- [LDAP Organizations Plugin](./ldapOrganizations.md) - For hierarchical LDAP structures
- [LDAP Groups Plugin](./ldapGroups.md) - For managing groups with member validation
- [Schema Examples](../static/schemas/) - Complete schema examples
