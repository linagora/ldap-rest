# API Reference

Complete technical reference for the Mini-DM REST API including detailed specifications, data formats, and troubleshooting.

## Table of Contents

- [HTTP Status Codes](#http-status-codes)
- [Request Headers](#request-headers)
- [Response Headers](#response-headers)
- [LDAP Modify Format](#ldap-modify-format)
- [LDAP Attributes Format](#ldap-attributes-format)
- [URL Encoding](#url-encoding)
- [Authentication Methods](#authentication-methods)
- [Troubleshooting](#troubleshooting)

---

## HTTP Status Codes

### Success Codes

| Code | Status | Description | Use Case |
|------|--------|-------------|----------|
| 200 | OK | Request succeeded | GET, PUT, DELETE operations |
| 201 | Created | Resource created successfully | POST operations |

**Example 200 Response:**

```json
{
  "dn": "uid=john.doe,ou=users,dc=example,dc=com",
  "uid": "john.doe",
  "cn": "John Doe"
}
```

**Example 201 Response:**

```json
{
  "success": true,
  "dn": "uid=jane.smith,ou=users,dc=example,dc=com"
}
```

### Client Error Codes

| Code | Status | Description | Common Causes |
|------|--------|-------------|---------------|
| 400 | Bad Request | Invalid request format or data | Missing required fields, invalid attribute values, malformed JSON |
| 401 | Unauthorized | Authentication required or failed | Missing/invalid token, expired credentials |
| 403 | Forbidden | Insufficient permissions | User lacks required LDAP permissions |
| 404 | Not Found | Resource doesn't exist | Invalid DN, deleted resource |
| 409 | Conflict | Resource already exists or state conflict | Duplicate entry, non-empty organization deletion |
| 415 | Unsupported Media Type | Wrong Content-Type header | Missing `application/json` header |

**Example 400 Response:**

```json
{
  "error": "Attribute \"sn\" is required"
}
```

**Example 401 Response:**

```json
{
  "error": "Unauthorized"
}
```

**Example 404 Response:**

```json
{
  "error": "User not found"
}
```

**Example 409 Response:**

```json
{
  "error": "Failed to add user uid=john.doe,ou=users,dc=example,dc=com: Entry Already Exists"
}
```

### Server Error Codes

| Code | Status | Description | Common Causes |
|------|--------|-------------|---------------|
| 500 | Internal Server Error | Server-side failure | LDAP connection issues, database errors, plugin failures |
| 503 | Service Unavailable | Server temporarily unavailable | LDAP server down, maintenance mode |

**Example 500 Response:**

```json
{
  "error": "LDAP bind error"
}
```

---

## Request Headers

### Required Headers

All API requests must include:

```http
Accept: application/json
```

### Content-Type Header

For POST and PUT requests with a body:

```http
Content-Type: application/json
```

### Authentication Headers

#### Token Bearer Authentication

```http
Authorization: Bearer your-secret-token
```

#### OpenID Connect

```http
Authorization: Bearer oidc-access-token
```

#### LemonLDAP::NG

LemonLDAP::NG sets headers automatically. No manual authentication header needed.

### Example Request with All Headers

```bash
curl -X POST \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer secret-token-1" \
  -d '{"uid": "test", "cn": "Test User", "sn": "User"}' \
  http://localhost:8081/api/v1/ldap/users
```

---

## Response Headers

### Standard Response Headers

All API responses include:

```http
Content-Type: application/json; charset=utf-8
```

### CORS Headers

When CORS is enabled (default), responses include:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, Accept
```

To restrict CORS origins, use the `--cors-origin` option:

```bash
--cors-origin "https://app.example.com"
```

---

## LDAP Modify Format

The LDAP modify format is used for PUT operations to update existing entries. It follows the LDAP protocol's modify operation structure.

### Format Structure

```json
{
  "add": {
    "attribute": "value"
  },
  "replace": {
    "attribute": "value"
  },
  "delete": ["attribute1", "attribute2"]
}
```

Or to delete specific values:

```json
{
  "delete": {
    "attribute": "specific-value"
  }
}
```

### Operation Types

#### 1. Replace

Replaces the entire attribute value. Creates the attribute if it doesn't exist.

**Use Case:** Update single-valued attributes or completely replace multi-valued attributes.

**Example:**

```json
{
  "replace": {
    "mail": "newemail@example.com",
    "telephoneNumber": "+1-555-0199"
  }
}
```

**LDAP Effect:**
- Old value: `mail: oldemail@example.com`
- New value: `mail: newemail@example.com`

#### 2. Add

Adds new values to an attribute. For multi-valued attributes, appends to existing values. Fails if the value already exists.

**Use Case:** Add additional values to multi-valued attributes like `mailAlternateAddress`.

**Example:**

```json
{
  "add": {
    "mailAlternateAddress": "alias@example.com",
    "telephoneNumber": "+1-555-0200"
  }
}
```

**LDAP Effect:**
- Before: `mailAlternateAddress: [primary@example.com]`
- After: `mailAlternateAddress: [primary@example.com, alias@example.com]`

#### 3. Delete

Removes attributes or specific values.

**Delete Entire Attributes (Array Format):**

```json
{
  "delete": ["mobile", "faxNumber"]
}
```

**Delete Specific Values (Object Format):**

```json
{
  "delete": {
    "mailAlternateAddress": "old-alias@example.com"
  }
}
```

**LDAP Effect (entire attribute):**
- Before: `mobile: +1-555-0123`
- After: `mobile: <removed>`

**LDAP Effect (specific value):**
- Before: `mailAlternateAddress: [alias1@example.com, alias2@example.com]`
- After: `mailAlternateAddress: [alias1@example.com]`

### Combined Operations Example

You can combine multiple operations in a single request:

```json
{
  "replace": {
    "cn": "John A. Doe",
    "displayName": "John Doe"
  },
  "add": {
    "mailAlternateAddress": "jdoe@example.com",
    "telephoneNumber": "+1-555-0201"
  },
  "delete": ["mobile", "faxNumber"]
}
```

### Complete Example

**Request:**

```bash
curl -X PUT \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "replace": {
      "mail": "john.doe@example.com",
      "telephoneNumber": "+1-555-0100"
    },
    "add": {
      "mailAlternateAddress": "j.doe@example.com"
    },
    "delete": ["mobile"]
  }' \
  http://localhost:8081/api/v1/ldap/users/john.doe
```

**Response:**

```json
{
  "success": true
}
```

### Special Cases

#### Group Members

Do **not** use modify operations for group members. Use dedicated endpoints:

- Add member: `POST /api/v1/ldap/groups/:cn/members`
- Remove member: `DELETE /api/v1/ldap/groups/:cn/members/:memberId`

**Wrong:**

```json
{
  "add": {
    "member": "uid=john.doe,ou=users,dc=example,dc=com"
  }
}
```

**Correct:**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"member": "uid=john.doe,ou=users,dc=example,dc=com"}' \
  http://localhost:8081/api/v1/ldap/groups/admins/members
```

#### Main Identifier Attribute

You cannot modify the main identifier attribute (e.g., `uid` for users, `cn` for groups) using modify operations. Use LDAP rename operations instead (not currently exposed via REST API).

**Error:**

```json
{
  "replace": {
    "uid": "new.uid"
  }
}
```

**Result:**

```json
{
  "error": "Cannot modify identifier attribute"
}
```

---

## LDAP Attributes Format

### Attribute Value Types

LDAP attributes can be single-valued or multi-valued. The API handles both formats flexibly.

#### Single-Valued Attributes

**LDAP Storage:** Always stored as arrays internally

**API Input:** Accepts both string and array formats

```json
{
  "uid": "john.doe"
}
```

Or:

```json
{
  "uid": ["john.doe"]
}
```

**API Output:** Returns as string for single values

```json
{
  "uid": "john.doe",
  "cn": "John Doe",
  "sn": "Doe"
}
```

#### Multi-Valued Attributes

**LDAP Storage:** Stored as arrays

**API Input:** Must use array format

```json
{
  "mailAlternateAddress": [
    "john@example.com",
    "jdoe@example.com",
    "john.doe@example.com"
  ]
}
```

**API Output:** Always returns as arrays

```json
{
  "objectClass": ["top", "inetOrgPerson", "organizationalPerson", "person"],
  "mailAlternateAddress": ["john@example.com", "jdoe@example.com"]
}
```

### Common Attributes Reference

#### User Attributes

| Attribute | Type | Required | Format | Description |
|-----------|------|----------|--------|-------------|
| uid | string | Yes | `^[a-zA-Z0-9._-]{1,255}$` | User identifier |
| cn | string | Yes | Any | Common name (full name) |
| sn | string | Yes | Any | Surname (last name) |
| givenName | string | No | Any | First name |
| mail | string | No | Email format | Primary email address |
| mailAlternateAddress | array | No | Email format | Additional email addresses |
| telephoneNumber | string | No | Any | Primary phone number |
| mobile | string | No | Any | Mobile phone number |
| displayName | string | No | Any | Display name |
| userPassword | string | No | Hashed | User password (SSHA, MD5, etc.) |
| departmentNumber | string | No | DN format | Department/organization link |
| objectClass | array | Yes | Fixed | LDAP object classes |

#### Group Attributes

| Attribute | Type | Required | Format | Description |
|-----------|------|----------|--------|-------------|
| cn | string | Yes | Any | Group name |
| description | string | No | Any | Group description |
| member | array | Auto | DN format | Group members (DNs) |
| objectClass | array | Yes | Fixed | LDAP object classes |

**Note:** The `member` attribute requires at least one value. If not provided, a dummy member is automatically added.

#### Organization Attributes

| Attribute | Type | Required | Format | Description |
|-----------|------|----------|--------|-------------|
| ou | string | Yes | Any | Organizational unit name |
| description | string | No | Any | Organization description |
| objectClass | array | Yes | Fixed | LDAP object classes |

### Distinguished Names (DN)

DNs uniquely identify LDAP entries and follow this format:

```
attribute=value,parent-dn
```

**Examples:**

```
uid=john.doe,ou=users,dc=example,dc=com
cn=admins,ou=groups,dc=example,dc=com
ou=it,ou=organization,dc=example,dc=com
```

**DN Components:**

- **RDN (Relative DN):** First component (`uid=john.doe`)
- **Base DN:** Remaining components (`ou=users,dc=example,dc=com`)

**DN Rules:**

1. Case-insensitive for attribute names
2. Case-sensitive for attribute values
3. Must be unique within the LDAP tree
4. Cannot contain certain special characters without escaping

---

## URL Encoding

### When to Encode

Always URL-encode DNs and special characters when using them in URL paths or query parameters.

### Characters Requiring Encoding

| Character | Encoding | Usage |
|-----------|----------|-------|
| Space | `%20` | Names with spaces |
| Comma `,` | `%2C` | DN separators |
| Equals `=` | `%3D` | DN attribute assignments |
| Plus `+` | `%2B` | Multi-valued RDNs |
| Forward slash `/` | `%2F` | Path separators |
| Colon `:` | `%3A` | Port separators |
| Question mark `?` | `%3F` | Query string start |
| Ampersand `&` | `%26` | Query parameter separator |
| Hash `#` | `%23` | Fragment identifier |

### Encoding Examples

#### Simple UID

```javascript
const uid = "john.doe";
const encoded = encodeURIComponent(uid);
// Result: john.doe (no encoding needed)
```

#### Full DN

```javascript
const dn = "uid=john.doe,ou=users,dc=example,dc=com";
const encoded = encodeURIComponent(dn);
// Result: uid%3Djohn.doe%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom
```

#### DN with Spaces

```javascript
const dn = "cn=John Doe,ou=users,dc=example,dc=com";
const encoded = encodeURIComponent(dn);
// Result: cn%3DJohn%20Doe%2Cou%3Dusers%2Cdc%3Dexample%2Cdc%3Dcom
```

### Complete Request Examples

#### JavaScript

```javascript
// Get user by DN
const dn = "uid=john.doe,ou=users,dc=example,dc=com";
const url = `http://localhost:8081/api/v1/ldap/users/${encodeURIComponent(dn)}`;

const response = await fetch(url, {
  headers: {
    'Accept': 'application/json'
  }
});

const user = await response.json();
```

#### Python

```python
import urllib.parse
import requests

# Get user by DN
dn = "uid=john.doe,ou=users,dc=example,dc=com"
encoded_dn = urllib.parse.quote(dn, safe='')
url = f"http://localhost:8081/api/v1/ldap/users/{encoded_dn}"

response = requests.get(url, headers={'Accept': 'application/json'})
user = response.json()
```

#### Bash

```bash
# Get user by DN
DN="uid=john.doe,ou=users,dc=example,dc=com"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DN', safe=''))")

curl -H "Accept: application/json" \
  "http://localhost:8081/api/v1/ldap/users/$ENCODED"
```

---

## Authentication Methods

### Overview

| Method | Security | Use Case | Session | User Identification |
|--------|----------|----------|---------|---------------------|
| None | Low | Development only | No | None |
| Token | Medium | Services, APIs | No | Token index |
| OpenID Connect | High | Web applications | Yes | User claims |
| LemonLDAP::NG | High | Enterprise SSO | Yes | LDAP user |

### Configuration Comparison

#### No Authentication

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com
```

**Pros:** Simple, fast setup
**Cons:** No security, development only

#### Token Authentication

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com \
  --plugin core/auth/token \
  --auth-token "token-1" \
  --auth-token "token-2"
```

**Pros:** Simple, stateless, good for services
**Cons:** Shared tokens, manual rotation

#### OpenID Connect

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com \
  --plugin core/auth/openidconnect \
  --oidc-issuer https://auth.example.com \
  --oidc-client-id mini-dm \
  --oidc-client-secret your-secret
```

**Pros:** Standards-based, user-specific tokens, automatic expiration
**Cons:** Requires OIDC provider setup

#### LemonLDAP::NG

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com \
  --plugin core/auth/llng \
  --llng-ini /etc/lemonldap-ng/lemonldap-ng.ini
```

**Pros:** Enterprise SSO, centralized authentication
**Cons:** Requires LemonLDAP::NG infrastructure

---

## Troubleshooting

### CORS Issues

#### Problem: Browser Blocks API Requests

**Error in Browser Console:**

```
Access to fetch at 'http://localhost:8081/api/v1/config' from origin
'http://localhost:3000' has been blocked by CORS policy
```

**Solution 1: Allow All Origins (Development)**

```bash
--cors-origin "*"
```

**Solution 2: Restrict to Specific Origin (Production)**

```bash
--cors-origin "https://app.example.com"
```

**Solution 3: Multiple Origins**

Use a reverse proxy (nginx, Apache) to handle CORS headers.

#### Problem: Preflight OPTIONS Request Fails

**Error:**

```
OPTIONS request returns 403 Forbidden
```

**Solution:**

Ensure your authentication plugin allows OPTIONS requests without authentication:

```javascript
if (req.method === 'OPTIONS') {
  return next();
}
```

### Authentication Issues

#### Problem: 401 Unauthorized

**Error:**

```json
{
  "error": "Unauthorized"
}
```

**Checklist:**

1. **Check Authorization Header:**
   ```bash
   curl -v -H "Authorization: Bearer your-token" \
     http://localhost:8081/api/v1/config
   ```

2. **Verify Token Configuration:**
   ```bash
   echo $DM_AUTH_TOKENS
   # Should include your token
   ```

3. **Check Token Format:**
   - Must start with "Bearer "
   - Token must match exactly (case-sensitive)

4. **Test Without Authentication:**
   ```bash
   # Temporarily disable auth plugin to verify API works
   npx mini-dm --ldap-url ldap://localhost:389 ...
   # (without --plugin core/auth/token)
   ```

### Connection Issues

#### Problem: Cannot Connect to Mini-DM

**Error:**

```
Failed to fetch
```

**Checklist:**

1. **Verify Server is Running:**
   ```bash
   curl http://localhost:8081/api/v1/config
   ```

2. **Check Port Configuration:**
   ```bash
   --port 8081  # Default
   ```

3. **Check Firewall:**
   ```bash
   sudo ufw allow 8081
   ```

4. **Check Server Logs:**
   ```bash
   npx mini-dm --log-level debug
   ```

#### Problem: LDAP Connection Failed

**Error:**

```json
{
  "error": "LDAP bind error"
}
```

**Checklist:**

1. **Verify LDAP Server:**
   ```bash
   ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=example,dc=com" -w admin -b "dc=example,dc=com"
   ```

2. **Check LDAP Credentials:**
   ```bash
   --ldap-dn "cn=admin,dc=example,dc=com" \
   --ldap-pwd "admin"
   ```

3. **Check LDAP URL:**
   ```bash
   --ldap-url "ldap://localhost:389"  # Not ldaps:// if using plain LDAP
   ```

4. **Check Base DN:**
   ```bash
   --ldap-base "dc=example,dc=com"
   ```

### Data Format Issues

#### Problem: Missing Required Field

**Error:**

```json
{
  "error": "Attribute \"sn\" is required"
}
```

**Solution:**

Check schema via Configuration API:

```bash
curl http://localhost:8081/api/v1/config | jq '.features.flatResources[0].schema.attributes'
```

Ensure all required fields are included:

```json
{
  "uid": "john.doe",
  "cn": "John Doe",
  "sn": "Doe"  // Required!
}
```

#### Problem: Invalid Attribute Format

**Error:**

```json
{
  "error": "Invalid value for attribute \"mail\": must match ^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
}
```

**Solution:**

Follow the attribute format specified in the schema:

```json
{
  "mail": "valid.email@example.com"  // Not "invalid-email"
}
```

#### Problem: Cannot Modify Identifier

**Error:**

```json
{
  "error": "Cannot modify identifier attribute"
}
```

**Solution:**

You cannot change the main identifier (uid, cn) using modify operations. Create a new entry instead.

### Debug Mode

Enable detailed logging:

```bash
npx mini-dm \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --ldap-base dc=example,dc=com \
  --log-level debug
```

**Log Levels:**

- `error` - Errors only
- `warn` - Warnings and errors
- `info` - General information (default)
- `debug` - Detailed debugging information
- `silly` - Everything including LDAP queries

**Example Debug Output:**

```
[2025-10-07 10:30:45] DEBUG: LDAP search: base=ou=users,dc=example,dc=com, filter=(uid=john.doe)
[2025-10-07 10:30:45] DEBUG: LDAP result: 1 entries found
[2025-10-07 10:30:45] INFO: User john.doe retrieved successfully
```

### Common Issues Summary

| Issue | Symptom | Solution |
|-------|---------|----------|
| CORS blocked | Browser console error | Configure `--cors-origin` |
| 401 Unauthorized | Authentication failed | Check token/credentials |
| 404 Not Found | Entry doesn't exist | Verify DN is correct |
| 409 Conflict | Entry already exists | Use unique identifier |
| 500 Server Error | LDAP connection failed | Check LDAP server status |
| Invalid format | Validation error | Check schema requirements |
| Cannot modify DN | Identifier change error | Create new entry instead |

### Getting Help

1. **Check Logs:**
   ```bash
   npx mini-dm --log-level debug
   ```

2. **Test LDAP Connection:**
   ```bash
   ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=example,dc=com" -w admin
   ```

3. **Verify Configuration:**
   ```bash
   curl http://localhost:8081/api/v1/config
   ```

4. **Check GitHub Issues:**
   https://github.com/linagora/mini-dm/issues

5. **Review Documentation:**
   - [REST API Guide](./REST_API.md)
   - [Browser Libraries](../browser/LIBRARIES.md)
   - [Examples](../examples/EXAMPLES.md)

---

## Additional Resources

- **[REST API Guide](./REST_API.md)** - Complete API guide with examples
- **[Developer Guide](../DEVELOPER_GUIDE.md)** - Getting started guide
- **[Browser Libraries](../browser/LIBRARIES.md)** - JavaScript/TypeScript clients
- **[JSON Schemas](../schemas/SCHEMAS.md)** - Schema structure and validation
- **[Plugin Development](../plugins/DEVELOPMENT.md)** - Creating custom plugins
