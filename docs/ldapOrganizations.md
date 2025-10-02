# LDAP Organizations Plugin

The `ldapOrganizations` plugin provides comprehensive management of hierarchical LDAP organizational structures, with automatic validation of organizational links and paths.

## Overview

This plugin manages hierarchical organizations stored as `organizationalUnit` (ou) entries in LDAP. Unlike flat entities managed by the ldapFlat plugin, organizations form a tree structure where each organization can contain sub-organizations. It provides:

- Organization CRUD operations (Create, Read, Update, Delete)
- Hierarchical tree navigation
- Automatic validation of organizational links (for users/groups)
- Automatic validation of organizational paths
- Protection against deleting non-empty organizations
- Hook integration for lifecycle events

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/organization \
--ldap-top-organization "dc=example,dc=com" \
--ldap-organization-class top,organizationalUnit,twakeDepartment \
--ldap-organization-link-attribute twakeDepartmentLink \
--ldap-organization-path-attribute twakeDepartmentPath \
--ldap-organization-path-separator " / "
```

### Configuration Options

| Argument                                                    | Environment Variable                  | Default                         | Description                                         |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------- | --------------------------------------------------- |
| `--ldap-top-organization`                                   | `DM_LDAP_TOP_ORGANIZATION`            | _Required_                      | DN of the top-level organization                    |
| `--ldap-organization-class` / `--ldap-organization-classes` | `DM_LDAP_ORGANIZATION_CLASSES`        | `["top", "organizationalUnit"]` | Object classes for organizations                    |
| `--ldap-organization-link-attribute`                        | `DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE` | `twakeDepartmentLink`           | Attribute for linking users/groups to organizations |
| `--ldap-organization-path-attribute`                        | `DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE` | `twakeDepartmentPath`           | Attribute for the organizational path               |
| `--ldap-organization-path-separator`                        | `DM_LDAP_ORGANIZATION_PATH_SEPARATOR` | `" / "`                         | Separator for path components                       |

### Important Notes

- **Hierarchical Structure**: Organizations are organized hierarchically using LDAP's DN structure (e.g., `ou=SubDept,ou=Dept,dc=example,dc=com`)
- **Top Organization Required**: You must specify a top-level organization DN
- **Link vs Hierarchy**: Organizations themselves use LDAP hierarchy (DN), not the link attribute. The link attribute is used by users/groups to reference their parent organization
- **Path Validation**: Organizational paths are validated to ensure they match the actual LDAP hierarchy

## Organizational Structure

### Organizations

Organizations are hierarchical LDAP entries:

- Use LDAP DN structure for hierarchy
- Have a `twakeDepartmentPath` attribute showing their position in the tree
- Example: `ou=IT,ou=Departments,dc=example,dc=com`
  - Path: `IT / Departments / Top Organization`

### Users and Groups

Users and groups reference organizations via:

- `twakeDepartmentLink`: DN of the parent organization (required)
- `twakeDepartmentPath`: Human-readable path (required)
- Example user:
  ```json
  {
    "uid": "john.doe",
    "twakeDepartmentLink": "ou=IT,ou=Departments,dc=example,dc=com",
    "twakeDepartmentPath": "IT / Departments / Top Organization"
  }
  ```

## REST API

### Get Top Organization

```http
GET /api/v1/ldap/organizations/top
```

Returns the top-level organization configured in `--ldap-top-organization`.

**Example:**

```bash
curl "http://localhost:8081/api/v1/ldap/organizations/top"
```

**Response (200):**

```json
{
  "dn": "dc=example,dc=com",
  "o": "gov",
  "description": "Government Organization"
}
```

### Get Organization by DN

```http
GET /api/v1/ldap/organizations/:dn
```

**Path Parameter:**

- `dn`: Organization DN (URL-encoded)

**Example:**

```bash
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu"
```

**Response (200):**

```json
{
  "dn": "ou=IT,dc=example,dc=com",
  "ou": "IT",
  "description": "Information Technology Department",
  "twakeDepartmentPath": "IT / Government"
}
```

### Get Organization Subnodes

```http
GET /api/v1/ldap/organizations/:dn/subnodes
```

Returns all entries (users, groups, or sub-organizations) that reference this organization via their `twakeDepartmentLink` attribute.

**Path Parameter:**

- `dn`: Organization DN (URL-encoded)

**Example:**

```bash
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes"
```

**Response (200):**

```json
[
  {
    "dn": "uid=john.doe,ou=users,dc=example,dc=com",
    "uid": "john.doe",
    "cn": "John Doe",
    "twakeDepartmentLink": "ou=IT,dc=example,dc=com"
  },
  {
    "dn": "cn=it-admins,ou=groups,dc=example,dc=com",
    "cn": "it-admins",
    "twakeDepartmentLink": "ou=IT,dc=example,dc=com"
  }
]
```

### Create Organization

```http
POST /api/v1/ldap/organizations
```

**Request Body:**

```json
{
  "ou": "IT",
  "parentDn": "dc=example,dc=com",
  "description": "Information Technology Department",
  "twakeDepartmentPath": "IT / Government"
}
```

**Notes:**

- `ou` is required (organizational unit name)
- `parentDn` is optional (defaults to top organization)
- Organizations are created under the specified parent DN
- The resulting DN will be `ou={ou},{parentDn}`

**Response (200):**

```json
{
  "success": true
}
```

### Modify Organization

```http
PUT /api/v1/ldap/organizations/:dn
```

**Path Parameter:**

- `dn`: Organization DN (URL-encoded)

**Request Body:**

```json
{
  "replace": {
    "description": "Updated IT Department"
  },
  "add": {
    "telephoneNumber": "+1234567890"
  },
  "delete": ["l"]
}
```

**Important:**

- Cannot delete `twakeDepartmentPath` attribute
- Path modifications are validated against LDAP hierarchy
- Cannot modify `ou` attribute (this would require a rename operation)

**Response (200):**

```json
{
  "success": true
}
```

### Delete Organization

```http
DELETE /api/v1/ldap/organizations/:dn
```

**Path Parameter:**

- `dn`: Organization DN (URL-encoded)

**Notes:**

- Organization must be empty (no users, groups, or sub-organizations linked to it)
- Validation happens via hooks before deletion

**Response (200):**

```json
{
  "success": true
}
```

**Error (500) - Non-empty:**

```json
{
  "error": "Organization ou=IT,dc=example,dc=com is not empty"
}
```

## Validation Rules

The plugin enforces several validation rules through hooks:

### For Organizations

1. **Path Validation**: The `twakeDepartmentPath` must:
   - Start with the organization's own `ou` name
   - Be followed by the path separator
   - Reference an existing parent organization in the hierarchy
   - Match the actual LDAP DN structure

2. **Deletion Protection**: Organizations can only be deleted if:
   - No users have `twakeDepartmentLink` pointing to it
   - No groups have `twakeDepartmentLink` pointing to it
   - No sub-organizations exist under it

3. **Path Immutability**: The `twakeDepartmentPath` attribute cannot be deleted

### For Users and Groups

1. **Link Validation**: The `twakeDepartmentLink` must:
   - Point to an existing organization DN
   - Be within the top organization branch
   - Not be deleted (link is mandatory)

2. **Path Validation**: The `twakeDepartmentPath` must:
   - Match an existing organizational hierarchy
   - Not be deleted (path is mandatory)

## Hooks

The plugin emits and listens to lifecycle hooks:

### Listened Hooks

- `ldapaddrequest` - Validates organization link and path before creating any entry
- `ldapmodifyrequest` - Validates organization link and path modifications
- `ldapdeleterequest` - Ensures organizations are empty before deletion
- `ldaprenamerequest` - Passes through rename requests

**Hook Behavior:**

```javascript
// Before adding a user
hooks: {
  ldapaddrequest: async ([dn, entry]) => {
    // If entry is a user/group (not an organization),
    // validate twakeDepartmentLink points to existing org
    if (!isOrganization(entry)) {
      await checkDeptLink(entry); // Validates link exists
    }
    // If entry is an organization, validate path
    if (isOrganization(entry)) {
      await checkDeptPath(entry); // Validates path matches hierarchy
    }
    return [dn, entry];
  };
}
```

## Examples

### Example 1: Create Top-Level Department

```bash
curl -X POST http://localhost:8081/api/v1/ldap/organizations \
  -H "Content-Type: application/json" \
  -d '{
    "ou": "HR",
    "description": "Human Resources Department",
    "twakeDepartmentPath": "HR / Government"
  }'
```

This creates: `ou=HR,dc=example,dc=com`

### Example 2: Create Sub-Department

```bash
curl -X POST http://localhost:8081/api/v1/ldap/organizations \
  -H "Content-Type: application/json" \
  -d '{
    "ou": "Recruitment",
    "parentDn": "ou=HR,dc=example,dc=com",
    "description": "Recruitment Team",
    "twakeDepartmentPath": "Recruitment / HR / Government"
  }'
```

This creates: `ou=Recruitment,ou=HR,dc=example,dc=com`

### Example 3: Get Organization Hierarchy

```bash
# Get top organization
curl "http://localhost:8081/api/v1/ldap/organizations/top"

# Get specific organization
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu"

# Get all users/groups in HR department
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu/subnodes"
```

### Example 4: Update Organization Description

```bash
curl -X PUT "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu" \
  -H "Content-Type: application/json" \
  -d '{
    "replace": {
      "description": "Human Resources & Administration"
    }
  }'
```

### Example 5: Delete Empty Organization

```bash
# First verify organization is empty
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DHR%2Co%3Dgov%2Cc%3Dmu/subnodes"

# If empty, delete it
curl -X DELETE "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DHR%2Co%3Dgov%2Cc%3Dmu"
```

## Integration with Other Plugins

### With Users Plugin (via ldapFlat)

When a user is created with organization attributes:

```bash
curl -X POST http://localhost:8081/api/v1/ldap/users \
  -H "Content-Type: application/json" \
  -d '{
    "uid": "john.doe",
    "cn": "John Doe",
    "sn": "Doe",
    "mail": "john.doe@example.com",
    "twakeDepartmentLink": "ou=IT,dc=example,dc=com",
    "twakeDepartmentPath": "IT / Government"
  }'
```

The organizations plugin automatically validates:

- `twakeDepartmentLink` points to existing `ou=IT,dc=example,dc=com`
- `twakeDepartmentPath` matches the organizational hierarchy

### With Groups Plugin

Same validation applies when creating groups:

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups \
  -H "Content-Type: application/json" \
  -d '{
    "cn": "it-admins",
    "description": "IT Administrators",
    "twakeDepartmentLink": "ou=IT,dc=example,dc=com",
    "twakeDepartmentPath": "IT / Government",
    "member": ["uid=john.doe,ou=users,dc=example,dc=com"]
  }'
```

### Organizational Cleanup

When deleting an organization, the plugin ensures it's empty:

```bash
# This will fail if any users/groups reference the organization
DELETE /api/v1/ldap/organizations/ou=IT,dc=example,dc=com
# Error: Organization ou=IT,dc=example,dc=com is not empty
```

You must first:

1. Move or delete all users with `twakeDepartmentLink` to this org
2. Move or delete all groups with `twakeDepartmentLink` to this org
3. Delete all sub-organizations

## Path Validation Details

### Path Format

The path attribute follows this pattern:

```
{current_ou} / {parent_ou} / {grandparent_ou} / ... / {top_org}
```

### Validation Process

1. **Extract Components**: Split path by separator
2. **Verify First Component**: Must match organization's own `ou`
3. **Validate Parent Path**: Search for parent organization with matching path
4. **Verify Hierarchy**: Ensure path matches actual LDAP DN structure

### Example Path Validation

For organization: `ou=Recruitment,ou=HR,dc=example,dc=com`

Valid path: `Recruitment / HR / Government`

- `Recruitment` matches current ou
- `HR / Government` must exist as path of `ou=HR,dc=example,dc=com`

Invalid path: `Recruitment / IT / Government`

- `IT / Government` doesn't match parent's actual path

## Troubleshooting

### Invalid Organization Link

**Problem:** `Organization ou=IT,dc=example,dc=com does not exist`

**Solution:** Ensure the organization exists before creating users/groups that reference it:

```bash
# Create organization first
curl -X POST http://localhost:8081/api/v1/ldap/organizations \
  -H "Content-Type: application/json" \
  -d '{"ou": "IT", "twakeDepartmentPath": "IT / Government"}'

# Then create user with link
curl -X POST http://localhost:8081/api/v1/ldap/users \
  -d '{"uid": "user", "twakeDepartmentLink": "ou=IT,dc=example,dc=com", ...}'
```

### Invalid Organization Path

**Problem:** `Invalid organization path: IT / Recruitment / Government`

**Solutions:**

1. Ensure parent path exists and matches LDAP hierarchy
2. Verify separator matches configured separator (default: `" / "`)
3. Check that path starts with organization's own `ou` name

### Cannot Delete Organization

**Problem:** `Organization ou=IT,dc=example,dc=com is not empty`

**Solutions:**

1. List subnodes to see what's linked:
   ```bash
   curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes"
   ```
2. Remove or reassign all users/groups referencing this organization
3. Delete all sub-organizations first (bottom-up approach)

### Cannot Delete Path Attribute

**Problem:** `An organization path cannot be deleted`

**Solution:** The path attribute is required and cannot be deleted. To change it, use `replace` instead:

```bash
curl -X PUT "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu" \
  -d '{
    "replace": {
      "twakeDepartmentPath": "IT / NewParent / Government"
    }
  }'
```

## Schema Support

The plugin validates organizations against configured object classes. Example schema:

```json
{
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "default": ["top", "organizationalUnit", "twakeDepartment"],
      "required": true
    },
    "ou": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]{1,255}$",
      "required": true
    },
    "twakeDepartmentPath": {
      "type": "string",
      "test": "^[\\w\\s/,]+$",
      "required": true
    },
    "description": {
      "type": "string",
      "required": false
    }
  }
}
```

## See Also

- [LDAP Flat Plugin](./ldapFlat.md) - For managing flat LDAP entities (users, positions, nomenclature) through schema-driven approach
- [LDAP Groups Plugin](./ldapGroups.md) - For managing groups with members, automatic validation and cleanup
- [Schema Examples](../static/schemas/) - Organization schema examples for Twake, Standard, and Active Directory
