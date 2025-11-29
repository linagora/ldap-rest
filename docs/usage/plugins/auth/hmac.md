# HMAC Authentication

HMAC-SHA256 request signing authentication for backend services (Registration Service, admin panel backend, cloudery, etc.).

## Configuration

### Basic Configuration

```bash
--plugin core/auth/hmac \
--auth-hmac "registration-service:secret-key-minimum-32-chars:Registration Service" \
--auth-hmac "cloudery:another-secret-key-long-enough:Cloudery Backend"
```

**Environment Variable:**

```bash
DM_AUTH_HMAC="registration-service:secret-key-minimum-32-chars:Registration Service,cloudery:another-secret-key-long-enough:Cloudery Backend"
```

**Syntax:** `service-id:secret:name`

- **service-id**: Service identifier (e.g., `registration-service`, `cloudery`)
- **secret**: Shared secret for HMAC (minimum 32 characters recommended)
- **name**: Descriptive service name (can contain colons)

### Advanced Configuration

```bash
--auth-hmac-window 120000  # Time window in milliseconds (default: 120000 = 2 minutes)
```

**Environment Variable:**

```bash
DM_AUTH_HMAC_WINDOW=120000  # Default: 120000ms (2 minutes)
```

- **window**: Maximum time difference (in milliseconds) between server and client timestamp
- Prevents replay attacks by rejecting requests with timestamps outside the window

## How It Works

### Request Signing Process

1. **Client calculates signature:**

   ```
   signature = HMAC-SHA256(
     secret,
     "METHOD|PATH|timestamp|body-hash"
   )
   ```

   Where:
   - `METHOD`: HTTP method (GET, POST, PATCH, DELETE, PUT, etc.)
   - `PATH`: Request path with query string (e.g., `/api/v1/ldap/users?filter=active`)
   - `timestamp`: Unix timestamp in milliseconds (e.g., `1698765432000`)
   - `body-hash`: SHA256(request_body) for POST/PATCH/PUT, empty string for GET/DELETE/HEAD

2. **Client sends Authorization header:**

   ```
   Authorization: HMAC-SHA256 service-id:timestamp:signature
   ```

3. **Server validates:**
   - Extracts `service-id`, `timestamp`, and `signature` from header
   - Verifies timestamp is within configured window (prevents replay attacks)
   - Retrieves service secret using `service-id`
   - Recalculates signature using same method
   - Compares signatures using constant-time comparison (prevents timing attacks)
   - Rejects if mismatch or timestamp expired

4. **On success:**
   - Sets `req.user` to service name
   - Allows request to proceed

## Usage

### Manual Request Example

```bash
# Example: GET request
SERVICE_ID="registration-service"
SECRET="secret-key-minimum-32-chars"
METHOD="GET"
PATH="/api/v1/ldap/users"
TIMESTAMP=$(date +%s000)  # Unix timestamp in milliseconds

# Calculate body hash (empty for GET)
BODY_HASH=""

# Create signing string
SIGNING_STRING="${METHOD}|${PATH}|${TIMESTAMP}|${BODY_HASH}"

# Calculate HMAC-SHA256 signature
SIGNATURE=$(echo -n "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Make request
curl -H "Authorization: HMAC-SHA256 ${SERVICE_ID}:${TIMESTAMP}:${SIGNATURE}" \
  http://localhost:8081${PATH}
```

### POST Request with Body

```bash
SERVICE_ID="registration-service"
SECRET="secret-key-minimum-32-chars"
METHOD="POST"
PATH="/api/v1/ldap/users"
TIMESTAMP=$(date +%s000)
BODY='{"uid":"user1","mail":"user1@example.com"}'

# Calculate body hash
BODY_HASH=$(echo -n "$BODY" | openssl dgst -sha256 | cut -d' ' -f2)

# Create signing string
SIGNING_STRING="${METHOD}|${PATH}|${TIMESTAMP}|${BODY_HASH}"

# Calculate signature
SIGNATURE=$(echo -n "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Make request
curl -X POST \
  -H "Authorization: HMAC-SHA256 ${SERVICE_ID}:${TIMESTAMP}:${SIGNATURE}" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  http://localhost:8081${PATH}
```

### Browser Client

The HMAC client library is available as an npm module export:

```bash
npm install ldap-rest
```

```typescript
import { HmacAuthClient } from 'ldap-rest/browser-shared-utils-hmac';

const client = new HmacAuthClient({
  serviceId: 'registration-service',
  secret: 'secret-key-minimum-32-chars',
});

// Automatic authentication with HMAC signature
const response = await client.get('/api/v1/ldap/users');
const users = await response.json();

// POST with automatic body hashing and signing
await client.post('/api/v1/ldap/users', {
  uid: 'user1',
  mail: 'user1@example.com',
});

// Other methods: put, patch, delete
await client.put('/api/v1/ldap/users/user1', { mail: 'new@example.com' });
await client.delete('/api/v1/ldap/users/user1');
```

**Manual signature generation:**

```typescript
import { generateHmacSignature } from 'ldap-rest/browser-shared-utils-hmac';

const signature = await generateHmacSignature(
  'secret-key-minimum-32-chars',
  'GET',
  '/api/v1/ldap/users',
  Date.now(),
  undefined // no body for GET
);

const authHeader = `HMAC-SHA256 registration-service:${Date.now()}:${signature}`;
```

## Use Cases

- **Backend Services**: Service-to-service authentication (Registration Service, admin panels, etc.)
- **Microservices**: Secure inter-service communication
- **Webhooks**: Verify request authenticity and integrity
- **API Gateways**: Backend service authentication
- **Cloudery Integration**: Secure communication with cloudery backend
- **Automated Services**: CI/CD, monitoring, backup services

## Security Considerations

- **Secret Strength**: Use secrets of at least 32 characters (64+ recommended)
- **Secret Storage**: Store secrets securely (encrypted configuration, environment variables, secret managers)
- **HTTPS Required**: Always use HTTPS to protect signatures in transit
- **Time Synchronization**: Ensure server and client clocks are synchronized (NTP recommended)
- **Replay Protection**: Time window prevents replay attacks (adjust `auth-hmac-window` as needed)
- **Constant-Time Comparison**: Signature validation uses `timingSafeEqual` to prevent timing attacks
- **Secret Rotation**: Rotate secrets periodically for enhanced security
- **Body Integrity**: Body hash ensures request payload hasn't been tampered with
- **Path Integrity**: Full path (including query parameters) is signed

## Security Features

1. **Replay Attack Prevention**: Timestamp validation with configurable window
2. **Timing Attack Protection**: Constant-time signature comparison
3. **Request Integrity**: Body hash ensures payload integrity
4. **Path Integrity**: Query parameters included in signature
5. **Multi-Service Support**: Isolated secrets per service
6. **Clock Drift Tolerance**: Configurable time window (default 2 minutes)

## Advantages Over Other Methods

| Feature                   | HMAC               | Token          | TOTP                |
| ------------------------- | ------------------ | -------------- | ------------------- |
| **Request Integrity**     | Yes (body hash) | No          | No               |
| **Replay Protection**     | Yes (timestamp) | No          | Yes (time-based) |
| **Signature Per Request** | Yes             | No (static) | Yes (30s codes)  |
| **Body Tampering Detect** | Yes             | No          | No               |
| **Path/Query Protection** | Yes             | No          | No               |
| **Setup Complexity**      | Medium             | Simple         | Simple              |
| **Best For**              | Backend services   | Simple APIs    | MFA, user auth      |

## Comparison with Standards

This implementation is similar to:

- **AWS Signature V4**: Similar approach but simpler (AWS is more complex with canonicalization)
- **HTTP Message Signatures (RFC 9421)**: IETF standard for HTTP signatures
- **HMAC-Based Authentication**: Industry-standard pattern for service authentication

Our approach provides a good balance between security and simplicity:

- Simpler than AWS Signature V4 (easier to implement)
- More secure than static tokens (request-specific signatures)
- Better integrity than TOTP (includes body and path hashing)
- Standard cryptography (HMAC-SHA256)

## Troubleshooting

**Problem:** 401 Unauthorized despite correct signature

**Solutions:**

1. Verify service-id matches exactly (case-sensitive)
2. Verify secret is correctly configured (minimum 32 characters)
3. Check system clock synchronization (use NTP: `ntpdate -q pool.ntp.org`)
4. Increase `--auth-hmac-window` if experiencing timing issues
5. Verify Authorization header format: `HMAC-SHA256 service-id:timestamp:signature`
6. Check server logs for specific error messages
7. Ensure timestamp is in milliseconds, not seconds
8. Verify body hash calculation (must match exactly)

**Problem:** Timestamp outside allowed window

**Solutions:**

1. Synchronize clocks using NTP
2. Increase `--auth-hmac-window` (default: 120000ms = 2 minutes)
3. Check if timestamp is in milliseconds (not seconds)
4. Verify both server and client are using same timezone reference (UTC)

**Problem:** Signature mismatch

**Solutions:**

1. Verify signing string format: `METHOD|PATH|timestamp|body-hash`
2. Ensure METHOD is uppercase (GET, POST, etc.)
3. Include full path with query parameters
4. For POST/PATCH/PUT: verify body hash is SHA256(JSON.stringify(body))
5. For GET/DELETE/HEAD: body-hash must be empty string
6. Ensure secret is exactly the same on client and server
7. Use hex encoding for signature (lowercase)
8. Check for trailing whitespace in secret

**Problem:** Warning about short secrets

**Solutions:**

1. Use secrets of at least 32 characters
2. Recommended: 64+ characters for enhanced security
3. Generate secure random secrets:
   ```bash
   openssl rand -hex 32  # 64-character hex string
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

**Debug Example:**

```bash
# Enable debug logging
DM_LOG_LEVEL=debug npm start

# Check signing string in logs
# Expected format: "GET|/api/v1/ldap/users|1698765432000|"
```
