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
- The path reads from the root down, the entry's own name last, and stops
  below the top organization: a top-level organization's path is its own name
- Example: `ou=IT,ou=Departments,ou=organization,dc=example,dc=com`
  - Path: `Departments / IT`

### Users and Groups

Users and groups reference organizations via:

- `twakeDepartmentLink`: DN of the parent organization (required)
- `twakeDepartmentPath`: Human-readable path (required)
- Example user:
  ```json
  {
    "uid": "john.doe",
    "twakeDepartmentLink": "ou=IT,ou=Departments,ou=organization,dc=example,dc=com",
    "twakeDepartmentPath": "Departments / IT"
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
  "twakeDepartmentPath": "Government / IT"
}
```

### Get Organization Subnodes

```http
GET /api/v1/ldap/organizations/:dn/subnodes?objectClass={class}
```

Returns all entries (users, groups, or sub-organizations) that reference this organization via their `twakeDepartmentLink` attribute. Results are automatically paginated to handle large numbers of entries.

**Path Parameter:**

- `dn`: Organization DN (URL-encoded)

**Query Parameters:**

- `objectClass` (optional): Filter results by LDAP objectClass (e.g., `twakeAccount`, `groupOfNames`, `organizationalUnit`)

**Examples:**

```bash
# Get all subnodes (users, groups, and sub-OUs)
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes"

# Get only users
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes?objectClass=twakeAccount"

# Get only groups
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes?objectClass=groupOfNames"

# Get only sub-organizations
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DIT%2Co%3Dgov%2Cc%3Dmu/subnodes?objectClass=organizationalUnit"
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
  "twakeDepartmentPath": "Government / IT"
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

### Move Organization

```http
POST /api/v1/ldap/organizations/:dn/move
```

**Path Parameter:**

- `dn`: Organization DN to move (URL-encoded)

**Request Body:**

```json
{
  "targetOrgDn": "ou=NewParent,dc=example,dc=com"
}
```

**Notes:**

- Moves an organization to a different parent organization
- The organization will become a child of the target organization
- All sub-organizations and linked entities (users/groups) move with it
- Cannot move an organization into itself or its own descendants (circular reference prevention)
- Cannot move to the same parent (no-op)
- Target must be a valid organizational unit

**Authorization:**

When using the `authzPerBranch` plugin, moving an organization requires:

- **Read** permission on the source organization (current parent)
- **Write** permission on the destination organization (new parent)

**Example:**

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DHR%2Co%3Dgov%2Cc%3Dmu/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetOrgDn": "ou=Operations,dc=example,dc=com"
  }'
```

This moves `ou=Recruitment,ou=HR,dc=example,dc=com` to `ou=Recruitment,ou=Operations,dc=example,dc=com`

**Response (200):**

```json
{
  "newDn": "ou=Recruitment,ou=Operations,dc=example,dc=com"
}
```

**Error Examples:**

- **Circular move (500):** `Cannot move organization into itself or its descendant`
- **Invalid target (500):** `Target ou=InvalidOU,dc=example,dc=com is not an organizational unit`
- **Same location (500):** `Organization is already in the target location`

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
   - End with the organization's own `ou` name, preceded by the path separator
   - Be preceded by the stored path of an existing organization
   - Be its own name alone only when the entry hangs directly from the top
     organization, which its DN has to say
   - A path written the other way round, the entry's own name first and the
     top organization's name last, is accepted as it stands: it is what
     directories written before this convention hold. The server never
     computes one.

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
    // If entry is an organization, validate path against the DN it is
    // written at: that is what says where the entry hangs from
    if (isOrganization(entry)) {
      await checkDeptPath(entry, dn); // Validates path matches hierarchy
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
    "parentDn": "ou=HR,ou=organization,dc=example,dc=com",
    "description": "Recruitment Team"
  }'
# `twakeDepartmentPath` is computed by the server: `HR / Recruitment`
```

This creates: `ou=Recruitment,ou=HR,ou=organization,dc=example,dc=com`

### Example 3: Get Organization Hierarchy

```bash
# Get top organization
curl "http://localhost:8081/api/v1/ldap/organizations/top"

# Get specific organization
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu"

# Get all users/groups/sub-OUs in HR department
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu/subnodes"

# Get only users in HR department
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DHR%2Co%3Dgov%2Cc%3Dmu/subnodes?objectClass=twakeAccount"
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

### Example 5: Move Organization to Different Parent

```bash
# Move Recruitment from HR to Operations department
curl -X POST "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DHR%2Co%3Dgov%2Cc%3Dmu/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetOrgDn": "ou=Operations,dc=example,dc=com"
  }'
```

This changes the DN from `ou=Recruitment,ou=HR,dc=example,dc=com` to `ou=Recruitment,ou=Operations,dc=example,dc=com`.

All users, groups, and sub-organizations linked to Recruitment will automatically move with it.

### Example 6: Delete Empty Organization

```bash
# First verify organization is empty
curl "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DOperations%2Co%3Dgov%2Cc%3Dmu/subnodes"

# If empty, delete it
curl -X DELETE "http://localhost:8081/api/v1/ldap/organizations/ou%3DRecruitment%2Cou%3DOperations%2Co%3Dgov%2Cc%3Dmu"
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
    "twakeDepartmentPath": "Government / IT"
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
    "twakeDepartmentPath": "Government / IT",
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

The path attribute follows this pattern, the top organization excluded:

```
{parent_of_parent_ou} / {parent_ou} / {current_ou}
```

### Validation Process

1. **Verify Last Component**: Must match the organization's own `ou`
2. **Validate Parent Path**: What precedes it must be the stored path of an
   existing organization
3. **Verify Hierarchy**: An organization whose path is its own name alone must
   hang directly from the top organization
4. **Accept The Old Form**: A path reading the other way round, ending in the
   top organization's own name, is left alone — the directories that hold
   them predate this convention and their entries have to stay writable

### Example Path Validation

For organization: `ou=Recruitment,ou=HR,ou=organization,dc=example,dc=com`

Valid path: `HR / Recruitment`

- it ends with `Recruitment`, the entry's own `ou`
- what precedes it, `HR`, must be the stored path of an existing organization

Invalid path: `IT / Recruitment`

- no organization holds the path `IT`

Invalid path: `Recruitment / HR`

- it ends with `HR`, not with the entry's own name

Invalid path: `Recruitment`

- it names no parent, and the entry does not hang from the top organization

Accepted path: `Recruitment / HR / organization`

- the old form, the top organization last: read, not written

## Troubleshooting

### Invalid Organization Link

**Problem:** `Organization ou=IT,dc=example,dc=com does not exist`

**Solution:** Ensure the organization exists before creating users/groups that reference it:

```bash
# Create organization first
curl -X POST http://localhost:8081/api/v1/ldap/organizations \
  -H "Content-Type: application/json" \
  -d '{"ou": "IT"}'  # the path is computed by the server

# Then create user with link
curl -X POST http://localhost:8081/api/v1/ldap/users \
  -d '{"uid": "user", "twakeDepartmentLink": "ou=IT,dc=example,dc=com", ...}'
```

### Invalid Organization Path

**Problem:** `Invalid organization path: IT / Recruitment / Government`

**Solutions:**

1. Ensure parent path exists and matches LDAP hierarchy
2. Verify separator matches configured separator (default: `" / "`)
3. Check that the path ends with the organization's own `ou` name

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
