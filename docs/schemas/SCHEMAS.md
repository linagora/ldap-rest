# JSON Schemas Documentation

LDAP-Rest uses JSON schemas to define LDAP entity structure, validation rules, and UI behavior. Schemas are the foundation for API operations, data validation, and automatic user interface generation.

---

## Table of Contents

- [Schema Structure](#schema-structure)
- [Entity Metadata](#entity-metadata)
- [Attribute Types](#attribute-types)
- [Attribute Properties](#attribute-properties)
- [Semantic Roles](#semantic-roles)
- [Validation Rules](#validation-rules)
- [Predefined Schemas](#predefined-schemas)

---

## Schema Structure

A complete schema consists of two main sections: entity metadata and attribute definitions.

### Complete Example

```json
{
  "entity": {
    "name": "standardUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "inetOrgPerson", "organizationalPerson", "person"],
    "singularName": "user",
    "pluralName": "users",
    "base": "ou=users,dc=example,dc=com",
    "defaultAttributes": {
      "cn": "New User",
      "sn": "User"
    }
  },
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "items": {
        "type": "string",
        "test": "^[a-zA-Z][a-zA-Z0-9-]*$"
      },
      "default": ["top", "inetOrgPerson", "organizationalPerson", "person"],
      "required": true,
      "fixed": true
    },
    "uid": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]{1,255}$",
      "required": true,
      "role": "identifier"
    },
    "cn": {
      "type": "string",
      "required": true,
      "role": "displayName"
    },
    "sn": {
      "type": "string",
      "required": true
    },
    "mail": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      "required": false,
      "role": "primaryEmail"
    },
    "mailAlternateAddress": {
      "type": "array",
      "items": {
        "type": "string",
        "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
      },
      "required": false,
      "role": "emailAliases"
    },
    "mailQuota": {
      "type": "number",
      "required": false,
      "role": "emailQuota"
    },
    "givenName": {
      "type": "string",
      "required": false
    },
    "displayName": {
      "type": "string",
      "required": false
    },
    "telephoneNumber": {
      "type": "string",
      "required": false
    },
    "mobile": {
      "type": "string",
      "required": false
    },
    "userPassword": {
      "type": "string",
      "required": false
    },
    "departmentNumber": {
      "type": "string",
      "test": "^.*,dc=example,dc=com$",
      "required": false
    }
  }
}
```

---

## Entity Metadata

The `entity` section defines metadata about the LDAP entity type.

### Entity Properties Table

| Property            | Type     | Required | Description                              | Example                              |
| ------------------- | -------- | -------- | ---------------------------------------- | ------------------------------------ |
| `name`              | string   | Yes      | Internal entity identifier               | `"standardUser"`, `"twakeGroup"`     |
| `mainAttribute`     | string   | Yes      | Primary identifier attribute (RDN)       | `"uid"`, `"cn"`, `"sAMAccountName"`  |
| `objectClass`       | string[] | Yes      | LDAP objectClass values for new entries  | `["top", "inetOrgPerson"]`           |
| `singularName`      | string   | Yes      | Singular name for API routes             | `"user"`, `"group"`, `"position"`    |
| `pluralName`        | string   | Yes      | Plural name for API routes               | `"users"`, `"groups"`, `"positions"` |
| `base`              | string   | Yes      | LDAP base DN for this entity type        | `"ou=users,dc=example,dc=com"`       |
| `defaultAttributes` | object   | No       | Default attribute values for new entries | `{"cn": "New User", "sn": "User"}`   |

### Entity Metadata Example

```json
{
  "entity": {
    "name": "twakeUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "twakeAccount", "twakeWhitePages"],
    "singularName": "user",
    "pluralName": "users",
    "base": "ou=users,dc=example,dc=com",
    "defaultAttributes": {
      "cn": "New User",
      "sn": "User",
      "twakeAccountStatus": "active"
    }
  }
}
```

### Base DN Variable Substitution

Use `{ldap_base}` or `__ldap_base__` in the base DN to reference the configured LDAP base:

```json
{
  "entity": {
    "base": "ou=users,{ldap_base}"
  }
}
```

This will be replaced with the actual LDAP base at runtime (e.g., `ou=users,dc=example,dc=com`).

---

## Attribute Types

LDAP-Rest supports three main attribute types: `string`, `array`, and `pointer`.

### String Type

Simple text values.

**Properties:**

- `type`: `"string"`
- `test`: Optional regex pattern for validation
- `required`: Whether the attribute is mandatory
- `default`: Default value for new entries

**Example:**

```json
{
  "uid": {
    "type": "string",
    "test": "^[a-zA-Z0-9._-]{1,255}$",
    "required": true,
    "role": "identifier"
  },
  "mail": {
    "type": "string",
    "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    "required": false,
    "role": "primaryEmail"
  },
  "telephoneNumber": {
    "type": "string",
    "required": false
  }
}
```

### Array Type

Multi-valued attributes containing multiple items of the same type.

**Properties:**

- `type`: `"array"`
- `items`: Object defining the type and validation for array elements
- `required`: Whether the attribute is mandatory
- `default`: Default array value for new entries

**Example:**

```json
{
  "objectClass": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[a-zA-Z][a-zA-Z0-9-]*$"
    },
    "default": ["top", "inetOrgPerson", "organizationalPerson", "person"],
    "required": true,
    "fixed": true
  },
  "mailAlternateAddress": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
    },
    "required": false,
    "role": "emailAliases"
  },
  "member": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[a-zA-Z]+=.*,dc=example,dc=com$"
    },
    "required": false
  }
}
```

### Pointer Type

References to other LDAP entries (DN pointers). Used for relationships like group membership, organizational units, or nomenclature references.

**Properties:**

- `type`: `"pointer"`
- `branch`: Array of LDAP base DNs where referenced entries can be found
- `ui`: Optional UI configuration for pointer selection (not yet implemented)
- `required`: Whether the pointer is mandatory

**Example:**

```json
{
  "twakeAccountStatus": {
    "type": "pointer",
    "branch": ["ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"],
    "required": true
  },
  "twakeDeliveryMode": {
    "type": "pointer",
    "branch": ["ou=twakeDeliveryMode,ou=nomenclature,dc=example,dc=com"],
    "required": true
  },
  "twakeDelegatedUsers": {
    "type": "array",
    "items": {
      "type": "pointer",
      "branch": ["ou=users,dc=example,dc=com"]
    },
    "required": false
  }
}
```

**Pointer Arrays:**

Pointer types can also be used within arrays to create multi-valued references:

```json
{
  "twakeDelegatedUsers": {
    "type": "array",
    "items": {
      "type": "pointer",
      "branch": ["ou=users,dc=example,dc=com"]
    },
    "required": false
  }
}
```

### Number and Integer Types

Numeric values for counters, IDs, or quota management.

**Example:**

```json
{
  "mailQuota": {
    "type": "number",
    "required": false,
    "role": "emailQuota"
  },
  "mailQuotaSize": {
    "type": "integer",
    "required": false
  },
  "userAccountControl": {
    "type": "number",
    "required": false
  }
}
```

---

## Attribute Properties

Complete reference for all attribute properties.

### Attribute Properties Table

| Property   | Type         | Applies To          | Description                                                                      | Example                             |
| ---------- | ------------ | ------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| `type`     | string       | All                 | Attribute data type: `"string"`, `"array"`, `"pointer"`, `"number"`, `"integer"` | `"string"`                          |
| `required` | boolean      | All                 | Whether the attribute must be present                                            | `true`                              |
| `fixed`    | boolean      | All                 | Whether the attribute value cannot be changed after creation                     | `true`                              |
| `role`     | string       | String              | Semantic role for special handling (see [Semantic Roles](#semantic-roles))       | `"identifier"`                      |
| `test`     | string/regex | String, Array items | Regular expression for validation                                                | `"^[a-zA-Z0-9._-]{1,255}$"`         |
| `branch`   | string[]     | Pointer             | LDAP branches where referenced entries exist                                     | `["ou=users,dc=example,dc=com"]`    |
| `ui`       | object       | Pointer             | UI configuration for pointer selection (future feature)                          | `{}`                                |
| `group`    | string       | All                 | UI grouping for form organization (future feature)                               | `"contact"`                         |
| `default`  | any          | All                 | Default value for new entries                                                    | `["top", "person"]`                 |
| `items`    | object       | Array               | Schema for array element validation                                              | `{"type": "string", "test": "..."}` |

### Property Details

#### `type` (Required)

Defines the data type of the attribute. Supported values:

- `"string"`: Single text value
- `"array"`: Multiple values of the same type
- `"pointer"`: Reference to another LDAP entry (DN)
- `"number"`: Numeric value (integer or float)
- `"integer"`: Integer value only

#### `required` (Optional, default: `false`)

Specifies whether the attribute is mandatory when creating or updating entries.

```json
{
  "uid": {
    "type": "string",
    "required": true
  },
  "description": {
    "type": "string",
    "required": false
  }
}
```

#### `fixed` (Optional, default: `false`)

Marks the attribute as immutable after creation. Useful for objectClass or identifier attributes.

```json
{
  "objectClass": {
    "type": "array",
    "required": true,
    "fixed": true,
    "default": ["top", "inetOrgPerson"]
  }
}
```

#### `role` (Optional)

Assigns semantic meaning to attributes for special handling by the application. See [Semantic Roles](#semantic-roles).

```json
{
  "uid": {
    "type": "string",
    "required": true,
    "role": "identifier"
  },
  "cn": {
    "type": "string",
    "required": true,
    "role": "displayName"
  },
  "mail": {
    "type": "string",
    "role": "primaryEmail"
  }
}
```

#### `test` (Optional)

Regular expression pattern for validating attribute values.

```json
{
  "uid": {
    "type": "string",
    "test": "^[a-zA-Z0-9._-]{1,255}$"
  },
  "mail": {
    "type": "string",
    "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
  }
}
```

**For arrays**, the test applies to each item:

```json
{
  "mailAlternateAddress": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
    }
  }
}
```

#### `branch` (Required for Pointers)

Specifies one or more LDAP base DNs where referenced entries can be found.

```json
{
  "twakeAccountStatus": {
    "type": "pointer",
    "branch": ["ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"]
  }
}
```

Use variable substitution for dynamic bases:

```json
{
  "departmentNumber": {
    "type": "pointer",
    "branch": ["ou=departments,__ldap_base__"]
  }
}
```

#### `default` (Optional)

Provides a default value for new entries. Commonly used with objectClass and fixed attributes.

```json
{
  "objectClass": {
    "type": "array",
    "default": ["top", "inetOrgPerson", "organizationalPerson", "person"],
    "required": true,
    "fixed": true
  }
}
```

#### `items` (Required for Arrays)

Defines the schema for array elements, including type and validation.

```json
{
  "member": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[a-zA-Z]+=.*,dc=example,dc=com$"
    }
  }
}
```

---

## Semantic Roles

Semantic roles assign special meaning to attributes for UI and business logic handling.

### Available Roles

| Role           | Description                        | Example Attribute                        | Usage                                 |
| -------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------- |
| `identifier`   | Primary identifier (RDN attribute) | `uid`, `cn`, `sAMAccountName`            | Used as the entry's unique identifier |
| `displayName`  | Human-readable display name        | `cn`, `displayName`                      | Shown in lists and UI elements        |
| `primaryEmail` | Main email address                 | `mail`, `userPrincipalName`              | Primary contact email                 |
| `emailAliases` | Additional email addresses         | `mailAlternateAddress`, `proxyAddresses` | Alternative email addresses           |
| `emailQuota`   | Email storage quota                | `mailQuota`, `mailQuotaSize`             | Storage limit for mailbox             |

### Role Usage Examples

#### Identifier Role

The `identifier` role marks the attribute used as the RDN (Relative Distinguished Name) component of the entry's DN.

```json
{
  "uid": {
    "type": "string",
    "test": "^[a-zA-Z0-9._-]{1,255}$",
    "required": true,
    "role": "identifier"
  }
}
```

For a user with `uid=jdoe`, the full DN would be `uid=jdoe,ou=users,dc=example,dc=com`.

#### Display Name Role

The `displayName` role indicates which attribute should be shown in UI lists and summaries.

```json
{
  "cn": {
    "type": "string",
    "required": true,
    "role": "displayName"
  }
}
```

#### Email Roles

Email-related roles help applications handle email addresses consistently across different LDAP schemas.

**Primary Email:**

```json
{
  "mail": {
    "type": "string",
    "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    "required": false,
    "role": "primaryEmail"
  }
}
```

**Email Aliases:**

```json
{
  "mailAlternateAddress": {
    "type": "array",
    "items": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
    },
    "required": false,
    "role": "emailAliases"
  }
}
```

**Email Quota:**

```json
{
  "mailQuota": {
    "type": "number",
    "required": false,
    "role": "emailQuota"
  }
}
```

---

## Validation Rules

LDAP-Rest validates LDAP entries against schemas using the following rules:

### Strict Mode

The `strict` property controls validation behavior:

```json
{
  "strict": true,
  "attributes": { ... }
}
```

- **`strict: true`**: Only attributes defined in the schema are allowed
- **`strict: false`** or omitted: Additional attributes are permitted

### Required Attributes

Attributes with `"required": true` must be present in all create and update operations.

```json
{
  "uid": {
    "type": "string",
    "required": true
  }
}
```

### Pattern Validation

The `test` property enforces regular expression validation:

```json
{
  "uid": {
    "type": "string",
    "test": "^[a-zA-Z0-9._-]{1,255}$"
  }
}
```

Common validation patterns:

**Username/UID:**

```regex
^[a-zA-Z0-9._-]{1,255}$
```

**Email:**

```regex
^[^@\s]+@[^@\s]+\.[^@\s]+$
```

**DN (Distinguished Name):**

```regex
^[a-zA-Z]+=.*,dc=example,dc=com$
```

**ObjectClass name:**

```regex
^[a-zA-Z][a-zA-Z0-9-]*$
```

### Type Validation

Attribute values must match their declared type:

- **String**: Single text value
- **Array**: Multiple values (may be empty unless required)
- **Number**: Numeric value (integer or float)
- **Integer**: Integer value only
- **Pointer**: Valid DN string

### Fixed Attributes

Attributes with `"fixed": true` cannot be modified after creation.

```json
{
  "objectClass": {
    "type": "array",
    "fixed": true,
    "default": ["top", "inetOrgPerson"]
  }
}
```

---

## Predefined Schemas

LDAP-Rest includes three sets of predefined schemas for common LDAP directory types.

### Schema Structure Overview

```
static/schemas/
├── twake/              # Twake Mail schemas
│   ├── users.json
│   ├── groups.json
│   ├── organizations.json
│   ├── positions.json
│   └── nomenclature/
│       ├── twakeAccountStatus.json
│       ├── twakeDeliveryMode.json
│       ├── twakeListType.json
│       └── twakeTitle.json
├── ad/                 # Active Directory schemas
│   ├── users.json
│   ├── groups.json
│   └── organizations.json
└── standard/           # Standard LDAP schemas
    ├── users.json
    ├── groups.json
    └── organizations.json
```

---

### Twake Schemas

Schemas for Twake Mail directories with extended attributes for collaboration and messaging.

#### Twake Schema Tree

```
twake/
├── users.json                      # Twake user accounts
│   ├── Entity: twakeUser
│   ├── ObjectClasses: top, twakeAccount, twakeWhitePages
│   ├── Main Attribute: uid
│   └── Special Attributes:
│       ├── twakeAccountStatus (pointer to nomenclature)
│       ├── twakeDeliveryMode (pointer to nomenclature)
│       ├── twakeDelegatedUsers (pointer array)
│       ├── twakeDepartmentLink (DN reference)
│       └── twakeDepartmentPath (organizational path)
│
├── groups.json                     # Twake groups
│   ├── Entity: twakeGroup
│   ├── ObjectClasses: top, groupOfNames, twakeStaticGroup
│   ├── Main Attribute: cn
│   └── Special Attributes:
│       ├── twakeDepartmentLink
│       └── twakeDepartmentPath
│
├── organizations.json              # Twake departments/OUs
│   ├── Entity: (organization schema)
│   ├── ObjectClasses: top, organizationalUnit, twakeDepartment
│   ├── Main Attribute: ou
│   └── Special Attributes:
│       ├── twakeDepartmentPath
│       └── twakeLocalAdminLink (array)
│
├── positions.json                  # Job positions
│   ├── Entity: twakePosition
│   ├── ObjectClasses: top, twakePosition
│   └── Main Attribute: cn
│
└── nomenclature/                   # Controlled vocabularies
    ├── twakeAccountStatus.json     # Account status values
    ├── twakeDeliveryMode.json      # Email delivery modes
    ├── twakeListType.json          # Mailing list types
    └── twakeTitle.json             # Job titles
```

**Usage:**

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./static/schemas/twake/users.json \
  --plugin core/ldap/groups \
  --ldap-groups-schema ./static/schemas/twake/groups.json \
  --plugin core/ldap/organization \
  --ldap-org-schema ./static/schemas/twake/organizations.json
```

---

### Active Directory Schemas

Schemas for Microsoft Active Directory with Windows-specific attributes.

#### Active Directory Schema Tree

```
ad/
├── users.json                      # AD user accounts
│   ├── Entity: adUser
│   ├── ObjectClasses: top, person, organizationalPerson, user
│   ├── Main Attribute: sAMAccountName
│   └── Special Attributes:
│       ├── sAMAccountName (Windows logon name, max 20 chars)
│       ├── userPrincipalName (UPN format)
│       ├── proxyAddresses (SMTP email aliases)
│       ├── userAccountControl (account flags)
│       ├── unicodePwd (password attribute)
│       ├── accountExpires (expiration timestamp)
│       ├── pwdLastSet (password change timestamp)
│       └── manager (DN reference)
│
├── groups.json                     # AD security/distribution groups
│   ├── Entity: (AD group schema)
│   ├── ObjectClasses: top, group
│   ├── Main Attribute: cn
│   └── Special Attributes:
│       ├── sAMAccountName (group name, max 256 chars)
│       ├── groupType (security/distribution flags)
│       ├── managedBy (DN reference)
│       └── member (DN array, CN-based)
│
└── organizations.json              # AD organizational units
    ├── Entity: (AD OU schema)
    ├── ObjectClasses: top, organizationalUnit
    └── Main Attribute: ou
```

**Key Differences from Standard LDAP:**

- Uses `sAMAccountName` instead of `uid` for user identification
- Uses `CN=` based DNs instead of `uid=` or `ou=`
- Includes Windows-specific attributes (userAccountControl, unicodePwd)
- ProxyAddresses use `SMTP:` or `smtp:` prefixes
- Maximum 20 characters for user sAMAccountName
- Maximum 256 characters for group sAMAccountName

**Usage:**

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./static/schemas/ad/users.json \
  --plugin core/ldap/groups \
  --ldap-groups-schema ./static/schemas/ad/groups.json
```

---

### Standard LDAP Schemas

Schemas for standard LDAP directories using inetOrgPerson and organizationalUnit.

#### Standard LDAP Schema Tree

```
standard/
├── users.json                      # Standard LDAP users
│   ├── Entity: standardUser
│   ├── ObjectClasses: top, inetOrgPerson, organizationalPerson, person
│   ├── Main Attribute: uid
│   └── Attributes:
│       ├── uid (identifier)
│       ├── cn (common name, displayName role)
│       ├── sn (surname, required)
│       ├── mail (primary email)
│       ├── mailAlternateAddress (email aliases)
│       ├── mailQuota (email quota)
│       ├── givenName
│       ├── displayName
│       ├── telephoneNumber
│       ├── mobile
│       ├── userPassword
│       ├── departmentNumber (DN reference)
│       └── ou (organizational unit)
│
├── groups.json                     # Standard LDAP groups
│   ├── Entity: (standard group schema)
│   ├── ObjectClasses: top, groupOfNames
│   ├── Main Attribute: cn
│   └── Attributes:
│       ├── cn (group name)
│       ├── description
│       ├── mail (group email)
│       ├── member (DN array)
│       ├── owner (DN array)
│       ├── businessCategory (DN reference)
│       └── ou
│
└── organizations.json              # Standard LDAP OUs
    ├── Entity: (standard OU schema)
    ├── ObjectClasses: top, organizationalUnit
    ├── Main Attribute: ou
    └── Attributes:
        ├── ou (organizational unit name)
        ├── description
        ├── telephoneNumber
        ├── facsimileTelephoneNumber
        ├── l (locality)
        ├── postalAddress
        ├── businessCategory (DN reference)
        └── seeAlso
```

**Usage:**

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./static/schemas/standard/users.json \
  --plugin core/ldap/groups \
  --ldap-groups-schema ./static/schemas/standard/groups.json \
  --plugin core/ldap/organization \
  --ldap-org-schema ./static/schemas/standard/organizations.json
```

---

## Schema Comparison

### User Schemas Comparison

| Feature           | Twake                             | Active Directory                   | Standard LDAP            |
| ----------------- | --------------------------------- | ---------------------------------- | ------------------------ |
| Main Attribute    | `uid`                             | `sAMAccountName`                   | `uid`                    |
| Display Name Role | `cn`                              | `cn`                               | `cn`                     |
| ObjectClasses     | twakeAccount, twakeWhitePages     | user, person                       | inetOrgPerson, person    |
| Primary Email     | `mail`                            | `mail`                             | `mail`                   |
| Email Aliases     | `mailAlternateAddress`            | `proxyAddresses`                   | `mailAlternateAddress`   |
| Department Link   | `twakeDepartmentLink` (DN)        | `manager` (DN)                     | `departmentNumber` (DN)  |
| Special Features  | Nomenclature pointers, delegation | AD-specific (UPN, account control) | Standard attributes only |

### Group Schemas Comparison

| Feature          | Twake                          | Active Directory          | Standard LDAP       |
| ---------------- | ------------------------------ | ------------------------- | ------------------- |
| Main Attribute   | `cn`                           | `cn`                      | `cn`                |
| ObjectClasses    | groupOfNames, twakeStaticGroup | group                     | groupOfNames        |
| Member Attribute | `member` (DN array)            | `member` (DN array)       | `member` (DN array) |
| Owner Attribute  | `owner` (DN array)             | `managedBy` (single DN)   | `owner` (DN array)  |
| Special Features | Department links               | groupType, sAMAccountName | Business category   |

---

## Creating Custom Schemas

To create a custom schema for your specific LDAP directory:

### Step 1: Choose a Base Schema

Start with the schema that most closely matches your directory type:

- **Twake**: For Twake Mail or similar collaborative directories
- **Active Directory**: For Microsoft AD
- **Standard LDAP**: For OpenLDAP, 389 Directory Server, etc.

### Step 2: Define Entity Metadata

```json
{
  "entity": {
    "name": "customUser",
    "mainAttribute": "uid",
    "objectClass": ["top", "inetOrgPerson", "customPerson"],
    "singularName": "user",
    "pluralName": "users",
    "base": "ou=users,{ldap_base}",
    "defaultAttributes": {
      "cn": "New User",
      "sn": "User"
    }
  }
}
```

### Step 3: Define Required Attributes

```json
{
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "default": ["top", "inetOrgPerson", "customPerson"],
      "required": true,
      "fixed": true
    },
    "uid": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]{1,255}$",
      "required": true,
      "role": "identifier"
    },
    "cn": {
      "type": "string",
      "required": true,
      "role": "displayName"
    },
    "sn": {
      "type": "string",
      "required": true
    }
  }
}
```

### Step 4: Add Optional Attributes

```json
{
  "attributes": {
    "mail": {
      "type": "string",
      "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      "required": false,
      "role": "primaryEmail"
    },
    "telephoneNumber": {
      "type": "string",
      "required": false
    },
    "customAttribute": {
      "type": "string",
      "required": false
    }
  }
}
```

### Step 5: Add Pointer Attributes (if needed)

```json
{
  "attributes": {
    "customStatus": {
      "type": "pointer",
      "branch": ["ou=status,ou=nomenclature,{ldap_base}"],
      "required": true
    }
  }
}
```

### Step 6: Test and Deploy

Save your schema and reference it when starting LDAP-Rest:

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./path/to/custom-users.json
```

---

## Best Practices

### 1. Always Define ObjectClass

Include objectClass with fixed default values:

```json
{
  "objectClass": {
    "type": "array",
    "items": {
      "type": "string"
    },
    "default": ["top", "inetOrgPerson"],
    "required": true,
    "fixed": true
  }
}
```

### 2. Use Semantic Roles

Assign roles to key attributes for proper handling:

```json
{
  "uid": {
    "type": "string",
    "role": "identifier"
  },
  "cn": {
    "type": "string",
    "role": "displayName"
  },
  "mail": {
    "type": "string",
    "role": "primaryEmail"
  }
}
```

### 3. Validate with Regular Expressions

Use `test` patterns to enforce data quality:

```json
{
  "uid": {
    "type": "string",
    "test": "^[a-zA-Z0-9._-]{1,255}$"
  },
  "mail": {
    "type": "string",
    "test": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
  }
}
```

### 4. Use Variable Substitution

Reference the LDAP base dynamically:

```json
{
  "entity": {
    "base": "ou=users,{ldap_base}"
  },
  "attributes": {
    "departmentNumber": {
      "type": "string",
      "test": "^.*,__ldap_base__$"
    }
  }
}
```

### 5. Enable Strict Mode

Prevent unwanted attributes:

```json
{
  "strict": true
}
```

### 6. Document Custom Attributes

Add comments in your schema documentation (not in JSON) explaining custom attributes and their purpose.

---

## Troubleshooting

### Schema Not Loading

**Problem**: Schema file not found or fails to parse.

**Solution**:

- Verify the file path is correct
- Check JSON syntax with a validator
- Review server logs for detailed error messages

```bash
npx ldap-rest --log-level debug ...
```

### Validation Errors

**Problem**: Entries fail validation when creating or updating.

**Solution**:

- Check that required attributes are provided
- Verify attribute values match `test` patterns
- Ensure DN pointers reference valid entries
- Check that array items match their item schema

### Pointer Attributes Not Working

**Problem**: Pointer attributes don't reference entries correctly.

**Solution**:

- Verify the `branch` DN is correct
- Ensure referenced entries exist in LDAP
- Check that DN format matches the `test` pattern
- Use variable substitution for dynamic bases

### Attribute Not Appearing in API

**Problem**: Custom attribute doesn't appear in API responses.

**Solution**:

- Verify the attribute is in the schema
- Check that `strict` mode isn't preventing it
- Ensure the attribute exists in LDAP entries
- Request it explicitly with the `attributes` query parameter

---

## Additional Resources

- **[REST API Documentation](../api/REST_API.md)** - Using schemas with the API
- **[Browser Libraries](../browser/LIBRARIES.md)** - Schema-driven UI components
- **[Plugin Development](../plugins/DEVELOPMENT.md)** - Creating schema-aware plugins
- **[Integration Examples](../examples/EXAMPLES.md)** - Working with schemas in applications

---

## License

AGPL-3.0 - Copyright 2025-present LINAGORA
