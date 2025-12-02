# Password Policy Plugin

The `passwordPolicy` plugin provides a REST API for managing OpenLDAP password policies (ppolicy overlay). It allows administrators to monitor password expiration, manage locked accounts, and optionally validate password complexity.

## Overview

This plugin acts as an administration interface for OpenLDAP's ppolicy overlay. It provides:

- Password status monitoring (expiration, lockout, grace logins)
- Account unlock functionality
- List users with expiring passwords
- List locked accounts
- Optional local password complexity validation

**Note:** ldap-rest is an administration backend. Users authenticate directly against OpenLDAP, not through ldap-rest. This plugin exposes ppolicy attributes via REST API for administrative purposes.

## Prerequisites

- OpenLDAP configured with the **ppolicy overlay**
- A password policy entry (pwdPolicy objectClass) in your LDAP directory

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/passwordPolicy \
--ppolicy-default-dn "cn=default,ou=policies,dc=example,dc=com" \
--ppolicy-warn-days 14
```

### Configuration Options

| Argument               | Environment Variable    | Default       | Description                                       |
| ---------------------- | ----------------------- | ------------- | ------------------------------------------------- |
| `--ppolicy-default-dn` | `DM_PPOLICY_DEFAULT_DN` | (auto-detect) | DN of the default password policy entry           |
| `--ppolicy-warn-days`  | `DM_PPOLICY_WARN_DAYS`  | `14`          | Days before expiration to flag as "expiring soon" |
| `--ldap-users-base`    | `DM_LDAP_USERS_BASE`    | `{ldap_base}` | Base DN for user searches                         |

### Optional Complexity Validation

Enable local password complexity validation (for client-side feedback before submitting to LDAP):

```bash
--ppolicy-validate-complexity true \
--ppolicy-min-length 12 \
--ppolicy-require-uppercase true \
--ppolicy-require-lowercase true \
--ppolicy-require-digit true \
--ppolicy-require-special true
```

| Argument                        | Environment Variable             | Default | Description                        |
| ------------------------------- | -------------------------------- | ------- | ---------------------------------- |
| `--ppolicy-validate-complexity` | `DM_PPOLICY_VALIDATE_COMPLEXITY` | `false` | Enable /password/validate endpoint |
| `--ppolicy-min-length`          | `DM_PPOLICY_MIN_LENGTH`          | `12`    | Minimum password length            |
| `--ppolicy-require-uppercase`   | `DM_PPOLICY_REQUIRE_UPPERCASE`   | `true`  | Require uppercase letter           |
| `--ppolicy-require-lowercase`   | `DM_PPOLICY_REQUIRE_LOWERCASE`   | `true`  | Require lowercase letter           |
| `--ppolicy-require-digit`       | `DM_PPOLICY_REQUIRE_DIGIT`       | `true`  | Require digit                      |
| `--ppolicy-require-special`     | `DM_PPOLICY_REQUIRE_SPECIAL`     | `true`  | Require special character          |

## REST API

### Get Password Policy Configuration

```http
GET /api/v1/password-policy
```

Returns the current ppolicy configuration from LDAP.

**Response (200):**

```json
{
  "dn": "cn=default,ou=policies,dc=example,dc=com",
  "pwdMaxAge": 7776000,
  "pwdMinAge": 0,
  "pwdInHistory": 5,
  "pwdCheckQuality": 2,
  "pwdMinLength": 12,
  "pwdMaxFailure": 5,
  "pwdLockout": true,
  "pwdLockoutDuration": 900,
  "pwdGraceAuthNLimit": 3,
  "pwdExpireWarning": 604800,
  "pwdMustChange": true,
  "pwdAllowUserChange": true
}
```

### Get User Password Status

```http
GET /api/v1/users/{id}/password-status
```

**Path Parameter:**

- `id`: User uid or full DN (URL-encoded if DN)

**Examples:**

```bash
# Get by uid
curl "http://localhost:8081/api/v1/users/john.doe/password-status"

# Get by full DN
curl "http://localhost:8081/api/v1/users/uid%3Djohn.doe%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom/password-status"
```

**Response (200):**

```json
{
  "dn": "uid=john.doe,ou=users,dc=example,dc=com",
  "passwordSet": true,
  "lastChanged": "2024-01-15T10:30:00.000Z",
  "expiresAt": "2024-04-14T10:30:00.000Z",
  "daysUntilExpiration": 45,
  "isExpired": false,
  "isExpiringSoon": false,
  "mustChange": false,
  "isLocked": false,
  "lockedAt": null,
  "failureCount": 0,
  "graceLoginsUsed": 0
}
```

**Response (404):**

```json
{
  "error": "User not found: john.doe"
}
```

### Unlock User Account

```http
POST /api/v1/users/{id}/unlock
```

Unlocks a locked account by removing `pwdAccountLockedTime` and `pwdFailureTime` attributes.

**Path Parameter:**

- `id`: User uid or full DN

**Example:**

```bash
curl -X POST "http://localhost:8081/api/v1/users/john.doe/unlock"
```

**Response (200):**

```json
{
  "success": true,
  "message": "Account unlocked"
}
```

### List Users with Expiring Passwords

```http
GET /api/v1/password-policy/expiring-soon
```

**Query Parameters:**

- `days` (optional): Number of days to look ahead (default: value of `--ppolicy-warn-days` or 14)

**Example:**

```bash
curl "http://localhost:8081/api/v1/password-policy/expiring-soon?days=7"
```

**Response (200):**

```json
{
  "warningDays": 7,
  "users": [
    {
      "dn": "uid=alice,ou=users,dc=example,dc=com",
      "uid": "alice",
      "displayName": "Alice Smith",
      "mail": "alice@example.com",
      "expiresAt": "2024-02-20T14:30:00.000Z",
      "daysUntilExpiration": 3
    },
    {
      "dn": "uid=bob,ou=users,dc=example,dc=com",
      "uid": "bob",
      "displayName": "Bob Jones",
      "mail": "bob@example.com",
      "expiresAt": "2024-02-22T09:15:00.000Z",
      "daysUntilExpiration": 5
    }
  ]
}
```

### List Locked Accounts

```http
GET /api/v1/password-policy/locked-accounts
```

**Example:**

```bash
curl "http://localhost:8081/api/v1/password-policy/locked-accounts"
```

**Response (200):**

```json
{
  "accounts": [
    {
      "dn": "uid=charlie,ou=users,dc=example,dc=com",
      "uid": "charlie",
      "displayName": "Charlie Brown",
      "mail": "charlie@example.com",
      "lockedAt": "2024-02-15T08:45:00.000Z",
      "failureCount": 5
    }
  ]
}
```

### Validate Password Complexity

Only available when `--ppolicy-validate-complexity true` is set.

```http
POST /api/v1/password/validate
```

**Request Body:**

```json
{
  "password": "MySecureP@ssw0rd!"
}
```

**Response (200) - Valid:**

```json
{
  "valid": true,
  "errors": []
}
```

**Response (200) - Invalid:**

```json
{
  "valid": false,
  "errors": [
    "Minimum 12 characters required",
    "At least one special character required"
  ]
}
```

**Response (400):**

```json
{
  "error": "password required"
}
```

## OpenLDAP ppolicy Attributes

The plugin reads these operational attributes from user entries:

| Attribute              | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `pwdChangedTime`       | When password was last changed                      |
| `pwdAccountLockedTime` | When account was locked (000001010000Z = permanent) |
| `pwdFailureTime`       | Timestamps of failed authentication attempts        |
| `pwdGraceUseTime`      | Timestamps of grace logins used                     |
| `pwdReset`             | TRUE if password was reset by admin (must change)   |
| `pwdPolicySubentry`    | DN of applied password policy                       |

And these configuration attributes from the ppolicy entry:

| Attribute            | Description                                 |
| -------------------- | ------------------------------------------- |
| `pwdMaxAge`          | Password expiration time in seconds         |
| `pwdMinAge`          | Minimum password age in seconds             |
| `pwdInHistory`       | Number of passwords kept in history         |
| `pwdCheckQuality`    | Password quality check level (0-2)          |
| `pwdMinLength`       | Minimum password length                     |
| `pwdMaxFailure`      | Failed attempts before lockout              |
| `pwdLockout`         | TRUE to enable account lockout              |
| `pwdLockoutDuration` | Lockout duration in seconds (0 = permanent) |
| `pwdGraceAuthNLimit` | Grace logins after password expires         |
| `pwdExpireWarning`   | Warning period in seconds                   |
| `pwdMustChange`      | TRUE to require password change after reset |
| `pwdAllowUserChange` | TRUE to allow users to change password      |

## Examples

### Example 1: Monitor Expiring Passwords (cron job)

```bash
#!/bin/bash
# Send alerts for passwords expiring within 7 days

USERS=$(curl -s "http://localhost:8081/api/v1/password-policy/expiring-soon?days=7" | jq -r '.users[] | "\(.mail) expires in \(.daysUntilExpiration) days"')

if [ -n "$USERS" ]; then
  echo "$USERS" | mail -s "Password Expiration Warning" admin@example.com
fi
```

### Example 2: Unlock Multiple Accounts

```bash
#!/bin/bash
# Unlock all currently locked accounts

LOCKED=$(curl -s "http://localhost:8081/api/v1/password-policy/locked-accounts" | jq -r '.accounts[].uid')

for uid in $LOCKED; do
  echo "Unlocking $uid..."
  curl -X POST "http://localhost:8081/api/v1/users/$uid/unlock"
done
```

### Example 3: Pre-validate Password in UI

```javascript
async function validatePassword(password) {
  const response = await fetch('/api/v1/password/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  const result = await response.json();

  if (!result.valid) {
    showErrors(result.errors);
    return false;
  }
  return true;
}
```

## Troubleshooting

### Empty Policy Response

**Problem:** `GET /password-policy` returns `{}`

**Solution:** The ppolicy overlay may not be configured in OpenLDAP, or the ppolicy entry doesn't exist. Configure the overlay and create a pwdPolicy entry:

```ldif
dn: cn=default,ou=policies,dc=example,dc=com
objectClass: pwdPolicy
objectClass: person
cn: default
sn: default
pwdAttribute: userPassword
pwdMaxAge: 7776000
pwdLockout: TRUE
pwdMaxFailure: 5
pwdLockoutDuration: 900
```

### User Not Found

**Problem:** `GET /users/john.doe/password-status` returns 404

**Solution:** Check that:

1. The user exists in LDAP
2. `--ldap-users-base` is correctly configured
3. The uid matches exactly (case-sensitive)

### Cannot Read Operational Attributes

**Problem:** Password status shows null for all dates

**Solution:** Ensure the LDAP bind user has permissions to read operational attributes. These require special ACLs in OpenLDAP:

```
access to attrs=pwdChangedTime,pwdAccountLockedTime,pwdFailureTime,pwdGraceUseTime,pwdReset
    by dn="cn=admin,dc=example,dc=com" read
    by self read
    by * none
```

## Config API Integration

The plugin automatically exports its configuration via the `configApi` plugin. When loaded with `core/ldap/passwordPolicy`, the configuration is available at `GET /api/v1/config`:

```json
{
  "apiPrefix": "/api",
  "ldapBase": "dc=example,dc=com",
  "features": {
    "ldapPasswordPolicy": {
      "name": "ldapPasswordPolicy",
      "enabled": true,
      "endpoints": {
        "getPolicy": "/api/v1/password-policy",
        "getUserStatus": "/api/v1/users/:id/password-status",
        "unlockUser": "/api/v1/users/:id/unlock",
        "getExpiringSoon": "/api/v1/password-policy/expiring-soon",
        "getLockedAccounts": "/api/v1/password-policy/locked-accounts",
        "validatePassword": "/api/v1/password/validate"
      },
      "config": {
        "warnDays": 14,
        "validateComplexity": true,
        "complexityRules": {
          "minLength": 12,
          "requireUppercase": true,
          "requireLowercase": true,
          "requireDigit": true,
          "requireSpecial": true
        }
      },
      "ldapPolicy": {
        "dn": "cn=default,ou=policies,dc=example,dc=com",
        "pwdMaxAge": 7776000,
        "pwdMinLength": 12,
        "pwdLockout": true
      }
    }
  }
}
```

**Note:** The `ldapPolicy` field contains the LDAP ppolicy configuration and is populated after the first request to any passwordPolicy endpoint.

## See Also

- [OpenLDAP ppolicy overlay](https://www.openldap.org/doc/admin24/overlays.html#Password%20Policies)
- [LDAP Users Plugin](./flat-generic.md) - For managing user entries
- [Rate Limiting](../auth/rate-limit.md) - For API rate limiting (separate from LDAP lockout)
- [Config API](../../configuration.md) - For API configuration discovery
