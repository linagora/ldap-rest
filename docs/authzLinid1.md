# Authorization Plugin: authzLinid1

LDAP-based authorization plugin that grants permissions based on the `twakeLocalAdminLink` attribute in organizational units.

## Overview

The `authzLinid1` plugin provides dynamic, LDAP-driven access control by reading permissions directly from LDAP organizational units. It supports:

- **LDAP-based permissions** - No configuration files needed, permissions stored in LDAP
- **Organization-centric** - Users listed in `twakeLocalAdminLink` manage the organization
- **Full CRUD rights** - Local admins get read, write, and delete permissions
- **Sub-branch inheritance** - Permissions apply recursively to sub-branches
- **Cross-branch access** - Users/groups can be managed if their `twakeDepartmentLink` points to an authorized organization
- **Permission caching** - Configurable TTL reduces LDAP queries (default: 5 minutes)

## How It Works

### twakeLocalAdminLink Attribute

Organizations in LDAP can have a `twakeLocalAdminLink` attribute listing user DNs who manage that organization:

```ldif
dn: ou=HR,ou=organization,dc=example,dc=com
objectClass: organizationalUnit
ou: HR
twakeLocalAdminLink: uid=hr-admin,ou=users,dc=example,dc=com
twakeLocalAdminLink: uid=hr-manager,ou=users,dc=example,dc=com
```

Users listed in `twakeLocalAdminLink` automatically get full permissions (read, write, delete) for:

- The organization itself (`ou=HR,ou=organization,dc=example,dc=com`)
- All sub-organizations (`ou=Payroll,ou=HR,ou=organization,dc=example,dc=com`)
- All users/groups with `twakeDepartmentLink` pointing to this organization

### Cross-Branch Access

Users and groups can exist in different LDAP branches but belong to specific organizations via `twakeDepartmentLink`:

```ldif
# User in global users branch
dn: uid=john,ou=users,dc=example,dc=com
objectClass: twakeAccount
uid: john
cn: John Doe
twakeDepartmentLink: ou=HR,ou=organization,dc=example,dc=com
```

The HR admin (listed in `ou=HR`'s `twakeLocalAdminLink`) can manage John even though he's in `ou=users` because his `twakeDepartmentLink` points to the HR organization.

## Configuration

No configuration file needed - permissions are read from LDAP. Simply load the plugin:

```bash
--plugin core/auth/authzLinid1
```

**Optional Cache Configuration:**

The plugin caches permissions for 5 minutes by default. This is hardcoded but can be modified in the source if needed.

## Permission Resolution

For each LDAP operation, the plugin:

1. **Resolves user DN** - Converts username to LDAP DN
2. **Searches for permissions** - Finds all organizations where user is in `twakeLocalAdminLink`
3. **Caches results** - Stores permissions for 5 minutes
4. **Checks branch access** - Verifies if requested branch matches authorized organizations
5. **Checks link attributes** - For entries with `twakeDepartmentLink`, checks if link points to authorized org

### Permission Inheritance

Permissions apply to the organization and all descendants:

```
ou=organization,dc=example,dc=com
├── ou=Main Unit [admin1 has twakeLocalAdminLink here]
│   ├── ou=Sub Unit 1 [admin1 can access]
│   │   └── ou=Department1 [admin1 can access]
│   └── ou=Sub Unit 2 [admin1 can access]
└── ou=Private [admin1 cannot access]
```

### Cross-Branch Examples

**Scenario 1: User in authorized branch**

```
Organization: ou=HR,ou=organization,dc=example,dc=com
              twakeLocalAdminLink: uid=admin,ou=users,dc=example,dc=com

User: uid=john,ou=users,ou=HR,ou=organization,dc=example,dc=com

Result: admin can manage john (user is in HR branch)
```

**Scenario 2: User with department link**

```
Organization: ou=HR,ou=organization,dc=example,dc=com
              twakeLocalAdminLink: uid=admin,ou=users,dc=example,dc=com

User: uid=john,ou=users,dc=example,dc=com
      twakeDepartmentLink: ou=HR,ou=organization,dc=example,dc=com

Result: admin can manage john (twakeDepartmentLink points to HR)
```

**Scenario 3: User without link in wrong branch**

```
Organization: ou=HR,ou=organization,dc=example,dc=com
              twakeLocalAdminLink: uid=admin,ou=users,dc=example,dc=com

User: uid=john,ou=users,dc=example,dc=com
      (no twakeDepartmentLink)

Result: admin cannot manage john (not in HR branch, no link)
```

## Hooks

### ldapaddrequest Hook

Intercepts all LDAP add operations:

1. Checks if request has authenticated user
2. Resolves user's DN from username
3. Determines which branch to check:
   - If entry has `twakeDepartmentLink`, use that organization
   - Otherwise, use parent DN of the entry being added
4. Verifies user has write permission for that branch
5. Throws error if access denied

**Special allowances:**

- Unauthenticated requests pass through (for internal operations)

### ldapsearchrequest Hook

Intercepts all LDAP search operations:

1. Checks if request has authenticated user
2. Resolves user's DN from username
3. Allows base scope searches on top organization (for navigation)
4. Allows searches for `twakeLocalAdminLink` (for permission refresh)
5. Verifies user has read permission for search base
6. Throws error if access denied

**Special allowances:**

- Base scope on `ldap_top_organization` (e.g., for getOrganisationTop API)
- Filters containing `twakeLocalAdminLink` (permission refresh queries)

### getOrganisationTop Hook

Modifies the organization tree API:

1. Returns organizations where user is local admin
2. Replaces default top organization with authorized branches
3. Enables UI to show only manageable organizations

**Behavior:**

- If user manages multiple orgs, returns the first one
- If user manages one org, returns that org
- If user manages no orgs, returns default top organization

## API Integration

### Organization Tree API

The plugin automatically filters the organization tree API:

**Global admin (manages top organization):**

```
GET /api/v1/ldap/organizations/top
Authorization: Bearer <token>

Response:
{
  "dn": "ou=organization,dc=example,dc=com",
  "ou": "organization"
}
```

**Local admin (manages specific organization):**

```
GET /api/v1/ldap/organizations/top
Authorization: Bearer <token>

Response:
{
  "dn": "ou=HR,ou=organization,dc=example,dc=com",
  "ou": "HR"
}
```

### Add User Example

**Success - User with department link to authorized org:**

```
POST /api/v1/users
Authorization: Bearer <hr-admin-token>

{
  "uid": "newuser",
  "cn": "New User",
  "twakeDepartmentLink": ["ou=HR,ou=organization,dc=example,dc=com"]
}

Response: 201 Created
```

**Failure - User with link to unauthorized org:**

```
POST /api/v1/users
Authorization: Bearer <hr-admin-token>

{
  "uid": "newuser",
  "cn": "New User",
  "twakeDepartmentLink": ["ou=IT,ou=organization,dc=example,dc=com"]
}

Response: 403 Forbidden
{
  "error": "User hr-admin does not have write permission for branch ou=IT,ou=organization,dc=example,dc=com"
}
```

## Performance

### Permission Caching

Permissions are cached to reduce LDAP queries:

- **Cache TTL**: 5 minutes (hardcoded)
- **Per-user cache**: Each user's permissions cached separately
- **Automatic refresh**: Cache expires after TTL
- **On-demand refresh**: New permissions fetched on cache miss

**Cache structure:**

```javascript
{
  "uid=admin,ou=users,dc=example,dc=com": {
    branches: Map([
      ["ou=HR,ou=organization,dc=example,dc=com", {read: true, write: true, delete: true}],
      ["ou=Finance,ou=organization,dc=example,dc=com", {read: true, write: true, delete: true}]
    ]),
    timestamp: 1696512000000
  }
}
```

### LDAP Query Optimization

The plugin minimizes LDAP queries:

1. **User DN resolution** - Cached implicitly by permission cache
2. **Permission search** - Single query for all organizations with user in `twakeLocalAdminLink`
3. **No recursive searches** - Uses DN suffix matching for sub-branch checks

**Typical query pattern:**

```
User makes request → Check cache → (if expired) Search LDAP once → Cache for 5 min
```

## LDAP Schema Requirements

### Required Attributes

**Organizations:**

- `twakeLocalAdminLink` (multi-valued) - DNs of local administrators

**Users/Groups:**

- `twakeDepartmentLink` (single-valued) - DN of parent organization

### Example Schema

```ldif
# Organization with local admins
dn: ou=HR,ou=organization,dc=example,dc=com
objectClass: organizationalUnit
objectClass: twakeOrganization
ou: HR
twakeLocalAdminLink: uid=hr-admin,ou=users,dc=example,dc=com
twakeLocalAdminLink: uid=hr-manager,ou=users,dc=example,dc=com

# User with department link
dn: uid=employee1,ou=users,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: twakeAccount
uid: employee1
cn: Employee One
twakeDepartmentLink: ou=HR,ou=organization,dc=example,dc=com

# Group with department link
dn: cn=hr-staff,ou=groups,dc=example,dc=com
objectClass: groupOfNames
objectClass: twakeGroup
cn: hr-staff
twakeDepartmentLink: ou=HR,ou=organization,dc=example,dc=com
member: uid=employee1,ou=users,dc=example,dc=com
```

## Security Considerations

### LDAP-Driven Security

- **Centralized control** - All permissions in LDAP, no config files to sync
- **Audit trail** - LDAP modifications can be logged/audited
- **Consistency** - Single source of truth for permissions
- **Real-time updates** - Changes effective after cache expiry (5 min max)

### Permission Model

- **Local admins get full access** - Read, write, and delete
- **No granular permissions** - Cannot grant read-only local admin
- **Inheritance always applies** - Cannot restrict sub-branches
- **Cross-branch by design** - Department links intentionally allow cross-branch access

### Authentication Required

This plugin only handles **authorization**. Combine with an authentication plugin:

```bash
--plugin core/auth/token \
--plugin core/auth/authzLinid1 \
--auth-token "secret-token"
```

### Cache Security

- **Cache delays permission revocation** - Up to 5 minutes after removing user from `twakeLocalAdminLink`
- **Cache per user** - Removing one user doesn't invalidate others
- **No cache persistence** - Cache cleared on server restart

## Troubleshooting

### Problem: Access Denied

**Symptoms:**

```json
{
  "error": "User jdoe does not have write permission for branch ou=HR,ou=organization,dc=example,dc=com"
}
```

**Solutions:**

1. Verify user is in organization's `twakeLocalAdminLink`:

   ```bash
   ldapsearch -x -b "ou=organization,dc=example,dc=com" "(twakeLocalAdminLink=uid=jdoe,*)"
   ```

2. Check user DN matches exactly (spaces, case, order)

3. Wait up to 5 minutes for cache to expire after adding user

4. Check user is authenticated (verify `req.user` is set)

### Problem: Cannot Manage User in Different Branch

**Symptoms:**
User exists in `ou=users,dc=example,dc=com` but local admin cannot manage them.

**Solutions:**

1. Add `twakeDepartmentLink` to user:

   ```ldif
   dn: uid=user,ou=users,dc=example,dc=com
   changetype: modify
   add: twakeDepartmentLink
   twakeDepartmentLink: ou=HR,ou=organization,dc=example,dc=com
   ```

2. Or move user to organization branch:
   ```
   From: uid=user,ou=users,dc=example,dc=com
   To:   uid=user,ou=users,ou=HR,ou=organization,dc=example,dc=com
   ```

### Problem: Permissions Not Updating

**Symptoms:**
Added user to `twakeLocalAdminLink` but they still get access denied.

**Solutions:**

1. Wait up to 5 minutes for cache to expire
2. Restart server to clear all caches immediately
3. Verify LDAP modification succeeded:
   ```bash
   ldapsearch -x -b "ou=HR,ou=organization,dc=example,dc=com" "(objectClass=*)" twakeLocalAdminLink
   ```

### Problem: User Not Found

**Symptoms:**

```
User jdoe not found in LDAP
```

**Solutions:**

1. Verify user exists in LDAP:

   ```bash
   ldapsearch -x -b "dc=example,dc=com" "(uid=jdoe)"
   ```

2. Check `ldap_user_main_attribute` configuration (default: `uid`)

3. Verify authentication plugin sets `req.user` correctly

### Problem: Cannot Search Top Organization

**Symptoms:**

```json
{
  "error": "User admin does not have read permission for branch ou=organization,dc=example,dc=com"
}
```

**Solutions:**

This is expected behavior - users can only see organizations they manage. To grant access to top organization:

```bash
ldapsearch -x -b "ou=organization,dc=example,dc=com" -s base "(objectClass=*)"
# Modify to add user:
ldapmodify <<EOF
dn: ou=organization,dc=example,dc=com
changetype: modify
add: twakeLocalAdminLink
twakeLocalAdminLink: uid=admin,ou=users,dc=example,dc=com
EOF
```

## Integration Examples

### With Token Authentication

```bash
--plugin core/auth/token \
--plugin core/auth/authzLinid1 \
--auth-token "admin-token" \
--ldap-top-organization "ou=organization,dc=example,dc=com"
```

### With OpenID Connect

```bash
--plugin core/auth/openidconnect \
--plugin core/auth/authzLinid1 \
--oidc-server "https://auth.example.com" \
--oidc-client-id "mini-dm" \
--oidc-client-secret "secret" \
--base-url "https://api.example.com" \
--ldap-top-organization "ou=organization,dc=example,dc=com"
```

### With LemonLDAP::NG

```bash
--plugin core/auth/llng \
--plugin core/auth/authzLinid1 \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini \
--ldap-top-organization "ou=organization,dc=example,dc=com"
```

## Comparison with authzPerBranch

| Feature           | authzLinid1                        | authzPerBranch                   |
| ----------------- | ---------------------------------- | -------------------------------- |
| Configuration     | LDAP-based                         | Config file/env                  |
| Permission source | `twakeLocalAdminLink` attribute    | JSON configuration               |
| Granularity       | Organization-level                 | Per-branch, per-user/group       |
| Read-only access  | No (always full access)            | Yes (separate read/write/delete) |
| Cross-branch      | Yes (via `twakeDepartmentLink`)    | Yes (if configured)              |
| Dynamic updates   | Yes (via LDAP)                     | No (requires restart)            |
| Cache             | 5 min (hardcoded)                  | Configurable TTL                 |
| Use case          | Organization-based delegated admin | Fine-grained access control      |

**When to use authzLinid1:**

- Organizations manage themselves
- LDAP is source of truth
- Full admin access is acceptable
- Department-based delegation

**When to use authzPerBranch:**

- Need read-only access
- Complex permission matrix
- Config-driven permissions
- Different rights per branch

## See Also

- [authzPerBranch Plugin](authzPerBranch.md) - Configuration-based authorization
- [Authentication Plugins](authentication.md) - Setup authentication
- [LDAP Organizations](ldapOrganizations.md) - Organization tree management
- [LDAP Users](ldapFlatGeneric.md) - User management
- [LDAP Groups](ldapGroups.md) - Group management
