# Authorization Plugin: authzPerBranch

Branch-level authorization plugin that restricts LDAP access based on user and group permissions.

## Overview

The `authzPerBranch` plugin provides fine-grained access control by restricting which LDAP branches users can access. It supports:

- **Default permissions** - Applied when no specific rules match
- **User-based permissions** - Per-user branch access rules
- **Group-based permissions** - Permissions inherited from group memberships
- **Separate rights** - Read, write, and delete permissions
- **Sub-branch inheritance** - Permissions apply recursively to sub-branches
- **Group caching** - Configurable TTL for group membership resolution

## Configuration

```bash
--plugin core/auth/authzPerBranch \
--authz-per-branch-config '{
  "default": {
    "read": true,
    "write": false,
    "delete": false
  },
  "users": {
    "admin": {
      "ou=users,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": true
      }
    }
  },
  "groups": {
    "cn=managers,ou=groups,dc=example,dc=com": {
      "ou=organization,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}' \
--authz-per-branch-cache-ttl 60
```

**Environment Variables:**

```bash
DM_AUTHZ_PER_BRANCH_CONFIG='{"default":{"read":true,"write":false,"delete":false},...}'
DM_AUTHZ_PER_BRANCH_CACHE_TTL=60
```

## Configuration Structure

### Default Permissions

Applied when no user or group-specific rules match:

```json
{
  "default": {
    "read": true,
    "write": false,
    "delete": false
  }
}
```

### User Permissions

Branch-specific permissions for individual users:

```json
{
  "users": {
    "username": {
      "ou=branch,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}
```

### Group Permissions

Permissions applied to all group members:

```json
{
  "groups": {
    "cn=groupname,ou=groups,dc=example,dc=com": {
      "ou=branch,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}
```

## Permission Resolution

Permissions are resolved in this order:

1. **User-specific permissions** - If user has direct branch permissions, use them
2. **Group permissions** - Check all groups user belongs to
3. **Default permissions** - Fall back to defaults if no specific rules match

For each permission type (read/write/delete), the **most permissive** rule wins.

## How It Works

### LDAP Search Hook

Intercepts all LDAP search operations:

1. Checks if request has authenticated user (`req.user`)
2. Resolves user's permissions for the requested branch
3. Verifies user has `read` permission
4. Throws error if access denied

### LDAP Add Hook

Intercepts all LDAP add operations:

1. Checks if request has authenticated user
2. Resolves user's permissions for the target branch
3. Verifies user has `write` permission
4. Throws error if access denied

### LDAP Modify Hook

Intercepts all LDAP modify operations:

1. For regular modifications: checks `write` permission on the entry's branch
2. For **move operations** (changing organization link):
   - Verifies user has `read` permission on source branch
   - Verifies user has `write` permission on destination branch
   - Throws error if either permission is missing

### LDAP Delete Hook

Intercepts all LDAP delete operations:

1. Checks if request has authenticated user
2. Resolves user's permissions for the entry's branch
3. Verifies user has `delete` permission
4. Throws error if access denied

### LDAP Rename Hook

Intercepts all LDAP rename/modifyDN operations (for organization moves):

1. Extracts source and destination branches from DNs
2. Verifies user has `read` permission on source branch
3. Verifies user has `write` permission on destination branch
4. Throws error if either permission is missing

### Organization Top Hook

Modifies the organization tree API:

1. Returns only branches the user can read
2. Replaces default top organization with authorized branches
3. Enables UI to show only accessible parts of the tree

### Group Resolution

Groups are resolved dynamically:

1. Searches for all groups where user is a member
2. Uses wildcard DN pattern: `(member=uid={user},*)`
3. Caches results for configured TTL (default: 60 seconds)
4. Cache prevents repeated LDAP queries for same user

## Sub-branch Inheritance

Permissions apply recursively to all sub-branches:

```json
{
  "users": {
    "manager": {
      "ou=organization,dc=example,dc=com": {
        "read": true
      }
    }
  }
}
```

With this config, user `manager` can read:

- `ou=organization,dc=example,dc=com`
- `ou=dept1,ou=organization,dc=example,dc=com`
- `ou=team1,ou=dept1,ou=organization,dc=example,dc=com`
- ... all descendants

## Examples

### Example 1: Department-Based Access

Allow users to access only their department:

```json
{
  "default": {
    "read": false,
    "write": false,
    "delete": false
  },
  "users": {
    "hr_user": {
      "ou=HR,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    },
    "it_user": {
      "ou=IT,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}
```

### Example 2: Group-Based Access

Use groups for team permissions:

```json
{
  "default": {
    "read": true,
    "write": false,
    "delete": false
  },
  "groups": {
    "cn=editors,ou=groups,dc=example,dc=com": {
      "ou=content,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    },
    "cn=admins,ou=groups,dc=example,dc=com": {
      "dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": true
      }
    }
  }
}
```

### Example 3: Read-Only by Default

Restrict write access to specific users:

```json
{
  "default": {
    "read": true,
    "write": false,
    "delete": false
  },
  "users": {
    "admin": {
      "dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": true
      }
    }
  }
}
```

### Example 4: Multiple Branches per User

Grant access to multiple branches:

```json
{
  "users": {
    "coordinator": {
      "ou=HR,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      },
      "ou=Finance,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": false,
        "delete": false
      }
    }
  }
}
```

### Example 5: Move Operations Authorization

For move operations (groups or organizations), the user needs **both** read permission on the source and write permission on the destination:

```json
{
  "users": {
    "manager": {
      "ou=DeptA,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": false,
        "delete": false
      },
      "ou=DeptB,ou=organization,dc=example,dc=com": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}
```

With this configuration:

- ✅ User `manager` **CAN** move items from DeptA to DeptB (has read on source, write on destination)
- ❌ User `manager` **CANNOT** move items from DeptB to DeptA (has write on source but no write on destination)
- ❌ User `manager` **CANNOT** move items from DeptC to DeptB (no read permission on source)

## API Integration

### Organization Tree API

The plugin automatically filters the organization tree API (`/api/v1/ldap/organizations/top`):

**Without authzPerBranch:**

```json
{
  "dn": "ou=organization,dc=example,dc=com",
  "ou": "organization"
}
```

**With authzPerBranch (user has access to specific branches):**

```json
[
  {
    "dn": "ou=HR,ou=organization,dc=example,dc=com",
    "ou": "HR"
  },
  {
    "dn": "ou=IT,ou=organization,dc=example,dc=com",
    "ou": "IT"
  }
]
```

## Performance

### Group Caching

Group memberships are cached to reduce LDAP queries:

- **Default TTL**: 60 seconds
- **Configurable**: `--authz-per-branch-cache-ttl`
- **Per-user cache**: Each user's groups cached separately
- **Automatic expiry**: Cache entries expire after TTL

Cache hit/miss logging:

```
[debug] Group cache hit for user: jdoe
[debug] Group cache miss for user: jsmith - querying LDAP
```

### Optimization Tips

1. **Increase cache TTL** for stable group memberships
2. **Use group permissions** instead of per-user rules
3. **Keep permission config small** - avoid hundreds of rules
4. **Structure LDAP efficiently** - shallow hierarchies perform better

## Security Considerations

### Permission Inheritance

- Sub-branch permissions inherit from parent branches
- Cannot grant more restrictive permissions on sub-branches
- Plan branch structure carefully

### Default Permissions

- **Secure by default**: Set `read: false` for sensitive directories
- **Open by default**: Set `read: true` for general access
- Choose based on your security posture

### Group-Based Security

- Group DNs must be fully qualified
- Group resolution uses LDAP search - ensure proper indexing
- Cache can delay permission revocation (up to TTL duration)

### Authentication Required

This plugin only handles **authorization**. Combine with an authentication plugin:

```bash
--plugin core/auth/token \
--plugin core/auth/authzPerBranch \
--auth-token "secret-token"
```

## Troubleshooting

### Problem: Access Denied

**Symptoms:**

```json
{
  "error": "User jdoe does not have read permission for branch ou=users,dc=example,dc=com"
}
```

**Solutions:**

1. Check user has permission for requested branch:

   ```json
   {
     "users": {
       "jdoe": {
         "ou=users,dc=example,dc=com": {
           "read": true
         }
       }
     }
   }
   ```

2. Verify user is authenticated (check `req.user`)

3. Check default permissions allow access

4. Verify group membership if using group permissions

### Problem: Move Operation Failed

**Symptoms:**

```json
{
  "error": "check logs"
}
```

With logs showing:

```
User jdoe does not have read permission for source branch ou=DeptA,dc=example,dc=com
```

or

```
User jdoe does not have write permission for destination branch ou=DeptB,dc=example,dc=com
```

**Solutions:**

1. Verify user has **read** permission on the source branch
2. Verify user has **write** permission on the destination branch
3. Move operations require **both** permissions - having write on source is not sufficient

Example fix:

```json
{
  "users": {
    "jdoe": {
      "ou=DeptA,dc=example,dc=com": {
        "read": true,
        "write": false
      },
      "ou=DeptB,dc=example,dc=com": {
        "read": true,
        "write": true
      }
    }
  }
}
```

### Problem: No Branches Returned

**Symptoms:**
Organization tree API returns empty array or no data.

**Solutions:**

1. Check user has `read` permission for at least one branch
2. Verify DN syntax matches exactly (including spaces, case)
3. Check LDAP base configuration matches permission DNs

### Problem: Permissions Not Updating

**Symptoms:**
Changed permissions don't take effect immediately.

**Solutions:**

1. Wait for group cache TTL to expire
2. Restart server to clear all caches
3. Reduce `--authz-per-branch-cache-ttl` for testing

### Problem: Group Permissions Not Working

**Symptoms:**
User should inherit group permissions but doesn't.

**Solutions:**

1. Verify user is member of group:

   ```bash
   ldapsearch -x -b "ou=groups,dc=example,dc=com" "(member=uid=jdoe,*)"
   ```

2. Check group DN in config matches LDAP exactly

3. Ensure group membership uses correct attribute (default: `member`)

4. Configure custom member attribute if needed:
   ```bash
   --ldap-group-member-attribute uniqueMember
   ```

## Integration Examples

### With Token Authentication

```bash
--plugin core/auth/token \
--plugin core/auth/authzPerBranch \
--auth-token "admin-token" \
--authz-per-branch-config '{
  "default": {"read": false, "write": false, "delete": false}
}'
```

### With OpenID Connect

```bash
--plugin core/auth/openidconnect \
--plugin core/auth/authzPerBranch \
--oidc-server "https://auth.example.com" \
--oidc-client-id "mini-dm" \
--oidc-client-secret "secret" \
--base-url "https://api.example.com" \
--authz-per-branch-config '{
  "users": {
    "user@example.com": {
      "ou=organization,dc=example,dc=com": {"read": true, "write": true}
    }
  }
}'
```

### With LemonLDAP::NG

```bash
--plugin core/auth/llng \
--plugin core/auth/authzPerBranch \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini \
--authz-per-branch-config '{"default": {"read": true}}'
```

## See Also

- [Authentication Plugins](authentication.md) - Setup authentication
- [LDAP Organizations](ldapOrganizations.md) - Organization tree management
- [LDAP Groups](ldapGroups.md) - Group management
