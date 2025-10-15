# LDAP Groups Plugin

The `ldapGroups` plugin provides comprehensive management of LDAP groups and their members, with automatic member validation and cleanup when users are deleted.

## Overview

This plugin manages groups stored as `groupOfNames` or similar object classes in a flat LDAP branch. It provides:

- Group CRUD operations (Create, Read, Update, Delete)
- Member management (add/remove members)
- Automatic member validation (ensures members exist)
- Automatic cleanup (removes deleted users from all groups)
- Schema validation support
- Hook integration for lifecycle events

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/groups \
--ldap-group-base "ou=groups,dc=example,dc=com" \
--ldap-groups-main-attribute cn \
--group-class top,groupOfNames \
--group-schema ./static/schemas/twake/groups.json \
--group-dummy-user "cn=fakeuser" \
--groups-allow-unexistent-members false
```

### Configuration Options

| Argument                            | Environment Variable            | Default                              | Description                      |
| ----------------------------------- | ------------------------------- | ------------------------------------ | -------------------------------- |
| `--ldap-group-base`                 | `DM_LDAP_GROUP_BASE`            | `{ldap_base}`                        | Base DN for groups branch        |
| `--ldap-groups-main-attribute`      | `DM_LDAP_GROUPS_MAIN_ATTRIBUTE` | `cn`                                 | Main attribute (RDN) for groups  |
| `--group-class` / `--group-classes` | `DM_GROUP_CLASSES`              | `["top", "groupOfNames"]`            | Object classes for groups        |
| `--group-schema`                    | `DM_GROUP_SCHEMA`               | `./static/schemas/twake/groups.json` | Path to JSON schema              |
| `--group-default-attributes`        | `DM_GROUP_DEFAULT_ATTRIBUTES`   | `{}`                                 | Default attributes (JSON)        |
| `--group-dummy-user`                | `DM_GROUP_DUMMY_USER`           | `cn=fakeuser`                        | Dummy member DN for empty groups |
| `--groups-allow-unexistent-members` | `DM_ALLOW_UNEXISTENT_MEMBERS`   | `false`                              | Allow non-existent members       |

### Important Notes

- **Empty Groups**: `groupOfNames` requires at least one member. The plugin uses a dummy member (configurable via `--group-dummy-user`) for empty groups.
- **Member Validation**: By default, the plugin validates that all members exist in LDAP before adding them. Set `--groups-allow-unexistent-members true` to disable validation.
- **Automatic Cleanup**: When a user is deleted, the plugin automatically removes them from all groups via the `ldapdeleterequest` hook.

## REST API

### List Groups

```http
GET /api/v1/ldap/groups
```

**Query Parameters:**

- `match` (optional): Filter by group name (supports wildcards and LDAP filters)
- `attributes` (optional): Comma-separated list of attributes to return

**Example:**

```bash
curl "http://localhost:8081/api/v1/ldap/groups?match=admin*&attributes=cn,member,description"
```

**Response (200):**

```json
{
  "admins": {
    "dn": "cn=admins,ou=groups,dc=example,dc=com",
    "cn": "admins",
    "member": [
      "uid=john.doe,ou=users,dc=example,dc=com",
      "uid=jane.smith,ou=users,dc=example,dc=com"
    ],
    "description": "System administrators"
  },
  "admin-backup": {
    "dn": "cn=admin-backup,ou=groups,dc=example,dc=com",
    "cn": "admin-backup",
    "member": ["uid=backup.admin,ou=users,dc=example,dc=com"]
  }
}
```

### Get Group by cn or DN

```http
GET /api/v1/ldap/groups/{cn}
```

**Path Parameter:**

- `cn`: Group cn value (e.g., `developers`) OR full DN (URL-encoded if DN)

**Examples:**

```bash
# Get by cn
curl "http://localhost:8081/api/v1/ldap/groups/developers"

# Get by full DN (URL-encoded)
curl "http://localhost:8081/api/v1/ldap/groups/cn%3Ddevelopers%2Cou%3Dgroups%2Cdc%3Dexample%2Cdc%3Dcom"
```

**Response (200):**

```json
{
  "dn": "cn=developers,ou=groups,dc=example,dc=com",
  "cn": "developers",
  "description": "Development team",
  "member": [
    "uid=john.doe,ou=users,dc=example,dc=com",
    "uid=jane.smith,ou=users,dc=example,dc=com"
  ]
}
```

**Response (404):**

```json
{
  "error": "Group not found"
}
```

### Create Group

```http
POST /api/v1/ldap/groups
```

**Request Body:**

```json
{
  "cn": "developers",
  "description": "Development team",
  "member": [
    "uid=john.doe,ou=users,dc=example,dc=com",
    "uid=jane.smith,ou=users,dc=example,dc=com"
  ]
}
```

**Notes:**

- `cn` is required
- `member` can be a string (single member) or array (multiple members)
- If no members provided, a dummy member is automatically added
- Additional attributes can be included based on schema

**Response (200):**

```json
{
  "success": true
}
```

### Modify Group

```http
PUT /api/v1/ldap/groups/{cn}
```

**Path Parameter:**

- `cn`: Group common name

**Request Body:**

```json
{
  "replace": {
    "description": "Updated development team"
  },
  "add": {
    "businessCategory": "IT"
  },
  "delete": ["ou"]
}
```

**Important:**

- Cannot modify `cn` attribute directly (use rename endpoint instead)
- Cannot modify `member` attribute here (use member management endpoints instead)
- Supports `add`, `replace`, and `delete` operations

**Response (200):**

```json
{
  "success": true
}
```

### Rename Group

```http
POST /api/v1/ldap/groups/{cn}/rename
```

**Path Parameter:**

- `cn`: Current group common name

**Request Body:**

```json
{
  "newCn": "new-group-name"
}
```

**Response (200):**

```json
{
  "success": true
}
```

**Description:**

Renames a group by changing its `cn` attribute. This performs an LDAP modifyDN operation to change the RDN of the group entry.

### Move Group

```http
POST /api/v1/ldap/groups/{cn}/move
```

**Path Parameter:**

- `cn`: Group common name

**Request Body:**

```json
{
  "targetOrgDn": "ou=NewDepartment,ou=organization,dc=example,dc=com"
}
```

**Response (200):**

```json
{
  "success": true
}
```

**Description:**

Moves a group to a different organization by updating its `twakeDepartmentLink` and `twakeDepartmentPath` attributes.

**Authorization:**

When using the `authzPerBranch` plugin, moving a group requires:

- **Read** permission on the source organization
- **Write** permission on the destination organization

**Requirements:**

- Target organization must exist
- Group cannot be moved to the same organization
- Requires `twakeDepartmentLink` and `twakeDepartmentPath` attributes in config

### Delete Group

```http
DELETE /api/v1/ldap/groups/{cn}
```

**Path Parameter:**

- `cn`: Group common name

**Response (200):**

```json
{
  "success": true
}
```

### Add Members

```http
POST /api/v1/ldap/groups/{cn}/members
```

**Path Parameter:**

- `cn`: Group common name

**Request Body:**

```json
{
  "member": "uid=new.user,ou=users,dc=example,dc=com"
}
```

Or multiple members:

```json
{
  "member": [
    "uid=user1,ou=users,dc=example,dc=com",
    "uid=user2,ou=users,dc=example,dc=com"
  ]
}
```

**Validation:**

- By default, members must exist in LDAP (configurable)
- Duplicate members are ignored
- Member DNs are validated

**Response (200):**

```json
{
  "success": true
}
```

### Remove Member

```http
DELETE /api/v1/ldap/groups/{cn}/members/{member}
```

**Path Parameters:**

- `cn`: Group common name
- `member`: Member DN (URL-encoded)

**Example:**

```bash
curl -X DELETE "http://localhost:8081/api/v1/ldap/groups/developers/members/uid%3Djohn.doe%2Cou%3Dusers%2Co%3Dgov%2Cc%3Dmu"
```

**Notes:**

- If removing the last real member, the dummy member is automatically added
- Member DN must be URL-encoded in the path

**Response (200):**

```json
{
  "success": true
}
```

## Schema Support

The plugin supports JSON schema validation for group attributes. Example schema:

```json
{
  "strict": true,
  "attributes": {
    "objectClass": {
      "type": "array",
      "default": ["top", "groupOfNames"],
      "required": true
    },
    "cn": {
      "type": "string",
      "test": "^[a-zA-Z0-9._-]+$",
      "required": true
    },
    "member": {
      "type": "array",
      "items": { "type": "string" },
      "required": true
    },
    "description": {
      "type": "string",
      "required": false
    }
  }
}
```

## Hooks

The plugin emits and listens to lifecycle hooks:

### Emitted Hooks

- `ldapgroupaddrequest` - Before creating a group (can modify dn, attributes, members)
- `ldapgroupadddone` - After group created successfully
- `ldapgroupmodify` - Before modifying group
- `ldapgroupmodifydone` - After group modified
- `ldapgroupdelete` - Before deleting group
- `ldapgroupdeletedone` - After group deleted
- `ldapgroupaddmember` - Before adding members
- `ldapgroupaddmemberdone` - After members added
- `ldapgroupdeletemember` - Before removing members
- `ldapgroupdeletememberdone` - After members removed

### Listened Hooks

- `ldapdeleterequest` - Automatically removes deleted users from all groups

**Example Hook:**

```javascript
hooks: {
  ldapgroupaddrequest: async ([dn, entry, members, op]) => {
    // Validate or modify before group creation
    console.log('Creating group:', dn);
    console.log('Initial members:', members);

    // Add automatic attributes
    entry.businessCategory = 'Auto-generated';

    return [dn, entry, members, op];
  },

  ldapgroupadddone: async ([dn, op]) => {
    console.log('Group created successfully:', dn);
  }
}
```

## Member Validation

The plugin includes sophisticated member validation:

### Default Behavior (Validation Enabled)

```javascript
// This will succeed if uid=john.doe exists
await addGroupMembers('developers', 'uid=john.doe,ou=users,dc=example,dc=com');

// This will fail if uid=nonexistent doesn't exist
await addGroupMembers(
  'developers',
  'uid=nonexistent,ou=users,dc=example,dc=com'
);
// Error: Member does not exist
```

### Disable Validation

```bash
--groups-allow-unexistent-members true
```

With validation disabled, any DN can be added as a member (useful for external references or cross-domain groups).

## Automatic Cleanup

When a user is deleted from LDAP, the plugin automatically:

1. Detects the deletion via `ldapdeleterequest` hook
2. Searches all groups for the deleted user
3. Removes the user from all groups
4. Adds dummy member if group becomes empty

This ensures referential integrity without manual intervention.

## Examples

### Example 1: Create Development Team Group

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups \
  -H "Content-Type: application/json" \
  -d '{
    "cn": "dev-team",
    "description": "Development Team",
    "businessCategory": "Engineering",
    "member": [
      "uid=alice,ou=users,dc=example,dc=com",
      "uid=bob,ou=users,dc=example,dc=com"
    ]
  }'
```

### Example 2: Add Member to Existing Group

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups/dev-team/members \
  -H "Content-Type: application/json" \
  -d '{
    "member": "uid=charlie,ou=users,dc=example,dc=com"
  }'
```

### Example 3: Update Group Description

```bash
curl -X PUT http://localhost:8081/api/v1/ldap/groups/dev-team \
  -H "Content-Type: application/json" \
  -d '{
    "replace": {
      "description": "Senior Development Team"
    }
  }'
```

### Example 4: Remove Member

```bash
curl -X DELETE "http://localhost:8081/api/v1/ldap/groups/dev-team/members/uid%3Dalice%2Cou%3Dusers%2Co%3Dgov%2Cc%3Dmu"
```

### Example 5: List All Groups

```bash
curl "http://localhost:8081/api/v1/ldap/groups?attributes=cn,member,description"
```

## Integration with Other Plugins

### With Users Plugin

When a user is deleted:

```bash
DELETE /api/v1/ldap/users/john.doe
```

The groups plugin automatically removes `john.doe` from all groups.

### With Organizations Plugin

Groups can reference users from different organizations:

```json
{
  "cn": "cross-dept-team",
  "member": [
    "uid=user1,ou=dept1,ou=org,dc=example,dc=com",
    "uid=user2,ou=dept2,ou=org,dc=example,dc=com"
  ]
}
```

## Troubleshooting

### Empty Group Error

**Problem:** `Object class 'groupOfNames' requires attribute 'member'`

**Solution:** The plugin automatically handles this by adding a dummy member. Ensure `--group-dummy-user` is properly configured:

```bash
--group-dummy-user "cn=placeholder,ou=users,dc=example,dc=com"
```

### Member Validation Fails

**Problem:** `Member does not exist in LDAP`

**Solutions:**

1. Ensure the user exists before adding them to the group
2. use `core/ldap/externalUsersInGroups` plugin
3. Disable validation: `--groups-allow-unexistent-members true`

### Cannot Modify Members via PUT

**Problem:** Attempting to modify `member` attribute via PUT endpoint

**Solution:** Use dedicated member management endpoints:

- Add: `POST /api/v1/ldap/groups/{cn}/members`
- Remove: `DELETE /api/v1/ldap/groups/{cn}/members/{member}`

## See Also

- [LDAP Flat Plugin](./ldapFlat.md) - For managing flat LDAP entities (users, positions, nomenclature) through schema-driven approach
- [LDAP Organizations Plugin](./ldapOrganizations.md) - For managing hierarchical organizational structures with validation
- [Schema Examples](../static/schemas/) - Group schema examples for Twake, Standard, and Active Directory
