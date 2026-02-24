# Twake Drive (Cozy) Plugin

Synchronize LDAP user changes with Twake Drive (Cozy) via Admin API.

## Overview

The `twake/drive` plugin automatically synchronizes email address and display name changes from LDAP to [Twake Drive](https://twake.app/) (powered by [Cozy](https://cozy.io/)). It listens to `onChange` hooks and updates Cozy instances via the Admin API.

## Prerequisites

1. **Twake Drive / Cozy** instance with Admin API enabled
2. **onChange plugin** loaded to detect LDAP changes
3. **Cozy domain** - either:
   - Per-user attribute in LDAP schema (e.g., `twakeCozyDomain`), or
   - Default domain template configured (e.g., `{uid}.mycompany.cloud`)

## Configuration

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/drive \
--ldap-flat-schema ./static/schemas/twake/users.json \
--mail-attribute mail \
--twake-drive-domain-attribute twakeCozyDomain \
--twake-drive-webadmin-url http://cozy-admin:6060 \
--twake-drive-webadmin-token "your-admin-token"
```

**Environment Variables:**

```bash
DM_TWAKE_DRIVE_WEBADMIN_URL="http://cozy-admin:6060"
DM_TWAKE_DRIVE_WEBADMIN_TOKEN="your-admin-token"
DM_TWAKE_DRIVE_DOMAIN_ATTRIBUTE="twakeCozyDomain"
```

### Parameters

| Parameter                               | Description                                              | Default           |
| --------------------------------------- | -------------------------------------------------------- | ----------------- |
| `--twake-drive-webadmin-url`            | Cozy Admin API base URL (required)                       | -                 |
| `--twake-drive-webadmin-token`          | Bearer token for Cozy Admin authentication               | -                 |
| `--mail-attribute`                      | LDAP attribute for email                                 | `mail`            |
| `--display-name-attribute`              | LDAP attribute for display name                          | `displayName`     |
| `--twake-drive-domain-attribute`        | LDAP attribute storing user's Cozy domain                | `twakeCozyDomain` |
| `--twake-drive-default-domain-template` | Template for Cozy domain (e.g., `{uid}.mycompany.cloud`) | -                 |
| `--twake-drive-concurrency`             | Maximum concurrent API requests                          | `10`              |

## Cozy Domain Resolution

The plugin determines each user's Cozy domain using the following logic:

1. **Per-user attribute** (if present): Use the `twakeCozyDomain` LDAP attribute value
2. **Default template** (fallback): Build domain from template with LDAP attribute placeholders

### Per-user Cozy domain attribute

Users can have an explicit `twakeCozyDomain` attribute for custom domains:

```ldif
dn: uid=jdoe,ou=users,dc=example,dc=com
uid: jdoe
mail: jdoe@example.com
twakeCozyDomain: john-doe.partner.cloud
```

### Default domain template

Configure a template for users without an explicit attribute. Use `{attribute}` placeholders:

```bash
--twake-drive-default-domain-template "{uid}.mycompany.cloud"
```

Users without `twakeCozyDomain` will have their domain built from the template:

- User `uid=jdoe` → Cozy domain `jdoe.mycompany.cloud`

Other template examples:

- `"{mail}"` → use mail attribute directly as domain
- `"{cn}.cloud.example.com"` → use common name

### Combined usage

Both can be used together. The per-user attribute takes precedence:

```ldif
# User with custom domain (uses twakeCozyDomain)
dn: uid=partner1,ou=users,dc=example,dc=com
uid: partner1
twakeCozyDomain: partner1.external.cloud

# Regular user (uses default suffix → jdoe.mycompany.cloud)
dn: uid=jdoe,ou=users,dc=example,dc=com
uid: jdoe
```

## How It Works

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

3. **Drive plugin** receives hook and calls Cozy Admin API:

   ```http
   PATCH /instances/jdoe.mycompany.cloud?Email=john.doe@company.com&FromCloudery=true
   ```

4. **Cozy** updates the instance owner's email address

### Display Name Changes

When a user's display name changes:

1. **LDAP modify operation**

   ```bash
   PUT /api/v1/ldap/users/jdoe
   {
     "replace": {
       "displayName": "John M. Doe"
     }
   }
   ```

2. **onChange plugin** triggers `onLdapDisplayNameChange` hook

3. **Drive plugin** updates Cozy instance:

   ```http
   PATCH /instances/jdoe.mycompany.cloud?PublicName=John%20M.%20Doe&FromCloudery=true
   ```

### Display Name Fallback Logic

If `displayName` is not set, the plugin uses fallback logic:

1. `displayName` attribute (first choice)
2. `cn` (Common Name)
3. `givenName` + `sn` (First Name + Last Name)

## Public Methods

Public methods available on the Drive plugin instance:

### Usage

```typescript
import type { DM } from 'ldap-rest';
import type Drive from 'ldap-rest/plugin-twake-drive';

// Get the Drive plugin instance
const drive = server.getPlugin('drive') as Drive;
```

### getCozyDomain(dn)

Retrieve the Cozy domain for a user given their LDAP DN.

**Signature:**

```typescript
async getCozyDomain(dn: string): Promise<string | null>
```

**Example:**

```typescript
const domain = await drive.getCozyDomain('uid=jdoe,ou=users,dc=example,dc=com');
// Returns: "jdoe.mycompany.cloud"
```

---

### getDisplayNameFromDN(dn)

Retrieve the display name for a user using fallback logic.

**Signature:**

```typescript
async getDisplayNameFromDN(dn: string): Promise<string | null>
```

**Example:**

```typescript
const name = await drive.getDisplayNameFromDN(
  'uid=jdoe,ou=users,dc=example,dc=com'
);
// Returns: "John Doe"
```

---

### getMailFromDN(dn)

Retrieve the email address for a user.

**Signature:**

```typescript
async getMailFromDN(dn: string): Promise<string | null>
```

**Example:**

```typescript
const mail = await drive.getMailFromDN('uid=jdoe,ou=users,dc=example,dc=com');
// Returns: "jdoe@example.com"
```

---

### syncUserToCozy(dn)

Manually synchronize a user's attributes to their Cozy instance. Useful for initial sync or manual refresh.

**Signature:**

```typescript
async syncUserToCozy(dn: string): Promise<boolean>
```

**Example:**

```typescript
const success = await drive.syncUserToCozy(
  'uid=jdoe,ou=users,dc=example,dc=com'
);
if (success) {
  console.log('User synced successfully');
}
```

---

### blockInstance(dn, reason?)

Block a user's Cozy instance with an optional reason.

**Signature:**

```typescript
async blockInstance(dn: string, reason?: string): Promise<boolean>
```

**Parameters:**

- `dn` - User's LDAP DN
- `reason` - Optional blocking reason. Common values:
  - `PAYMENT_FAILED` - Payment issue
  - `LOGIN_FAILED` - Too many failed login attempts
  - `SUSPENDED` - Account suspended by admin
  - Any custom string

**Example:**

```typescript
// Block with reason
await drive.blockInstance(
  'uid=jdoe,ou=users,dc=example,dc=com',
  'PAYMENT_FAILED'
);

// Block without reason
await drive.blockInstance('uid=jdoe,ou=users,dc=example,dc=com');
```

---

### unblockInstance(dn)

Unblock a user's Cozy instance.

**Signature:**

```typescript
async unblockInstance(dn: string): Promise<boolean>
```

**Example:**

```typescript
await drive.unblockInstance('uid=jdoe,ou=users,dc=example,dc=com');
```

## Cozy Admin API

### Endpoints Used

| Operation       | Endpoint                                                                | Method |
| --------------- | ----------------------------------------------------------------------- | ------ |
| Update email    | `/instances/{domain}?Email={email}&FromCloudery=true`                   | PATCH  |
| Update name     | `/instances/{domain}?PublicName={name}&FromCloudery=true`               | PATCH  |
| Combined update | `/instances/{domain}?Email={email}&PublicName={name}&FromCloudery=true` | PATCH  |

### Available Cozy Parameters

The Cozy Admin API supports the following parameters (query string):

| Parameter        | Type    | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `Email`          | string  | Owner email address (supported by this plugin)       |
| `PublicName`     | string  | Display name (supported by this plugin)              |
| `Locale`         | string  | Locale (e.g. `fr`, `en`)                             |
| `Timezone`       | string  | Timezone (e.g. `Europe/Paris`)                       |
| `Phone`          | string  | Phone number                                         |
| `DiskQuota`      | integer | Disk quota in bytes                                  |
| `Blocked`        | bool    | Block or unblock the instance                        |
| `BlockingReason` | string  | Reason code (e.g. `PAYMENT_FAILED`, `LOGIN_FAILED`)  |
| `FromCloudery`   | bool    | Skip Cloudery callback (always true for this plugin) |

See the [Cozy Admin Documentation](https://docs.cozy.io/en/cozy-stack/admin/#patch-instancesdomain) for the complete list.

### FromCloudery Parameter

The `FromCloudery=true` query parameter is always included to:

- Prevent the Cozy stack from sending callback notifications
- Avoid notification loops when changes originate from the LDAP directory
- Indicate the change is administrative (from the cloudery/provisioning system)

### Authentication

The Cozy Admin API uses bearer token authentication:

```bash
--twake-drive-webadmin-token "your-admin-token"
```

The plugin automatically adds the `Authorization: Bearer {token}` header to all requests.

**Note:** The Cozy Admin API typically runs on port 6060 and should be protected at the network level.

## Examples

### Example 1: Basic Setup

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/drive \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--twake-drive-webadmin-url http://cozy-admin:6060
```

### Example 2: With Authentication

```bash
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin twake/drive \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--twake-drive-webadmin-url http://cozy-admin:6060 \
--twake-drive-webadmin-token "cozy-admin-secret"
```

### Example 3: Complete Twake Setup (James + Drive)

```bash
--plugin core/auth/token \
--plugin core/ldap/onChange \
--plugin core/ldap/flatGeneric \
--plugin core/ldap/groups \
--plugin twake/james \
--plugin twake/drive \
--ldap-flat-schema ./schemas/twake/users.json \
--mail-attribute mail \
--quota-attribute mailQuotaSize \
--james-webadmin-url http://james:8000 \
--james-webadmin-token "james-admin-token" \
--twake-drive-webadmin-url http://cozy-admin:6060 \
--twake-drive-webadmin-token "cozy-admin-token" \
--twake-drive-domain-attribute twakeCozyDomain \
--auth-token "api-admin-token"
```

## Logging

The plugin logs all operations:

### Successful Operations

```json
{
  "level": "info",
  "plugin": "drive",
  "event": "onLdapMailChange",
  "result": "success",
  "http_status": 200,
  "dn": "uid=jdoe,ou=users,dc=example,dc=com",
  "cozyDomain": "jdoe.mycompany.cloud",
  "Email": "john.doe@company.com"
}
```

### Skipped Operations

```json
{
  "level": "debug",
  "message": "Skipping mail change for uid=jdoe,...: no Cozy domain attribute (twakeCozyDomain)"
}
```

### Failed Operations

```json
{
  "level": "error",
  "plugin": "drive",
  "event": "onLdapMailChange",
  "result": "error",
  "http_status": 500,
  "http_status_text": "Internal Server Error",
  "dn": "uid=jdoe,ou=users,dc=example,dc=com",
  "cozyDomain": "jdoe.mycompany.cloud"
}
```

### Instance Not Found

```json
{
  "level": "debug",
  "plugin": "drive",
  "event": "onLdapMailChange",
  "result": "ignored",
  "http_status": 404,
  "message": "Cozy instance not found (may not be provisioned yet)"
}
```

## Error Handling

### Non-Existent Instance (404)

If the Cozy instance doesn't exist yet:

- Error is logged at DEBUG level (not ERROR)
- LDAP operation succeeds
- This is normal during user provisioning flow

### Cozy Server Down

If the Cozy Admin API is unreachable:

- Error is logged
- LDAP operation succeeds
- Manual sync may be required later using `syncUserToCozy()`

### Invalid Token

If the admin token is invalid:

- 401 or 403 error is logged
- LDAP operation succeeds
- Check token configuration

## Synchronization Scenarios

### Scenario 1: User Creation

1. Create user in LDAP with `twakeCozyDomain` attribute
2. Provision Cozy instance separately (via cloudery or API)
3. Future mail/name changes are synced automatically
4. Use `syncUserToCozy()` for initial sync if needed

### Scenario 2: Email Change

1. User changes email in LDAP: `old@company.com` → `new@company.com`
2. Drive plugin updates Cozy instance email
3. Cozy updates instance owner's email
4. User receives notifications at new email

### Scenario 3: Name Change

1. Admin updates user's display name in LDAP
2. Drive plugin updates Cozy instance PublicName
3. User's name is updated across Cozy apps

### Scenario 4: Manual Sync

```typescript
// Sync all attributes for a user
const drive = server.getPlugin('drive') as Drive;
await drive.syncUserToCozy('uid=jdoe,ou=users,dc=example,dc=com');
```

## Limitations

1. **One-way sync**: LDAP → Cozy only. Cozy changes don't sync back to LDAP.
2. **No instance creation**: Plugin doesn't create Cozy instances, only updates existing ones.
3. **No user deletion**: Plugin doesn't delete Cozy instances when LDAP users are deleted.
4. **Domain required**: Users must have the `twakeCozyDomain` attribute to be synced.

## Troubleshooting

### Problem: Changes Not Syncing

**Solutions:**

1. Verify onChange plugin is loaded:

   ```bash
   --plugin core/ldap/onChange
   ```

2. Check Cozy domain attribute is set for the user:

   ```bash
   ldapsearch -b "uid=jdoe,ou=users,dc=example,dc=com" twakeCozyDomain
   ```

3. Enable debug logging:

   ```bash
   --log-level debug
   ```

4. Verify Cozy Admin API is reachable:

   ```bash
   curl http://cozy-admin:6060/instances
   ```

### Problem: 404 Errors

**Symptoms:**

```json
{ "level": "debug", "message": "Cozy instance not found" }
```

**Solutions:**

1. Provision Cozy instance for the user first
2. Verify `twakeCozyDomain` attribute matches the actual Cozy domain
3. Check Cozy logs for instance existence

### Problem: Authentication Errors

**Symptoms:**

```json
{ "http_status": 401, "http_status_text": "Unauthorized" }
```

**Solutions:**

1. Verify admin token is correct
2. Check token hasn't expired
3. Ensure Admin API is configured to accept bearer tokens

## Integration with James

When using both James and Drive plugins, email changes are propagated to both services:

```bash
--plugin twake/james \
--plugin twake/drive
```

Both plugins listen to `onLdapMailChange` and update their respective services in parallel.

## See Also

- [onChange.md](onChange.md) - LDAP change detection
- [james-mail.md](james-mail.md) - James mail server integration
- [Cozy Admin Documentation](https://docs.cozy.io/en/cozy-stack/admin/) - Admin API reference
