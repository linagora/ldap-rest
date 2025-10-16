# Twake Applicative Accounts API Plugin

RESTful API for managing applicative accounts (device/app-specific accounts) for users.

## Overview

The `twake/appAccountsApi` plugin provides API endpoints for creating, listing, and deleting applicative accounts. These are secondary accounts that allow users to have multiple passwords for different devices or applications, each identified by a unique uid (e.g., `username_c12345678`).

Applicative accounts are stored in a separate LDAP branch (e.g., `ou=applicative`) and share the same mail address as the principal user account.

## Why Applicative Accounts?

Instead of using a single primary password to access all services that authenticate via LDAP, the applicative accounts system provides separation of concerns:

### Primary Authentication

- The primary authentication system may not use passwords at all (e.g., smart cards, biometrics, SSO)
- Users authenticate once with their primary credentials (which may be strong 2FA/MFA)
- Primary account remains secure and is not exposed to application protocols

### Application-Specific Accounts

- Dedicated accounts for specific applications or devices
- Each device/app gets its own isolated password
- Essential for protocols that require password authentication: **IMAP**, **SMTP**, **CalDAV**, **CardDAV**, etc.
- Benefits:
  - **Security**: Compromise of one device doesn't expose the primary account
  - **Revocation**: Delete individual app accounts without affecting others
  - **Auditing**: Track which device/app is accessing which service
  - **Device identification**: Each account can be labeled (e.g., "My Phone", "My Laptop")

### Use Cases

1. **Email clients (IMAP/SMTP)**: Create an app account for each device accessing email
2. **Calendar sync (CalDAV)**: Separate credentials for calendar applications
3. **Contact sync (CardDAV)**: Dedicated account for contact synchronization
4. **Legacy applications**: Apps that require password auth but can't use modern auth methods
5. **API access**: Service accounts for automated tools that need LDAP authentication

## Prerequisites

1. **Authentication plugin** loaded (e.g., `core/auth/token`) - **Required**
2. **App accounts consistency plugin** `core/twake/appAccountsConsistency` - **Required**
   - Automatically creates principal accounts (uid=mail@domain.com)
   - Ensures automatic cleanup when users are deleted
   - Synchronizes mail changes across all app accounts
3. **Applicative accounts base** configured in LDAP (e.g., `ou=applicative,dc=example,dc=com`)

## Configuration

```bash
--plugin core/auth/token \
--plugin core/ldap/onChange \
--plugin twake/appAccountsConsistency \
--plugin twake/appAccountsApi \
--auth-token "secret-token" \
--applicative-account-base "ou=applicative,dc=example,dc=com" \
--max-app-accounts 5 \
--mail-attribute mail
```

**Environment Variables:**

```bash
DM_AUTH_TOKEN="secret-token"
DM_APPLICATIVE_ACCOUNT_BASE="ou=applicative,dc=example,dc=com"
DM_MAX_APP_ACCOUNTS=5
DM_MAIL_ATTRIBUTE="mail"
```

### Parameters

- `--applicative-account-base`: LDAP base DN for applicative accounts (required)
- `--max-app-accounts`: Maximum number of app accounts per user (default: 5)
- `--mail-attribute`: LDAP attribute for email (default: `mail`)
- `--api-prefix`: API endpoint prefix (default: `/api`)

## LDAP Structure

### Principal Account

Created automatically by `twake/appAccountsConsistency` plugin when a user with a mail attribute is added:

```
dn: uid=alice@example.com,ou=applicative,dc=example,dc=com
objectClass: inetOrgPerson
uid: alice@example.com
cn: Alice Smith
sn: Smith
mail: alice@example.com
userPassword: {SSHA}hash1...
userPassword: {SSHA}hash2...
userPassword: {SSHA}hash3...
```

The principal account stores multiple passwords (one for each applicative account).

### Applicative Accounts

Created via API:

```
dn: uid=alice_c12345678,ou=applicative,dc=example,dc=com
objectClass: inetOrgPerson
uid: alice_c12345678
cn: Alice Smith
sn: Smith
mail: alice@example.com
userPassword: {SSHA}hash1...
description: My Phone
```

Each applicative account:

- Has a unique uid with format: `{username}_c{8-digits}`
- Shares the same mail as the user
- Has its own password
- Optional description field for device name

## API Endpoints

### List Applicative Accounts

```http
GET /api/v1/users/{username}/app-accounts
Authorization: Bearer {token}
```

**Response:**

```json
[
  {
    "uid": "alice_c12345678",
    "name": "My Phone"
  },
  {
    "uid": "alice_c87654321",
    "name": "My Laptop"
  }
]
```

**Status Codes:**

- `200 OK` - Success
- `401 Unauthorized` - Missing or invalid token
- `404 Not Found` - User not found

### Create Applicative Account

```http
POST /api/v1/users/{username}/app-accounts
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "My Phone"
}
```

**Request Body:**

- `name` (optional): Description/device name

**Response:**

```json
{
  "uid": "alice_c12345678",
  "pwd": "AbC3@-2xYz!-9pQr@-St4v!-mN8#-pQ5$",
  "mail": "alice@example.com"
}
```

**Important**: The password is only returned once during creation. It cannot be retrieved later.

**Status Codes:**

- `200 OK` - Account created
- `400 Bad Request` - Max accounts limit reached or user has no mail
- `401 Unauthorized` - Missing or invalid token
- `404 Not Found` - User not found

### Delete Applicative Account

```http
DELETE /api/v1/users/{username}/app-accounts/{uid}
Authorization: Bearer {token}
```

**Response:**

```json
{
  "uid": "alice_c12345678"
}
```

**Status Codes:**

- `200 OK` - Account deleted (or already deleted - idempotent)
- `401 Unauthorized` - Missing or invalid token
- `403 Forbidden` - UID does not belong to user

## Password Generation

Applicative account passwords are generated automatically with the following characteristics:

- **Format**: 6 blocks of 4 characters separated by `-`
- **Length**: 29 characters total
- **Example**: `AbC3@-2xYz!-9pQr@-St4v!-mN8#-pQ5$`
- **Character classes**: Each block contains:
  - 1 uppercase letter (A-Z, excluding I, L, O)
  - 1 lowercase letter (a-z, excluding i, l, o)
  - 1 digit (2-9)
  - 1 special character (@, !, #, $, %)

Passwords are passed to LDAP in cleartext. OpenLDAP's ppolicy overlay automatically hashes them using SSHA.

## Command-Line Utility

The `sync-app-accounts` utility maintains consistency between user and applicative account branches:

```bash
# Preview changes
sync-app-accounts --dry-run

# Execute synchronization
sync-app-accounts

# Quiet mode (for cron)
sync-app-accounts --quiet

# Show help
sync-app-accounts --help
```

**Operations performed:**

1. **Create missing principal accounts** - For users with mail but no `uid=mail` in applicative base
2. **Delete orphaned applicative accounts** - `username_cXXXXXXXX` entries where username no longer exists
3. **Delete orphaned principal accounts** - `uid=mail` entries where no user has that mail

**Recommended usage:**

```bash
# Add to cron (run nightly)
0 2 * * * /usr/local/bin/sync-app-accounts --quiet
```

## How It Works

### Account Creation Flow

1. Client requests new app account via `POST /api/v1/users/alice/app-accounts`
2. Plugin validates:
   - User exists in LDAP
   - User has mail attribute
   - Max accounts limit not reached
3. Plugin generates:
   - Unique account ID (`c12345678`)
   - Secure random password
4. Plugin creates applicative account in LDAP:
   - `uid=alice_c12345678,ou=applicative,dc=example,dc=com`
   - Copies attributes from user (cn, sn, mail, etc.)
   - Sets generated password
5. Plugin adds password to principal account:
   - `uid=alice@example.com,ou=applicative,dc=example,dc=com`
   - Adds password as additional `userPassword` value
6. Returns credentials to client (only time password is visible)

### Account Deletion Flow

1. Client requests deletion via `DELETE /api/v1/users/alice/app-accounts/alice_c12345678`
2. Plugin validates:
   - UID belongs to user (starts with `alice_`)
3. Plugin retrieves account from LDAP
4. Plugin deletes password from principal account:
   - Removes specific `userPassword` value
5. Plugin deletes applicative account from LDAP
6. Returns success (idempotent - no error if already deleted)

### Authentication Flow

Users can authenticate with:

- **Principal account**: `uid=alice@example.com` + any app account password
- **Applicative account**: `uid=alice_c12345678` + its specific password

This allows revoking a single device's access by deleting its applicative account without affecting other devices.

## Integration Example

### JavaScript/TypeScript

```typescript
import axios from 'axios';

const API_BASE = 'http://localhost:8081/api/v1';
const TOKEN = 'your-api-token';

// List accounts
const accounts = await axios.get(`${API_BASE}/users/alice/app-accounts`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.log(accounts.data);
// [{ uid: "alice_c12345678", name: "My Phone" }]

// Create account
const newAccount = await axios.post(
  `${API_BASE}/users/alice/app-accounts`,
  { name: 'My Laptop' },
  { headers: { Authorization: `Bearer ${TOKEN}` } }
);
console.log(newAccount.data);
// { uid: "alice_c87654321", pwd: "...", mail: "alice@example.com" }

// Delete account
await axios.delete(`${API_BASE}/users/alice/app-accounts/alice_c87654321`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
```

### curl

```bash
# List accounts
curl -H "Authorization: Bearer secret-token" \
  http://localhost:8081/api/v1/users/alice/app-accounts

# Create account
curl -X POST \
  -H "Authorization: Bearer secret-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Phone"}' \
  http://localhost:8081/api/v1/users/alice/app-accounts

# Delete account
curl -X DELETE \
  -H "Authorization: Bearer secret-token" \
  http://localhost:8081/api/v1/users/alice/app-accounts/alice_c12345678
```

## Use Cases

### Mobile App Credentials

Users can create separate credentials for mobile devices:

```bash
# User creates account for phone
POST /api/v1/users/alice/app-accounts
{"name": "iPhone"}

# Returns: { uid: "alice_c11111111", pwd: "..." }

# User enters credentials in phone app
# Phone uses alice@example.com + generated password
```

If phone is lost:

```bash
# Revoke phone access
DELETE /api/v1/users/alice/app-accounts/alice_c11111111

# Other devices continue working
```

### Application-Specific Passwords

Users can create passwords for different applications:

```bash
POST /api/v1/users/alice/app-accounts {"name": "Email Client"}
POST /api/v1/users/alice/app-accounts {"name": "Calendar Sync"}
POST /api/v1/users/alice/app-accounts {"name": "Backup Tool"}
```

Each application gets its own password that can be revoked independently.

### Security Compliance

- Enforce maximum accounts per user
- Track which devices have access (via description)
- Revoke compromised credentials without resetting main password
- Audit trail via LDAP change logs

## Security Considerations

1. **Password Visibility**: Generated passwords are only returned once during creation. Store them securely on the client side.

2. **Token Protection**: API requires bearer token authentication. Keep tokens secure and rotate regularly.

3. **Account Limits**: Configure `max_app_accounts` based on your security policy to prevent abuse.

4. **Password Policy**: Ensure OpenLDAP ppolicy overlay is configured to enforce password hashing and quality requirements.

5. **Audit Logging**: Enable `weblogs` plugin to track account creation/deletion:

   ```bash
   --plugin core/weblogs
   ```

6. **HTTPS**: Always use HTTPS in production to protect passwords in transit.

## Troubleshooting

### "User not found" error

**Cause**: User doesn't exist in LDAP or username incorrect

**Solution**: Verify user exists:

```bash
ldapsearch -x -b "dc=example,dc=com" "(uid=alice)"
```

### "User has no mail attribute" error

**Cause**: User entry missing mail attribute

**Solution**: Add mail to user:

```bash
PUT /api/v1/ldap/users/alice
{"mail": "alice@example.com"}
```

### "Maximum number of accounts reached" error

**Cause**: User already has max_app_accounts applicative accounts

**Solution**: Delete unused accounts or increase limit:

```bash
DELETE /api/v1/users/alice/app-accounts/alice_c11111111
```

### Principal account not created

**Cause**: `twake/appAccountsConsistency` plugin not loaded

**Solution**: Load plugin before `appAccountsApi`:

```bash
--plugin twake/appAccountsConsistency \
--plugin twake/appAccountsApi
```

### Password rejected by LDAP

**Cause**: OpenLDAP ppolicy configuration issue

**Solution**: Check ppolicy configuration:

```bash
ldapsearch -x -LLL -b "cn=config" "(objectClass=olcPPolicyConfig)"
```

Ensure `olcPPolicyHashCleartext: TRUE` is set.

## Dependencies

This plugin requires:

1. **authToken plugin** (or another auth plugin) - For API authentication
2. **twake/appAccountsConsistency plugin** - For automatic principal account creation

Optional:

- **core/ldap/onChange plugin** - Already required by appAccountsConsistency

## Related Plugins

- **[twake/appAccountsConsistency](./appAccountsConsistency.md)** - Automatic principal account creation
- **[authentication](./authentication.md)** - API authentication
- **[onChange](./onChange.md)** - LDAP change detection

## See Also

- [REST API Reference](./api/REST_API.md)
- [Developer Guide](./DEVELOPER_GUIDE.md)
- [Plugin Dependencies](./PLUGIN_DEPENDENCIES.md)
