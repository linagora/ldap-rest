# LDAP Flat Generic Plugin

Generic plugin to manage flat LDAP entities using JSON schema files. Automatically creates API endpoints based on schema metadata.

## Overview

The `ldapFlatGeneric` plugin provides a schema-driven approach to managing LDAP flat entities (users, positions, or any custom entity type). Instead of writing custom plugins, you define entity schemas in JSON files, and the plugin automatically generates:

- REST API endpoints (GET, POST, PUT, DELETE)
- Schema validation
- LDAP CRUD operations
- Search functionality
- Hooks for customization

## Configuration

```bash
--plugin core/ldap/flatGeneric \
--ldap-flat-schema ./static/schemas/twake/users.json \
--ldap-flat-schema ./static/schemas/twake/positions.json
```

**Environment Variable:**

```bash
DM_LDAP_FLAT_SCHEMA="./static/schemas/twake/users.json,./static/schemas/twake/positions.json"
```

## Schema Format

Each schema file must include an `entity` metadata section and attribute definitions.

### Basic Schema Structure

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
  },
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["top", "twakeAccount"],
      "required": true,
      "fixed": true
    },
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

### Entity Metadata

- **name**: Internal name used for hooks (e.g., `ldap{name}add`)
- **mainAttribute**: DN attribute (e.g., `uid`, `cn`)
- **objectClass**: LDAP objectClass values
- **singularName**: Used in API paths and messages (e.g., "user")
- **pluralName**: Used in API paths (e.g., "users")
- **base**: LDAP base DN, supports config placeholders like `{ldap_base}`
- **defaultAttributes**: Default values for optional attributes

### Attribute Types

#### String

```json
{
  "cn": {
    "type": "string",
    "test": "^[a-zA-Z ]+$",
    "required": true
  }
}
```

#### Array

```json
{
  "objectClass": {
    "type": "array",
    "items": { "type": "string" },
    "default": ["top", "person"],
    "required": true
  }
}
```

#### Pointer (DN Reference)

```json
{
  "manager": {
    "type": "pointer",
    "branch": ["ou=users,o=gov,c=mu"],
    "required": false
  }
}
```

Pointer validation ensures the DN exists and is within allowed branches.

#### Fixed Attributes

```json
{
  "objectClass": {
    "type": "array",
    "fixed": true,
    "default": ["top", "person"]
  }
}
```

Fixed attributes:

- Auto-provisioned with default value on creation
- Cannot be modified after creation
- Cannot be deleted

## Generated APIs

For each schema, the plugin generates REST API endpoints:

### List Entries

```bash
GET /api/v1/ldap/{pluralName}?match={filter}&attributes={attrs}
```

**Example:**

```bash
curl http://localhost:8081/api/v1/ldap/users?match=uid=*smith*&attributes=uid,cn,mail
```

**Response:**

```json
{
  "jsmith": {
    "dn": "uid=jsmith,ou=users,o=gov,c=mu",
    "uid": "jsmith",
    "cn": "John Smith",
    "mail": "jsmith@example.com"
  }
}
```

### Get Entry

```bash
GET /api/v1/ldap/{pluralName}/{id}
```

**Example:**

```bash
curl http://localhost:8081/api/v1/ldap/users/jsmith
```

### Create Entry

```bash
POST /api/v1/ldap/{pluralName}
Content-Type: application/json

{
  "uid": "newuser",
  "cn": "New User",
  "sn": "User",
  "mail": "newuser@example.com"
}
```

### Modify Entry

```bash
PUT /api/v1/ldap/{pluralName}/{id}
Content-Type: application/json

{
  "replace": {
    "cn": "Updated Name"
  },
  "add": {
    "telephoneNumber": "+1234567890"
  },
  "delete": ["description"]
}
```

### Delete Entry

```bash
DELETE /api/v1/ldap/{pluralName}/{id}
```

## Schema Examples

### Example 1: Simple Users

```json
{
  "entity": {
    "name": "standardUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "inetOrgPerson"],
    "singularName": "user",
    "pluralName": "users",
    "base": "ou=users,{ldap_base}"
  },
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["top", "inetOrgPerson"],
      "required": true,
      "fixed": true
    },
    "uid": {
      "type": "string",
      "test": "^[a-z][a-z0-9_-]{2,32}$",
      "required": true
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
      "test": "^[^@]+@[^@]+\\.[^@]+$",
      "required": false
    }
  }
}
```

### Example 2: Positions/Roles

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
    "objectClass": {
      "type": "array",
      "default": ["top", "twakePosition"],
      "required": true,
      "fixed": true
    },
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

### Example 3: With Pointers

```json
{
  "entity": {
    "name": "employee",
    "mainAttribute": "uid",
    "objectClass": ["top", "inetOrgPerson", "employee"],
    "singularName": "employee",
    "pluralName": "employees",
    "base": "ou=employees,{ldap_base}"
  },
  "attributes": {
    "uid": {
      "type": "string",
      "required": true
    },
    "cn": {
      "type": "string",
      "required": true
    },
    "sn": {
      "type": "string",
      "required": true
    },
    "manager": {
      "type": "pointer",
      "branch": ["ou=employees,{ldap_base}"],
      "required": false
    },
    "departmentNumber": {
      "type": "pointer",
      "branch": ["ou=departments,{ldap_base}"],
      "required": true
    }
  }
}
```

## Hooks

The plugin generates hooks for each entity type:

- `ldap{Name}add` - Before adding entry
- `ldap{Name}adddone` - After adding entry
- `ldap{Name}modify` - Before modifying entry
- `ldap{Name}modifydone` - After modifying entry
- `ldap{Name}delete` - Before deleting entry
- `ldap{Name}deletedone` - After deleting entry

**Example:** For an entity named `twakeUser`, hooks are:

- `ldaptwakeUseradd`
- `ldaptwakeUseradddone`
- etc.

## Validation

### Schema Validation

All operations are validated against the schema:

- **Required attributes**: Must be present
- **Type checking**: String, array, etc.
- **Pattern matching**: Regex validation via `test` property
- **Pointer validation**: DN must exist and be in allowed branch
- **Fixed attributes**: Cannot be modified or deleted

### Strict Mode

When `"strict": true`, only attributes defined in the schema are allowed. Additional attributes are rejected.

When `"strict": false`, additional attributes are permitted.

## Configuration Placeholders

Schema bases can use configuration placeholders:

```json
{
  "entity": {
    "base": "ou=users,{ldap_base}"
  }
}
```

Placeholders are replaced with config values:

- `{ldap_base}` → `--ldap-base` value
- `{ldap_top_organization}` → `--ldap-top-organization` value
- Any config key in lowercase with underscores

## Multiple Schemas

Load multiple schemas to manage different entity types:

```bash
--ldap-flat-schema ./schemas/users.json \
--ldap-flat-schema ./schemas/positions.json \
--ldap-flat-schema ./schemas/contractors.json
```

Each schema creates separate API endpoints under its `pluralName`.

## Integration with Other Plugins

### With onChange

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--ldap-flat-schema ./schemas/users.json \
--mail-attribute mail
```

Generates `onLdapMailChange` hooks when mail attribute changes.

### With James (Twake Mail)

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/james \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--james-webadmin-url http://localhost:8000
```

Automatically syncs mail changes to James mail server.

## Comparison with ldapFlat (Deprecated)

| Feature            | ldapFlat                | ldapFlatGeneric              |
| ------------------ | ----------------------- | ---------------------------- |
| **Configuration**  | Hardcoded plugin        | JSON schema files            |
| **Flexibility**    | Limited to users/groups | Any entity type              |
| **Validation**     | Basic                   | Full schema validation       |
| **Maintenance**    | Manual code changes     | Update JSON files            |
| **Multiple Types** | Separate plugins        | One plugin, multiple schemas |

**Migration:** Replace `ldapFlat` plugins with `ldapFlatGeneric` and schema files.

## See Also

- [ldapFlat.md](ldapFlat.md) - Legacy flat LDAP plugin
- [ldapGroups.md](ldapGroups.md) - Group management
- [ldapOrganizations.md](ldapOrganizations.md) - Organization tree
