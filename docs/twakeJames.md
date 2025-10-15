# Twake James Mail Server Plugin

Synchronize LDAP user changes with Apache James mail server via WebAdmin API.

## Overview

The `twake/james` plugin automatically synchronizes email address and quota changes from LDAP to [Apache James](https://james.apache.org/) mail server. It listens to `onChange` hooks and updates James via its WebAdmin REST API.

## Prerequisites

1. **Apache James** mail server with WebAdmin API enabled
2. **onChange plugin** loaded to detect LDAP changes
3. **Mail and quota attributes** configured in LDAP schema

## Configuration

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/james \
--ldap-flat-schema ./static/schemas/twake/users.json \
--mail-attribute mail \
--quota-attribute mailQuota \
--james-webadmin-url http://james:8000 \
--james-webadmin-token "your-admin-token"
```

**Environment Variables:**

```bash
DM_JAMES_WEBADMIN_URL="http://james:8000"
DM_JAMES_WEBADMIN_TOKEN="your-admin-token"
```

### Parameters

- `--james-webadmin-url`: James WebAdmin API base URL (required)
- `--james-webadmin-token`: Bearer token for James WebAdmin authentication (optional)
- `--mail-attribute`: LDAP attribute for email (default: `mail`)
- `--quota-attribute`: LDAP attribute for quota (default: `mailQuota`)
- `--alias-attribute`: LDAP attribute for email aliases (default: `mailAlternateAddress`)
- `--james-mailbox-type-attribute`: LDAP attribute for mailbox type (default: `twakeMailboxType`)

## How It Works

### Mailing Lists

When a group with a `mail` attribute is created or modified:

1. **Create mailing list**

   ```bash
   POST /api/v1/ldap/groups
   {
     "cn": "engineering",
     "mail": "engineering@company.com",
     "member": [
       "uid=alice,ou=users,dc=example,dc=com",
       "uid=bob,ou=users,dc=example,dc=com"
     ]
   }
   ```

2. **James plugin** creates address group and adds all members:

   ```http
   PUT /address/groups/engineering@company.com/alice@company.com
   PUT /address/groups/engineering@company.com/bob@company.com
   ```

3. **Add/remove members** - when group members change:

   ```bash
   POST /api/v1/ldap/groups/engineering/members
   {"member": "uid=charlie,ou=users,dc=example,dc=com"}
   ```

   James plugin automatically syncs:

   ```http
   PUT /address/groups/engineering@company.com/charlie@company.com
   ```

4. **Delete mailing list** - when group is deleted:

   ```http
   DELETE /address/groups/engineering@company.com
   ```

**Notes:**

- Only groups with a `mail` attribute are synchronized to James
- Groups without `mail` are ignored (regular LDAP groups)
- James Address Groups are simple distribution lists
- All group members receive emails sent to the group address
- List type attributes (open/restricted) are stored in LDAP but not enforced by James

### Mail Address Changes

When a user's mail attribute changes:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "mail": "john.doe@company.com"
     }
   }
   ```

2. **onChange plugin** detects mail change and triggers `onLdapMailChange` hook

3. **James plugin** receives hook and calls James WebAdmin API:

   ```http
   POST /users/old@company.com/rename/john.doe@company.com?action=rename
   ```

4. **James** renames the mail account and all associated data

### Quota Changes

When a user's quota changes:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "mailQuota": "5000000000"
     }
   }
   ```

2. **onChange plugin** triggers `onLdapQuotaChange` hook

3. **James plugin** updates quota via WebAdmin API:

   ```http
   PUT /quota/users/jdoe@company.com/size
   Content-Type: text/plain

   5000000000
   ```

### Email Aliases Management

The plugin automatically manages email aliases stored in LDAP and syncs them to James.

#### Creating a User with Aliases

When a user is created with aliases:

1. **LDAP add operation**

   ```bash
   POST /api/v1/ldap/users
   {
     "uid": "jdoe",
     "mail": "john.doe@company.com",
     "mailAlternateAddress": [
       "john@company.com",
       "j.doe@company.com"
     ]
   }
   ```

2. **James plugin** creates all aliases in James:

   ```http
   PUT /address/aliases/john.doe@company.com/sources/john@company.com
   PUT /address/aliases/john.doe@company.com/sources/j.doe@company.com
   ```

Emails sent to any alias address will be delivered to `john.doe@company.com`.

#### Modifying Aliases

When aliases are added or removed:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "mailAlternateAddress": [
         "john@company.com",
         "jdoe@company.com"
       ]
     }
   }
   ```

2. **onChange plugin** detects alias changes and triggers `onLdapAliasChange` hook

3. **James plugin** performs diff and updates only changed aliases:

   ```http
   DELETE /address/aliases/john.doe@company.com/sources/j.doe@company.com
   PUT /address/aliases/john.doe@company.com/sources/jdoe@company.com
   ```

#### Aliases and Mail Changes

When the primary email address changes, all aliases are automatically updated:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "mail": "john.smith@company.com"
     }
   }
   ```

2. **James plugin** renames the account and updates alias destinations:

   ```http
   POST /users/john.doe@company.com/rename/john.smith@company.com?action=rename
   DELETE /address/aliases/john.doe@company.com/sources/john@company.com
   PUT /address/aliases/john.smith@company.com/sources/john@company.com
   DELETE /address/aliases/john.doe@company.com/sources/jdoe@company.com
   PUT /address/aliases/john.smith@company.com/sources/jdoe@company.com
   ```

   **Note:** James automatically creates an alias from the old address when renaming a user. The plugin attempts to create this alias explicitly, but handles the 409 Conflict response gracefully if it already exists.

#### Active Directory Format Support

The plugin supports Active Directory's `proxyAddresses` format:

```ldap
proxyAddresses: smtp:john@company.com
proxyAddresses: smtp:j.doe@company.com
proxyAddresses: SMTP:john.doe@company.com
```

The `smtp:` prefix is automatically stripped. The capitalization (SMTP vs smtp) is ignored - only the email address after the colon is used.

## James WebAdmin API

### Endpoints Used

| Operation           | Endpoint                                   | Method |
| ------------------- | ------------------------------------------ | ------ |
| Rename account      | `/users/{old}/rename/{new}?action=rename`  | POST   |
| Update quota        | `/quota/users/{mail}/size`                 | PUT    |
| Add delegation      | `/users/{mail}/authorizedUsers/{delegate}` | PUT    |
| Remove delegation   | `/users/{mail}/authorizedUsers/{delegate}` | DELETE |
| Add alias           | `/address/aliases/{mail}/sources/{alias}`  | PUT    |
| Remove alias        | `/address/aliases/{mail}/sources/{alias}`  | DELETE |
| Add group member    | `/address/groups/{group}/{member}`         | PUT    |
| Remove group member | `/address/groups/{group}/{member}`         | DELETE |
| Delete group        | `/address/groups/{group}`                  | DELETE |

### Authentication

James WebAdmin API can be secured with bearer token authentication:

```bash
--james-webadmin-token "your-admin-token"
```

The plugin automatically adds the `Authorization: Bearer {token}` header to all requests.

**Without token:**

```http
POST /users/old@company.com/rename/new@company.com?action=rename
```

**With token:**

```http
POST /users/old@company.com/rename/new@company.com?action=rename
Authorization: Bearer your-admin-token
```

**Note:** The `action=rename` query parameter is required by James WebAdmin API.

Alternative authentication methods (Basic Auth, JWT) can be configured via reverse proxy.

## Examples

### Example 1: Basic Setup (No Authentication)

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/james \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--james-webadmin-url http://localhost:8000
```

### Example 1b: With Bearer Token

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/james \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--james-webadmin-url http://james:8000 \
--james-webadmin-token "admin-secret-token"
```

### Example 2: With Quota Management

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/james \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--quota-attribute mailQuota \
--james-webadmin-url http://james:8000
```

### Example 3: Complete Twake Setup

```bash
--plugin core/auth/token \
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin core/ldap/groups \
--plugin core/ldap/organization \
--plugin twake/james \
--plugin core/static \
--ldap-flat-schema ./schemas/twake/users.json \
--ldap-flat-schema ./schemas/twake/positions.json \
--mail-attribute mail \
--quota-attribute mailQuota \
--james-webadmin-url http://james:8000 \
--james-webadmin-token "james-admin-token" \
--static-path ./static \
--auth-token "api-admin-token"
```

## Logging

The plugin logs all operations:

### Successful Operations

```json
{
  "level": "info",
  "message": "James operation succeeded",
  "plugin": "james",
  "event": "onLdapMailChange",
  "url": "http://james:8000/users/old@company.com/rename/new@company.com",
  "status": 204,
  "oldmail": "old@company.com",
  "newmail": "new@company.com"
}
```

### Failed Operations

```json
{
  "level": "error",
  "message": "James operation failed",
  "plugin": "james",
  "event": "onLdapMailChange",
  "url": "http://james:8000/users/old@company.com/rename/new@company.com",
  "status": 404,
  "error": "User not found",
  "oldmail": "old@company.com",
  "newmail": "new@company.com"
}
```

## Error Handling

### Non-Existent User

If mail account doesn't exist in James:

```json
{
  "level": "warn",
  "message": "James user not found (expected for new users)",
  "status": 404
}
```

This is normal for new users - create the account in James separately.

### James Server Down

If James WebAdmin is unreachable:

```json
{
  "level": "error",
  "message": "Failed to connect to James",
  "error": "ECONNREFUSED"
}
```

The LDAP operation succeeds, but James is not updated. Manual sync may be required.

### Invalid Quota Value

If quota value is invalid:

```json
{
  "level": "error",
  "message": "Invalid quota value",
  "status": 400,
  "error": "Quota must be a positive integer"
}
```

## Integration Testing

### Test Mail Rename

```bash
# Update mail in LDAP
curl -X PUT http://localhost:8081/api/v1/ldap/users/jdoe \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{"replace": {"mail": "john.doe@company.com"}}'

# Verify in James
curl http://james:8000/users/john.doe@company.com
```

### Test Quota Update

```bash
# Update quota in LDAP
curl -X PUT http://localhost:8081/api/v1/ldap/users/jdoe \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{"replace": {"mailQuota": "5000000000"}}'

# Verify in James
curl http://james:8000/quota/users/jdoe@company.com/size
```

## Quota Format

Quota values are in **bytes**:

| Size      | Bytes       | Example                      |
| --------- | ----------- | ---------------------------- |
| 1 GB      | 1000000000  | `"mailQuota": "1000000000"`  |
| 5 GB      | 5000000000  | `"mailQuota": "5000000000"`  |
| 10 GB     | 10000000000 | `"mailQuota": "10000000000"` |
| Unlimited | -1          | `"mailQuota": "-1"`          |

## Synchronization Scenarios

### Scenario 1: User Creation

1. Create user in LDAP with mail attribute
2. James plugin does nothing (user doesn't exist in James yet)
3. Create mail account in James manually or via provisioning script
4. Future mail/quota changes are synced automatically

### Scenario 2: Mail Address Change

1. User changes email in LDAP: `old@company.com` → `new@company.com`
2. James plugin renames account in James
3. All mail data (inbox, sent, folders) is preserved
4. Old address is no longer valid

### Scenario 3: Quota Increase

1. Admin increases user quota in LDAP: `1GB` → `5GB`
2. James plugin updates quota in James
3. User can now receive more email

### Scenario 4: Quota Decrease

1. Admin decreases user quota in LDAP: `5GB` → `1GB`
2. James plugin updates quota in James
3. If user is over new quota, James may block incoming mail
4. User must delete mail to get under quota

## Mailing List Examples

### Creating a Mailing List

```bash
# Create a group with mail attribute
curl -X POST http://localhost:8081/api/v1/ldap/groups \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "cn": "engineering",
    "mail": "engineering@company.com",
    "member": [
      "uid=alice,ou=users,dc=example,dc=com",
      "uid=bob,ou=users,dc=example,dc=com"
    ],
    "twakeDepartmentLink": "ou=organization,dc=example,dc=com",
    "twakeDepartmentPath": "Engineering"
  }'
```

The James plugin automatically creates the mailing list and adds all members.

### Adding a Member

```bash
# Add member to existing group
curl -X POST http://localhost:8081/api/v1/ldap/groups/engineering/members \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{"member": "uid=charlie,ou=users,dc=example,dc=com"}'
```

James is automatically updated to include charlie@company.com in the distribution list.

### Removing a Member

```bash
# Remove member from group
curl -X DELETE http://localhost:8081/api/v1/ldap/groups/engineering/members/uid=alice,ou=users,dc=example,dc=com \
  -H "Authorization: Bearer admin-token"
```

James removes alice@company.com from the mailing list.

### Deleting a Mailing List

```bash
# Delete the entire group
curl -X DELETE http://localhost:8081/api/v1/ldap/groups/engineering \
  -H "Authorization: Bearer admin-token"
```

James deletes the entire address group.

## Limitations

1. **One-way sync**: LDAP → James only. James changes don't sync back to LDAP.
2. **No account creation**: Plugin doesn't create James accounts, only updates existing ones.
3. **No user deletion**: Plugin doesn't delete James accounts when LDAP users are deleted.
4. **Synchronous**: James API calls block LDAP response. Slow James = slow LDAP.
5. **No send restrictions**: James doesn't enforce list type restrictions (open/member/owner-only). These are metadata in LDAP only.

## Advanced Configuration

### Custom James Attributes

Extend the plugin for custom James operations:

```typescript
import James from './plugins/twake/james';

class CustomJames extends James {
  hooks = {
    ...super.hooks,
    onLdapDepartmentChange: async (dn, oldDept, newDept) => {
      // Custom logic for department changes
      await this._try(
        'onLdapDepartmentChange',
        `${this.config.james_webadmin_url}/users/${mail}/metadata/department`,
        'PUT',
        dn,
        newDept,
        { oldDept, newDept }
      );
    },
  };
}
```

### Async Operations

For high-latency James servers, consider async operations:

```typescript
hooks: {
  onLdapMailChange: async (dn, oldMail, newMail) => {
    // Fire and forget - don't block LDAP response
    setImmediate(async () => {
      try {
        await jamesClient.renameUser(oldMail, newMail);
      } catch (err) {
        logger.error('Failed to sync mail change', err);
      }
    });
  };
}
```

## Troubleshooting

### Problem: Changes Not Syncing

**Solutions:**

1. Verify onChange plugin is loaded:

   ```bash
   --plugin core/ldap/onChange
   ```

2. Check mail/quota attributes configured:

   ```bash
   --mail-attribute mail
   --quota-attribute mailQuota
   ```

3. Enable debug logging:

   ```bash
   --log-level debug
   ```

4. Verify James URL is correct:
   ```bash
   curl http://james:8000/healthcheck
   ```

### Problem: 404 Errors

**Symptoms:**

```json
{ "level": "warn", "message": "James user not found", "status": 404 }
```

**Solutions:**

1. Create mail account in James first
2. Verify mail address matches between LDAP and James
3. Check James logs for account existence

### Problem: Slow LDAP Responses

**Symptoms:**
LDAP modify operations take several seconds.

**Solutions:**

1. Check James WebAdmin performance
2. Implement async operations (fire and forget)
3. Use local James instance (avoid network latency)
4. Add timeout to James API calls

## See Also

- [onChange.md](onChange.md) - LDAP change detection
- [ldapFlatGeneric.md](ldapFlatGeneric.md) - Schema-driven LDAP management
- [Apache James Documentation](https://james.apache.org/server/manage-webadmin.html) - WebAdmin API reference
