# LDAP onChange Plugin

Monitor LDAP attribute changes and trigger hooks for specific attributes.

## Overview

The `onChange` plugin watches for LDAP modifications and generates specialized hooks when configured attributes change. This enables reactive integrations with external systems (mail servers, quota managers, etc.).

## Configuration

```bash
--plugin core/ldap/onChange \
--mail-attribute mail \
--quota-attribute mailQuota
```

**Environment Variables:**

```bash
DM_MAIL_ATTRIBUTE="mail"
DM_QUOTA_ATTRIBUTE="mailQuota"
```

## Generated Hooks

The plugin generates hooks based on configured attributes:

| Config Parameter    | Generated Hook      | Parameters                       |
| ------------------- | ------------------- | -------------------------------- |
| `--mail-attribute`  | `onLdapMailChange`  | `(dn, oldMail, newMail)`         |
| `--quota-attribute` | `onLdapQuotaChange` | `(dn, mail, oldQuota, newQuota)` |

Generic hook for any change:

- `onLdapChange` - `(dn, changes)` where `changes` is `Record<attr, [oldValue, newValue]>`

## How It Works

1. **Hooks into LDAP modify operations** via `ldapUsersmodify` and `ldapGroupsmodify` hooks
2. **Detects attribute changes** by comparing old and new values
3. **Triggers specialized hooks** for configured attributes
4. **Provides old and new values** to downstream hooks

## Use Cases

### Mail Server Synchronization

When user email changes, update external mail server:

```javascript
// In another plugin
hooks: {
  onLdapMailChange: async (dn, oldMail, newMail) => {
    await mailServer.renameAccount(oldMail, newMail);
    console.log(`Renamed mail account: ${oldMail} → ${newMail}`);
  };
}
```

### Quota Management

When quota changes, update mail server quota:

```javascript
hooks: {
  onLdapQuotaChange: async (dn, mail, oldQuota, newQuota) => {
    await mailServer.setQuota(mail, newQuota);
    console.log(`Updated quota for ${mail}: ${oldQuota} → ${newQuota}`);
  };
}
```

### Generic Change Tracking

Track all attribute changes:

```javascript
hooks: {
  onLdapChange: async (dn, changes) => {
    for (const [attr, [oldVal, newVal]] of Object.entries(changes)) {
      console.log(`${dn}: ${attr} changed from ${oldVal} to ${newVal}`);
    }
  };
}
```

## Examples

### Example 1: Mail Attribute Monitoring

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--ldap-flat-schema ./schemas/users.json \
--mail-attribute mail
```

When a user's mail attribute changes via API:

```bash
PUT /api/v1/ldap/users/jdoe
{
  "replace": {
    "mail": "john.doe@newdomain.com"
  }
}
```

The `onLdapMailChange` hook fires with:

- `dn`: `"uid=jdoe,ou=users,dc=example,dc=com"`
- `oldMail`: `"jdoe@olddomain.com"`
- `newMail`: `"john.doe@newdomain.com"`

### Example 2: Multiple Attributes

```bash
--plugin core/ldap/onChange \
--mail-attribute mail \
--quota-attribute mailQuota
```

When both attributes change:

```bash
PUT /api/v1/ldap/users/jdoe
{
  "replace": {
    "mail": "jdoe@company.com",
    "mailQuota": "5000000000"
  }
}
```

Both hooks fire:

1. `onLdapMailChange(dn, "old@mail.com", "jdoe@company.com")`
2. `onLdapQuotaChange(dn, "jdoe@company.com", "1000000000", "5000000000")`

### Example 3: Generic Change Listener

```bash
--plugin core/ldap/onChange
```

All modifications trigger `onLdapChange`:

```bash
PUT /api/v1/ldap/users/jdoe
{
  "replace": {
    "cn": "John A. Doe",
    "telephoneNumber": "+1234567890"
  },
  "delete": ["description"]
}
```

Hook receives:

```javascript
{
  "cn": ["John Doe", "John A. Doe"],
  "telephoneNumber": [null, "+1234567890"],
  "description": ["Old description", null]
}
```

## Integration Examples

### With Twake James Mail Server

```bash
--plugin core/ldap/onChange \
--plugin twake/james \
--plugin core/ldap/flatGeneric \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--quota-attribute mailQuota \
--james-webadmin-url http://james:8000
```

The James plugin listens to `onLdapMailChange` and `onLdapQuotaChange` hooks and automatically updates the James mail server.

### Custom Integration Plugin

Create a custom plugin that reacts to changes:

```typescript
import DmPlugin from '../abstract/plugin';
import { Hooks } from '../hooks';

export default class CustomSync extends DmPlugin {
  name = 'customSync';

  dependencies = {
    onChange: 'core/ldap/onChange',
  };

  hooks: Hooks = {
    onLdapMailChange: async (dn, oldMail, newMail) => {
      this.logger.info(`Mail changed: ${oldMail} → ${newMail}`);

      try {
        await fetch('https://api.example.com/update-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dn, oldMail, newMail }),
        });
      } catch (err) {
        this.logger.error(`Failed to sync mail change: ${err}`);
      }
    },
  };
}
```

## Change Detection

### Replace Operations

```javascript
// Before: mail = "old@example.com"
{
  replace: {
    mail: 'new@example.com';
  }
}
// Triggers: onLdapMailChange("uid=user,ou=users,dc=example,dc=com", "old@example.com", "new@example.com")
```

### Add Operations

```javascript
// Before: mail = undefined
{
  add: {
    mail: 'new@example.com';
  }
}
// Triggers: onLdapMailChange("uid=user,ou=users,dc=example,dc=com", null, "new@example.com")
```

### Delete Operations

```javascript
// Before: mail = "old@example.com"
{ delete: ["mail"] }
// Triggers: onLdapMailChange("uid=user,ou=users,dc=example,dc=com", "old@example.com", null)
```

## Performance Considerations

### Hook Execution

- Hooks run **synchronously** within the modify operation
- Slow hooks delay the LDAP response
- Consider async operations with fire-and-forget for non-critical updates

### Optimization Tips

1. **Keep hooks fast**: Defer heavy work to background jobs
2. **Use error handling**: Don't let hook failures block LDAP operations
3. **Batch updates**: If possible, batch multiple hook calls
4. **Cache external state**: Avoid redundant external API calls

## Error Handling

Hooks can throw errors to abort the LDAP modification:

```javascript
hooks: {
  onLdapMailChange: async (dn, oldMail, newMail) => {
    // Validate mail domain
    if (!newMail.endsWith('@company.com')) {
      throw new Error('Mail must be @company.com domain');
    }

    // Update mail server
    try {
      await mailServer.renameAccount(oldMail, newMail);
    } catch (err) {
      throw new Error(`Mail server update failed: ${err.message}`);
    }
  };
}
```

If the hook throws, the LDAP modification is rolled back (if supported by LDAP server).

## Debugging

Enable debug logging to see change detection:

```bash
--log-level debug
```

Output:

```
[debug] Detected mail change for uid=jdoe,ou=users,dc=example,dc=com: old@domain.com → new@domain.com
[debug] Triggering onLdapMailChange hook
[info] onLdapMailChange: Mail account renamed successfully
```

## Limitations

1. **Only monitors modify operations**: Does not detect changes from direct LDAP clients
2. **Requires old value lookup**: Fetches entry before modification for comparison
3. **Single-valued attributes**: Best suited for single-valued attributes like mail
4. **Synchronous execution**: Hooks block the LDAP response

## See Also

- [Twake James Plugin](twakeJames.md) - Mail server integration using onChange
- [ldapFlatGeneric.md](ldapFlatGeneric.md) - Generic LDAP entity management
- [Hooks Documentation](../src/hooks.ts) - All available hooks
