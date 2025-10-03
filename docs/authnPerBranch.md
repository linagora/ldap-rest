# Authorization Plugin: authnPerBranch

Branch-level authorization plugin that restricts LDAP access based on user and group permissions.

## Overview

The `authnPerBranch` plugin provides fine-grained access control by restricting which LDAP branches users can access. It supports:

- **Default permissions** - Applied when no specific rules match
- **User-based permissions** - Per-user branch access rules
- **Group-based permissions** - Permissions inherited from group memberships
- **Separate rights** - Read, write, and delete permissions
- **Sub-branch inheritance** - Permissions apply recursively to sub-branches
- **Group caching** - Configurable TTL for group membership resolution

## Configuration

```bash
--plugin core/auth/authnPerBranch \
--authn-per-branch-config '{
  "default": {
    "read": true,
    "write": false,
    "delete": false
  },
  "users": {
    "admin": {
      "ou=users,o=gov,c=mu": {
        "read": true,
        "write": true,
        "delete": true
      }
    }
  },
  "groups": {
    "cn=managers,ou=groups,o=gov,c=mu": {
      "ou=organization,o=gov,c=mu": {
        "read": true,
        "write": true,
        "delete": false
      }
    }
  }
}' \
--authn-per-branch-cache-ttl 60
```

**Environment Variables:**

```bash
DM_AUTHN_PER_BRANCH_CONFIG='{"default":{"read":true,"write":false,"delete":false},...}'
DM_AUTHN_PER_BRANCH_CACHE_TTL=60
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
      "ou=branch,o=gov,c=mu": {
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
    "cn=groupname,ou=groups,o=gov,c=mu": {
      "ou=branch,o=gov,c=mu": {
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
      "ou=organization,o=gov,c=mu": {
        "read": true
      }
    }
  }
}
```

With this config, user `manager` can read:

- `ou=organization,o=gov,c=mu`
- `ou=dept1,ou=organization,o=gov,c=mu`
- `ou=team1,ou=dept1,ou=organization,o=gov,c=mu`
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
      "ou=HR,ou=organization,o=gov,c=mu": {
        "read": true,
        "write": true,
        "delete": false
      }
    },
    "it_user": {
      "ou=IT,ou=organization,o=gov,c=mu": {
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
    "cn=editors,ou=groups,o=gov,c=mu": {
      "ou=content,o=gov,c=mu": {
        "read": true,
        "write": true,
        "delete": false
      }
    },
    "cn=admins,ou=groups,o=gov,c=mu": {
      "o=gov,c=mu": {
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
      "o=gov,c=mu": {
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
      "ou=HR,ou=organization,o=gov,c=mu": {
        "read": true,
        "write": true,
        "delete": false
      },
      "ou=Finance,ou=organization,o=gov,c=mu": {
        "read": true,
        "write": false,
        "delete": false
      }
    }
  }
}
```

## API Integration

### Organization Tree API

The plugin automatically filters the organization tree API (`/api/v1/ldap/organizations/top`):

**Without authnPerBranch:**

```json
{
  "dn": "ou=organization,o=gov,c=mu",
  "ou": "organization"
}
```

**With authnPerBranch (user has access to specific branches):**

```json
[
  {
    "dn": "ou=HR,ou=organization,o=gov,c=mu",
    "ou": "HR"
  },
  {
    "dn": "ou=IT,ou=organization,o=gov,c=mu",
    "ou": "IT"
  }
]
```

## Performance

### Group Caching

Group memberships are cached to reduce LDAP queries:

- **Default TTL**: 60 seconds
- **Configurable**: `--authn-per-branch-cache-ttl`
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
--plugin core/auth/authnPerBranch \
--auth-token "secret-token"
```

## Troubleshooting

### Problem: Access Denied

**Symptoms:**

```json
{
  "error": "User jdoe does not have read permission for branch ou=users,o=gov,c=mu"
}
```

**Solutions:**

1. Check user has permission for requested branch:

   ```json
   {
     "users": {
       "jdoe": {
         "ou=users,o=gov,c=mu": {
           "read": true
         }
       }
     }
   }
   ```

2. Verify user is authenticated (check `req.user`)

3. Check default permissions allow access

4. Verify group membership if using group permissions

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
3. Reduce `--authn-per-branch-cache-ttl` for testing

### Problem: Group Permissions Not Working

**Symptoms:**
User should inherit group permissions but doesn't.

**Solutions:**

1. Verify user is member of group:

   ```bash
   ldapsearch -x -b "ou=groups,o=gov,c=mu" "(member=uid=jdoe,*)"
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
--plugin core/auth/authnPerBranch \
--auth-token "admin-token" \
--authn-per-branch-config '{
  "default": {"read": false, "write": false, "delete": false}
}'
```

### With OpenID Connect

```bash
--plugin core/auth/openidconnect \
--plugin core/auth/authnPerBranch \
--oidc-server "https://auth.example.com" \
--oidc-client-id "mini-dm" \
--oidc-client-secret "secret" \
--base-url "https://api.example.com" \
--authn-per-branch-config '{
  "users": {
    "user@example.com": {
      "ou=organization,o=gov,c=mu": {"read": true, "write": true}
    }
  }
}'
```

### With LemonLDAP::NG

```bash
--plugin core/auth/llng \
--plugin core/auth/authnPerBranch \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini \
--authn-per-branch-config '{"default": {"read": true}}'
```

## See Also

- [Authentication Plugins](authentication.md) - Setup authentication
- [LDAP Organizations](ldapOrganizations.md) - Organization tree management
- [LDAP Groups](ldapGroups.md) - Group management
