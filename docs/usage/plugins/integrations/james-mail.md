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
--quota-attribute mailQuotaSize \
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
- `--quota-attribute`: LDAP attribute for quota (default: `mailQuotaSize`)
- `--alias-attribute`: LDAP attribute for email aliases (default: `mailAlternateAddress`)
- `--forward-attribute`: LDAP attribute for forwards (default: `mailForwardingAddress`)
- `--james-sync-forwards`: copy that attribute to Twake Mail's forwards (default: `false`), see [Forwards](#forwards)
- `--james-mailbox-type-attribute`: LDAP attribute for mailbox type (default: `twakeMailboxType`)
- `--james-retry-attempts`: attempts in all of a call about a user James may not see yet (default: `5`), see [Replication lag](#replication-lag)
- `--james-retry-delay`: base delay between those attempts, in ms (default: `1000`); the total wait is delay × n(n−1)/2 for n attempts

## How It Works

### Mailing Lists

Mailing lists are not synchronized: Twake Mail reads them from LDAP, see
[Mailing lists](james-mailboxes.md#mailing-lists). Groups whose
`twakeMailboxType` is `teamMailbox` become James team mailboxes, see
[James Team Mailboxes](james-mailboxes.md).

### Groups

James has accounts for users only. An entry whose classes include
`groupOfNames`, `groupOfUniqueNames` or `groupOfURLs` is a group: the plugin
creates no identity, quota, alias, forward or delegation for its address, and
does not rename it in James when its `mail` changes. Its address is a mailing
list or a team mailbox, as above.

A deployment whose groups (`--group-class`) carry none of these classes has
its groups handled as users. So is an entry whose classes cannot be read when
the change is followed.

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

4. **James** renames the mail account and its mailboxes, and adds a forward
   from the old address to the new one, so that mail sent to the old address
   still arrives. It leaves the identities under the old address.

5. **James plugin** moves the aliases (see
   [Aliases and Mail Changes](#aliases-and-mail-changes)) and gives the new
   address its [default identity](#display-name-and-identity) back, with the
   signatures of the old one when `--james-signature-template` is not set.

#### Forwards Left on an Address

The forward a rename leaves outlives the account. When an address becomes the
`mail` or an alias of an account, at its creation, a rename, a mail added to
an existing entry or an alias add, the plugin removes the forwards James holds
from it, except the entry's own (`--forward-attribute`):

```http
GET /address/forwards/old@company.com
DELETE /address/forwards/old@company.com/targets/john.doe@company.com
```

Otherwise the new owner of the address would not get its mail.

### Quota Changes

When a user's quota changes:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "mailQuotaSize": "5000000000"
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

### Forwards

Forwards are a setting of the user in Twake Mail, beside "keep a copy in my
mailbox", and Twake Mail Admin can change them too. The plugin leaves them
alone by default.

With `--james-sync-forwards`, the directory owns them: each change of
`--forward-attribute` is applied to Twake Mail, and overwrites what the user
set there.

```http
PUT /address/forwards/jdoe@company.com/targets/john@partner.com
DELETE /address/forwards/jdoe@company.com/targets/old@partner.com
```

Only the change is applied: a forward the user added in Twake Mail stays
until the directory names it and removes it, and the directory is never told
about the forwards set in Twake Mail.

### Display Name and Identity

When a user is added, renamed, or their display name changes, the plugin names
their default identity in Twake Mail after the directory. The name is the first
one found in `--display-name-attribute` (`displayName` by default), `cn`, then
`givenName` and `sn`. The optional signature is `--james-signature-template`.

1. **James plugin** reads the default identity, the deletable one with the
   lowest `sortOrder`:

   ```http
   GET /users/jdoe@company.com/identities?default=true
   ```

2. It updates that identity, or creates it when the user has none (404):

   ```http
   PUT /users/jdoe@company.com/identities/{id}
   POST /users/jdoe@company.com/identities
   {"email": "jdoe@company.com", "name": "John Doe", "sortOrder": 0}
   ```

The server-set identity, which James derives from the address and which
cannot be deleted, is left alone: an update of it makes Twake Mail add a
second identity for the same address, named "givenName sn". Calls for one
address run one after the other, so that the two hooks an add fires create a
single identity.

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

   James forwards the old address to the new one, see
   [Forwards Left on an Address](#forwards-left-on-an-address).

#### Active Directory Format Support

The plugin supports Active Directory's `proxyAddresses` format:

```ldap
proxyAddresses: smtp:john@company.com
proxyAddresses: smtp:j.doe@company.com
proxyAddresses: SMTP:john.doe@company.com
```

The `smtp:` prefix is automatically stripped. The capitalization (SMTP vs smtp) is ignored - only the email address after the colon is used.

## REST API

The James plugin exposes a REST API to retrieve quota usage and limits for users.

### GET /api/v1/users/:user/quota-usage

Retrieve quota usage and limits for a user from James. This endpoint returns both the quota limits configured for the user and their current mailbox usage.

**Request:**

```bash
GET /api/v1/users/jdoe/quota-usage
```

**Response (200 OK):**

```json
{
  "global": { "count": 1000, "size": 1000000000 },
  "domain": { "count": 800, "size": 800000000 },
  "user": { "count": 500, "size": 75000000 },
  "computed": { "count": 500, "size": 75000000 },
  "occupation": {
    "size": 50000000,
    "count": 250,
    "ratio": {
      "size": 0.67,
      "count": 0.5,
      "max": 0.67
    }
  }
}
```

**Response Fields:**

- `global`: Global quota limit (server-wide)
- `domain`: Domain-specific quota limit
- `user`: User-specific quota limit from LDAP
- `computed`: Effective quota limit applied (resolved from upper values)
- `occupation`: **Current mailbox usage statistics**
  - `size`: Storage currently used (bytes)
  - `count`: Number of messages in mailbox
  - `ratio`: Usage ratios (used / limit)

**Error Responses:**

- `404`: User not found in LDAP or quota not found in James
- `400`: User has no mail attribute
- `502`: Failed to retrieve quota from James
- `500`: Internal server error

**Example:**

```bash
# Get quota usage for user 'jdoe'
curl http://localhost:8081/api/v1/users/jdoe/quota-usage \
  -H "Authorization: Bearer admin-token"
```

## Public Methods

Public methods available on the James plugin instance. Useful for building GDPR workflows, custom integrations, or calling from other plugins.

### Usage

```typescript
import type { DM } from 'ldap-rest';
import type James from 'ldap-rest/plugin-twake-james';

// Get the James plugin instance
const james = server.getPlugin('james') as James;
```

### deleteUserData(mail, fromStep?)

Delete all user data via James WebAdmin API. Useful for GDPR "right to be forgotten" compliance.

**Signature:**

```typescript
async deleteUserData(mail: string, fromStep?: string): Promise<{ taskId: string } | null>
```

**Parameters:**

- `mail` (string): User's email address
- `fromStep` (string, optional): Resume deletion from a specific step if a previous attempt failed

**Returns:** Task information with `taskId`, or `null` on error.

**Example:**

```typescript
const result = await james.deleteUserData('user@example.com');
if (result) {
  console.log(`Deletion task started: ${result.taskId}`);
}

// Resume from a failed step
const resumed = await james.deleteUserData(
  'user@example.com',
  'DeleteMailboxesStep'
);
```

**Reference:** [James deleteData API](https://james.apache.org/server/manage-webadmin.html#delete-data-of-a-user)

---

### getMailFromDN(dn)

Retrieve the email address for a user given their LDAP DN.

**Signature:**

```typescript
async getMailFromDN(dn: string): Promise<string | null>
```

**Parameters:**

- `dn` (string): LDAP Distinguished Name of the user

**Returns:** Email address string, or `null` if not found.

**Example:**

```typescript
const mail = await james.getMailFromDN('uid=jdoe,ou=users,dc=example,dc=com');
// Returns: "jdoe@example.com"
```

---

### getDisplayNameFromDN(dn)

Retrieve the display name for a user given their LDAP DN. Uses fallback logic: `displayName` → `cn` → `givenName sn` → `mail`.

**Signature:**

```typescript
async getDisplayNameFromDN(dn: string): Promise<string | null>
```

**Parameters:**

- `dn` (string): LDAP Distinguished Name of the user

**Returns:** Display name string, or `null` if not found.

**Example:**

```typescript
const name = await james.getDisplayNameFromDN(
  'uid=jdoe,ou=users,dc=example,dc=com'
);
// Returns: "John Doe"
```

---

### generateSignature(dn)

Generate an HTML email signature for a user using the configured template (`--james-signature-template`).

**Signature:**

```typescript
async generateSignature(dn: string): Promise<string | null>
```

**Parameters:**

- `dn` (string): LDAP Distinguished Name of the user

**Returns:** HTML signature string with placeholders replaced, or `null` if no template configured.

**Example:**

```typescript
// With template: "<p>{displayName}</p><p>{title} - {department}</p>"
const signature = await james.generateSignature(
  'uid=jdoe,ou=users,dc=example,dc=com'
);
// Returns: "<p>John Doe</p><p>Engineer - IT</p>"
```

---

### updateJamesIdentity(dn, mail, displayName, signatures?)

Update a user's JMAP identity in James (name and optional signature).

**Signature:**

```typescript
async updateJamesIdentity(
  dn: string,
  mail: string,
  displayName: string,
  signatures?: { htmlSignature?: string; textSignature?: string }
): Promise<void>
```

**Parameters:**

- `dn` (string): LDAP Distinguished Name (used for signature generation)
- `mail` (string): User's email address
- `displayName` (string): New display name for the identity
- `signatures` (object, optional): written when `--james-signature-template`
  is not set

**Example:**

```typescript
await james.updateJamesIdentity(
  'uid=jdoe,ou=users,dc=example,dc=com',
  'jdoe@example.com',
  'John Doe'
);
```

---

### getMemberEmails(memberDns)

Retrieve email addresses for multiple LDAP members. Useful for bulk operations on groups.

**Signature:**

```typescript
async getMemberEmails(memberDns: string[]): Promise<string[]>
```

**Parameters:**

- `memberDns` (string[]): Array of LDAP Distinguished Names

**Returns:** Array of email addresses (excludes members without mail attribute).

**Example:**

```typescript
const emails = await james.getMemberEmails([
  'uid=alice,ou=users,dc=example,dc=com',
  'uid=bob,ou=users,dc=example,dc=com',
]);
// Returns: ["alice@example.com", "bob@example.com"]
```

---

### getGroupMail(groupDn)

Retrieve the email address for a group given its LDAP DN.

**Signature:**

```typescript
async getGroupMail(groupDn: string): Promise<string | null>
```

**Parameters:**

- `groupDn` (string): LDAP Distinguished Name of the group

**Returns:** Group email address, or `null` if not found.

**Example:**

```typescript
const mail = await james.getGroupMail(
  'cn=engineering,ou=groups,dc=example,dc=com'
);
// Returns: "engineering@example.com"
```

---

### getGroupMailboxType(groupDn)

Retrieve the mailbox type for a group (mailing list, team mailbox, or simple group).

**Signature:**

```typescript
async getGroupMailboxType(groupDn: string): Promise<'group' | 'mailingList' | 'teamMailbox' | null>
```

**Parameters:**

- `groupDn` (string): LDAP Distinguished Name of the group

**Returns:** Mailbox type string, or `null` if not determinable.

**Example:**

```typescript
const type = await james.getGroupMailboxType(
  'cn=engineering,ou=groups,dc=example,dc=com'
);
// Returns: "mailingList" or "teamMailbox" or "group"
```

## James WebAdmin API

### Endpoints Used

| Operation         | Endpoint                                   | Method |
| ----------------- | ------------------------------------------ | ------ |
| Rename account    | `/users/{old}/rename/{new}?action=rename`  | POST   |
| Update quota      | `/quota/users/{mail}/size`                 | PUT    |
| Get quota         | `/quota/users/{mail}`                      | GET    |
| Add delegation    | `/users/{mail}/authorizedUsers/{delegate}` | PUT    |
| Remove delegation | `/users/{mail}/authorizedUsers/{delegate}` | DELETE |
| Add alias         | `/address/aliases/{mail}/sources/{alias}`  | PUT    |
| Remove alias      | `/address/aliases/{mail}/sources/{alias}`  | DELETE |
| List forwards     | `/address/forwards/{mail}`                 | GET    |
| Remove forward    | `/address/forwards/{mail}/targets/{to}`    | DELETE |

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
--quota-attribute mailQuotaSize \
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
--quota-attribute mailQuotaSize \
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

### Replication lag

James reads its users from LDAP, and may read them from a replica that has
not received the latest write yet: for up to a few seconds after a user is
created or renamed, James does not know the new address. A call about that
address fails meanwhile, with 400 (rename) or 404 (quota, alias, identity).

The calls that need James to know the user are therefore retried on 400 and
404: the rename, the quota, an alias or a forward added, a delegation added,
and the identity. Each failed attempt logs a warning
(`"result": "retry"`, with the attempt number); the error is logged when the
last attempt fails. With the defaults, 5 attempts, the waits are 1, 2, 3 and
4 seconds: `--james-retry-delay` times the number of attempts made, so
`--james-retry-delay` × n(n−1)/2 in all for n attempts: 10 seconds with the
defaults, 190 seconds with 20 attempts. `--james-retry-attempts 1` disables
the retries. Other
failures, such as 401 or 500, are not retried, nor are deletions.

The team mailbox calls are not retried: their member routes do not check
the user in James's users repository; their only 404 is a missing team
mailbox, which is avoided by creating it before adding the members.

The retries run in the background, after the LDAP write has answered; a
call waiting for its next attempt does not take a slot of
`--james-concurrency`.

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
  -d '{"replace": {"mailQuotaSize": "5000000000"}}'

# Verify in James
curl http://james:8000/quota/users/jdoe@company.com/size
```

## Quota Format

Quota values are in **bytes**:

| Size      | Bytes       | Example                          |
| --------- | ----------- | -------------------------------- |
| 1 GB      | 1000000000  | `"mailQuotaSize": "1000000000"`  |
| 5 GB      | 5000000000  | `"mailQuotaSize": "5000000000"`  |
| 10 GB     | 10000000000 | `"mailQuotaSize": "10000000000"` |
| Unlimited | -1          | `"mailQuotaSize": "-1"`          |

## Synchronization Scenarios

### Scenario 1: User Creation

1. Create user in LDAP with mail attribute: James reads its users from LDAP
2. James plugin sets the quota, the aliases and the default identity, after
   dropping the [forwards left](#forwards-left-on-an-address) on its addresses
3. A mail added later to an existing entry is handled the same way
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

## Limitations

1. **One-way sync**: LDAP → James only. James changes don't sync back to LDAP.
2. **No account creation**: Plugin doesn't create James accounts, only updates existing ones.
3. **No user deletion**: deleting an LDAP user leaves its James data (mailboxes, quota, aliases) as it is; purging it is left to James.
4. **Synchronous**: James API calls block LDAP response. Slow James = slow LDAP.

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
   --quota-attribute mailQuotaSize
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
