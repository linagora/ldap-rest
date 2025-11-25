# Authentication Plugins

LDAP-Rest provides multiple authentication plugins to secure API access. These plugins can be used individually or combined depending on your infrastructure requirements.

## Available Authentication Methods

1. **Token Authentication** (`core/auth/token`) - Simple bearer token authentication
2. **TOTP Authentication** (`core/auth/totp`) - Time-based One-Time Password authentication
3. **HMAC Authentication** (`core/auth/hmac`) - HMAC-SHA256 request signing for backend services
4. **LemonLDAP::NG** (`core/auth/llng`) - Integration with LemonLDAP::NG SSO
5. **OpenID Connect** (`core/auth/openidconnect`) - OAuth 2.0 / OpenID Connect authentication
6. **Authorization Per Branch** (`core/auth/authzPerBranch`) - Branch-level access control (see [authzPerBranch.md](authzPerBranch.md))

## Security Plugins

1. **Trusted Proxy** (`core/auth/trustedProxy`) - Validate X-Forwarded-For headers from reverse proxies
2. **Rate Limiting** (`core/auth/rateLimit`) - Prevent brute force attacks
3. **CrowdSec** (`core/auth/crowdsec`) - IP reputation and blocking

## Trusted Proxy

When running behind a reverse proxy (nginx, Apache, HAProxy, etc.), client IP addresses are typically passed via `X-Forwarded-For` headers. The `trustedProxy` plugin validates these headers to prevent IP spoofing attacks.

### Configuration

```bash
--plugin core/auth/trustedProxy \
--trusted-proxy "127.0.0.1" \
--trusted-proxy "10.0.0.0/8" \
--trusted-proxy "192.168.0.0/16"
```

**Environment Variables:**

```bash
# Comma-separated list of trusted proxy IPs or CIDR ranges
DM_TRUSTED_PROXIES="127.0.0.1,10.0.0.0/8,192.168.0.0/16,::1"

# Optional: Header name for authenticated user from proxy (default: Auth-User)
DM_TRUSTED_PROXY_AUTH_HEADER="Auth-User"
```

### How It Works

1. **Request arrives** from reverse proxy
2. **Plugin checks** if `req.socket.remoteAddress` matches a trusted proxy
3. **If trusted:**
   - `X-Forwarded-For` header is preserved
   - `Auth-User` header (or custom header) is extracted for logging
   - Request is marked as `req.trustedProxy = true`
4. **If untrusted:**
   - `X-Forwarded-For` header is **removed** to prevent IP spoofing
   - Request is marked as `req.trustedProxy = false`
5. **Other plugins** (rate limiting, CrowdSec, weblogs) see sanitized headers

### Supported Formats

- **IPv4 addresses:** `192.168.1.1`
- **IPv6 addresses:** `::1`, `fe80::1`
- **CIDR ranges:** `10.0.0.0/8`, `192.168.0.0/16`, `2001:db8::/32`
- **IPv4-mapped IPv6:** Automatically handled (e.g., `::ffff:127.0.0.1` matches `127.0.0.1`)

### Auth-User Header

When requests come from a trusted proxy, the plugin can extract an authenticated username from a header set by the proxy. This is useful for:

- Logging who made the request (even if LDAP-Rest doesn't handle authentication)
- Passing identity from an upstream authentication system

```bash
# Custom header name (default: Auth-User)
DM_TRUSTED_PROXY_AUTH_HEADER="X-Remote-User"
```

The extracted username is:
- Available as `req.proxyAuthUser` for other plugins
- Used by the `weblogs` plugin to log the user field

### Example: nginx Configuration

```nginx
upstream ldap_rest {
    server 127.0.0.1:8081;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    location / {
        proxy_pass http://ldap_rest;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Optional: Pass authenticated user from nginx auth
        proxy_set_header Auth-User $remote_user;
    }
}
```

LDAP-Rest configuration:

```bash
DM_TRUSTED_PROXIES="127.0.0.1"
```

### Example: HAProxy Configuration

```haproxy
frontend https
    bind *:443 ssl crt /etc/ssl/cert.pem
    default_backend ldap_rest

backend ldap_rest
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    server ldap_rest 127.0.0.1:8081
```

### Use Cases

- **Reverse Proxy Deployments:** Ensure correct client IP for rate limiting and logging
- **Load Balancers:** Trust headers from known load balancer IPs
- **CDN Integration:** Trust headers from CDN edge servers
- **Kubernetes:** Trust headers from ingress controllers
- **Security:** Prevent attackers from spoofing `X-Forwarded-For` to bypass rate limits

### Security Considerations

- **Only trust known proxies:** Never use `0.0.0.0/0` or trust all IPs
- **Use specific IPs/ranges:** Limit to your actual proxy infrastructure
- **HTTPS between proxy and LDAP-Rest:** Prevent header injection attacks
- **Monitor logs:** Watch for warnings about removed X-Forwarded-For headers

### Plugin Load Order

The `trustedProxy` plugin is automatically loaded **first** (via `priority.json`) to ensure all other plugins see sanitized headers:

1. `core/auth/trustedProxy` - Sanitizes X-Forwarded-For headers
2. `core/weblogs` - Logs requests with correct client IP
3. `core/auth/crowdsec` - Checks IP reputation
4. `core/auth/rateLimit` - Rate limits by IP
5. Authentication plugins...

## Token Authentication

Simple stateless authentication using bearer tokens.

### Configuration

#### Basic Configuration

```bash
--plugin core/auth/token \
--auth-token "secret-token-1" \
--auth-token "secret-token-2" \
--auth-token "secret-token-3"
```

**Environment Variable:**

```bash
DM_AUTH_TOKENS="token1,token2,token3"
```

#### Named Tokens (Recommended)

Associate a descriptive name with each token for better logging and audit trails:

```bash
--plugin core/auth/token \
--auth-token "9f8e7d6c5b4a:web-application" \
--auth-token "1a2b3c4d5e6f:monitoring-service" \
--auth-token "f1e2d3c4b5a6:backup-scripts"
```

**Environment Variable:**

```bash
DM_AUTH_TOKENS="9f8e7d6c5b4a:web-application,1a2b3c4d5e6f:monitoring-service,f1e2d3c4b5a6:backup-scripts"
```

**Syntax:** `token:name`

- Token value comes first (the secret)
- Colon `:` separator
- Name comes second (descriptive identifier)

### Usage

Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer 9f8e7d6c5b4a" \
  http://localhost:8081/api/v1/ldap/users
```

### How It Works

1. Extracts token from `Authorization: Bearer <token>` header
2. Validates token against configured list
3. Sets `req.user` to the token's name (e.g., `"web-application"`) or `"token {index}"` for unnamed tokens
4. Returns 401 Unauthorized if token is missing or invalid

**Named tokens in logs:**

```
INFO: Request from user: web-application
INFO: Request from user: monitoring-service
```

**Unnamed tokens in logs (backward compatible):**

```
INFO: Request from user: token 0
INFO: Request from user: token 1
```

### Use Cases

- **Development/Testing**: Quick authentication without complex setup
- **Service-to-Service**: API access for backend services
- **CI/CD Pipelines**: Automated scripts and deployments
- **Simple Deployments**: Small teams without SSO infrastructure

### Security Considerations

- Tokens are static and shared (not user-specific)
- Use HTTPS in production to protect tokens in transit
- Rotate tokens regularly
- Limit token count to necessary services only
- Consider combining with IP whitelisting

### Example: Multiple Services with Named Tokens

```bash
# API server configuration with named tokens
npx ldap-rest \
  --plugin core/auth/token \
  --auth-token "a1b2c3d4e5f6:production-web-app" \
  --auth-token "f6e5d4c3b2a1:prometheus-monitoring" \
  --auth-token "1234567890ab:nightly-backup" \
  --ldap-url ldap://localhost:389 \
  ...
```

```bash
# Web application (logs will show: user: production-web-app)
curl -H "Authorization: Bearer a1b2c3d4e5f6" \
  http://api/v1/ldap/users

# Monitoring system (logs will show: user: prometheus-monitoring)
curl -H "Authorization: Bearer f6e5d4c3b2a1" \
  http://api/v1/ldap/groups

# Backup script (logs will show: user: nightly-backup)
curl -H "Authorization: Bearer 1234567890ab" \
  http://api/v1/ldap/organizations/top
```

### Example: Mixed Named and Unnamed Tokens

You can mix named and unnamed tokens for backward compatibility:

```bash
--auth-token "abc123:production-api" \
--auth-token "def456"  # Unnamed, will be "token 1" in logs \
--auth-token "ghi789:staging-app"
```

## TOTP Authentication

Time-based One-Time Password (TOTP) authentication using dynamic codes compatible with authenticator apps.

### Configuration

#### Basic Configuration

```bash
--plugin core/auth/totp \
--auth-totp "JBSWY3DPEHPK3PXP:admin:6" \
--auth-totp "HXDMVJECJJWSRB3H:service:8"
```

**Environment Variable:**

```bash
DM_AUTH_TOTP="JBSWY3DPEHPK3PXP:admin:6,HXDMVJECJJWSRB3H:service:8"
```

**Syntax:** `secret:name[:digits]`

- **secret**: Base32-encoded secret (e.g., generated by authenticator apps)
- **name**: Descriptive user/service name
- **digits**: Number of digits in TOTP code (optional, 6-10, default: 6)

#### Advanced Configuration

```bash
--auth-totp-window 1    # Time window tolerance (±30s with step=30)
--auth-totp-step 30     # Time step in seconds (default: 30)
```

**Environment Variables:**

```bash
DM_AUTH_TOTP_WINDOW=1   # Default: 1
DM_AUTH_TOTP_STEP=30    # Default: 30
```

- **window**: Number of time steps to check before/after current time (compensates for clock drift)
- **step**: Time interval in seconds for code generation (typically 30)

### Generating Secrets

Use an authenticator app or generate Base32 secrets:

```bash
# Using Node.js crypto (example)
node -e "console.log(require('crypto').randomBytes(20).toString('base32'))"
```

### Usage

#### HTTP Requests

Include the current TOTP code in the `Authorization` header:

```bash
# Get current TOTP code from your authenticator app
curl -H "Authorization: Bearer 123456" \
  http://localhost:8081/api/v1/ldap/users
```

#### Browser Client

The TOTP client library is available as an npm module export:

```bash
npm install ldap-rest
```

```typescript
import {
  TotpAuthClient,
  generateTotp,
  getRemainingSeconds,
  isValidBase32,
} from 'ldap-rest/browser-shared-utils-totp';

const client = new TotpAuthClient({
  secret: 'JBSWY3DPEHPK3PXP',
  digits: 6,
  step: 30,
});

// Automatic authentication with current TOTP code
const response = await client.get('/api/v1/ldap/users');
const users = await response.json();

// Or get current code manually
const code = await client.getCode();
console.log(`Current TOTP code: ${code}`);
```

**Live Demo:** See [examples/web/totp-client.html](../../examples/web/totp-client.html) for an interactive demonstration.

### How It Works

1. Extracts TOTP code from `Authorization: Bearer <code>` header
2. Generates expected TOTP codes for current time window
3. Validates code against all configured users' secrets
4. Supports multiple time windows (±window × step seconds) for clock drift tolerance
5. Sets `req.user` to the user's name on successful validation
6. Returns 401 Unauthorized if code is missing, invalid, or expired

### Multi-User Example

```bash
# Configure multiple users with different code lengths
--plugin core/auth/totp \
--auth-totp "JBSWY3DPEHPK3PXP:admin:6" \
--auth-totp "HXDMVJECJJWSRB3H:api-service:8" \
--auth-totp "IXDMVJECJJWSRB2A:monitoring:10"
```

**In logs:**

```
INFO: TOTP authentication successful for user: admin
INFO: TOTP authentication successful for user: api-service
```

### Use Cases

- **Enhanced Security**: Dynamic codes that expire every 30 seconds
- **No Shared Secrets**: Each user/service has unique TOTP secret
- **Compatible**: Works with Google Authenticator, Authy, 1Password, etc.
- **API Access**: Suitable for automated scripts with TOTP generation
- **Multi-Factor**: Can be combined with other authentication methods

### Security Considerations

- **Secret Storage**: Store Base32 secrets securely (encrypted configuration, environment variables)
- **HTTPS Required**: Always use HTTPS to protect TOTP codes in transit
- **Clock Synchronization**: Ensure server and client clocks are synchronized (NTP recommended)
- **Window Size**: Larger windows are more tolerant but slightly less secure
- **Secret Rotation**: Rotate TOTP secrets periodically for better security
- **Rate Limiting**: Consider adding rate limiting to prevent brute force attacks

### Browser Client Features

The TOTP browser library provides these functions and classes:

```typescript
import {
  generateTotp,
  getRemainingSeconds,
  isValidBase32,
  TotpAuthClient
} from 'ldap-rest/browser-shared-utils-totp';

// Generate TOTP code
const code = await generateTotp({
  secret: 'JBSWY3DPEHPK3PXP',
  digits: 6,
  step: 30
});

// Check validity time
const remaining = getRemainingSeconds(30);
console.log(`Code expires in ${remaining} seconds`);

// Validate secret format
if (isValidBase32('JBSWY3DPEHPK3PXP')) {
  console.log('Valid Base32 secret');
}

// HTTP client with automatic TOTP authentication
const client = new TotpAuthClient({
  secret: 'JBSWY3DPEHPK3PXP',
  digits: 6,
  step: 30
});

// All HTTP methods automatically include TOTP in Authorization header
await client.post('/api/v1/ldap/users', { uid: 'user1', ... });
await client.put('/api/v1/ldap/users/user1', { mail: 'new@example.com' });
await client.delete('/api/v1/ldap/users/user1');
```

**Module Export:** `ldap-rest/browser-shared-utils-totp`

**Live Demo:** Run the server and open [http://localhost:8081/static/examples/web/totp-client.html](http://localhost:8081/static/examples/web/totp-client.html)

### Troubleshooting

**Problem:** 401 Unauthorized despite correct code

**Solutions:**

1. Verify secret is correctly configured (Base32 format)
2. Check system clock synchronization (use NTP)
3. Increase `--auth-totp-window` if experiencing timing issues
4. Ensure code is used immediately (codes expire every 30s)
5. Verify `Authorization: Bearer {code}` format

**Problem:** Codes don't match authenticator app

**Solutions:**

1. Verify secret matches exactly (case-sensitive Base32)
2. Check `--auth-totp-step` matches app configuration (usually 30)
3. Ensure both server and device clocks are synchronized
4. Confirm correct number of digits configured

**Problem:** Invalid Base32 secret warning

**Solutions:**

1. Secret must contain only A-Z and 2-7 characters
2. Use proper Base32 encoding (not Base64)
3. Remove padding `=` characters if present (optional)

## HMAC Authentication

HMAC-SHA256 request signing authentication for backend services (Registration Service, admin panel backend, cloudery, etc.).

### Configuration

#### Basic Configuration

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

#### Advanced Configuration

```bash
--auth-hmac-window 120000  # Time window in milliseconds (default: 120000 = 2 minutes)
```

**Environment Variable:**

```bash
DM_AUTH_HMAC_WINDOW=120000  # Default: 120000ms (2 minutes)
```

- **window**: Maximum time difference (in milliseconds) between server and client timestamp
- Prevents replay attacks by rejecting requests with timestamps outside the window

### How It Works

#### Request Signing Process

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

### Usage

#### Manual Request Example

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

#### POST Request with Body

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

#### Browser Client

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

### Use Cases

- **Backend Services**: Service-to-service authentication (Registration Service, admin panels, etc.)
- **Microservices**: Secure inter-service communication
- **Webhooks**: Verify request authenticity and integrity
- **API Gateways**: Backend service authentication
- **Cloudery Integration**: Secure communication with cloudery backend
- **Automated Services**: CI/CD, monitoring, backup services

### Security Considerations

- **Secret Strength**: Use secrets of at least 32 characters (64+ recommended)
- **Secret Storage**: Store secrets securely (encrypted configuration, environment variables, secret managers)
- **HTTPS Required**: Always use HTTPS to protect signatures in transit
- **Time Synchronization**: Ensure server and client clocks are synchronized (NTP recommended)
- **Replay Protection**: Time window prevents replay attacks (adjust `auth-hmac-window` as needed)
- **Constant-Time Comparison**: Signature validation uses `timingSafeEqual` to prevent timing attacks
- **Secret Rotation**: Rotate secrets periodically for enhanced security
- **Body Integrity**: Body hash ensures request payload hasn't been tampered with
- **Path Integrity**: Full path (including query parameters) is signed

### Security Features

1. **Replay Attack Prevention**: Timestamp validation with configurable window
2. **Timing Attack Protection**: Constant-time signature comparison
3. **Request Integrity**: Body hash ensures payload integrity
4. **Path Integrity**: Query parameters included in signature
5. **Multi-Service Support**: Isolated secrets per service
6. **Clock Drift Tolerance**: Configurable time window (default 2 minutes)

### Advantages Over Other Methods

| Feature                   | HMAC               | Token          | TOTP                |
| ------------------------- | ------------------ | -------------- | ------------------- |
| **Request Integrity**     | ✅ Yes (body hash) | ❌ No          | ❌ No               |
| **Replay Protection**     | ✅ Yes (timestamp) | ❌ No          | ✅ Yes (time-based) |
| **Signature Per Request** | ✅ Yes             | ❌ No (static) | ✅ Yes (30s codes)  |
| **Body Tampering Detect** | ✅ Yes             | ❌ No          | ❌ No               |
| **Path/Query Protection** | ✅ Yes             | ❌ No          | ❌ No               |
| **Setup Complexity**      | Medium             | Simple         | Simple              |
| **Best For**              | Backend services   | Simple APIs    | MFA, user auth      |

### Comparison with Standards

This implementation is similar to:

- **AWS Signature V4**: Similar approach but simpler (AWS is more complex with canonicalization)
- **HTTP Message Signatures (RFC 9421)**: IETF standard for HTTP signatures
- **HMAC-Based Authentication**: Industry-standard pattern for service authentication

Our approach provides a good balance between security and simplicity:

- ✅ Simpler than AWS Signature V4 (easier to implement)
- ✅ More secure than static tokens (request-specific signatures)
- ✅ Better integrity than TOTP (includes body and path hashing)
- ✅ Standard cryptography (HMAC-SHA256)

### Troubleshooting

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

## LemonLDAP::NG Authentication

Integration with [LemonLDAP::NG](https://lemonldap-ng.org/) (LLNG) Web SSO solution.

### Configuration

```bash
--plugin core/auth/llng \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini
```

**Environment Variable:**

```bash
DM_LLNG_INI="/etc/lemonldap-ng/lemonldap-ng.ini"
```

### Prerequisites

1. **LemonLDAP::NG Handler**: The `lemonldap-ng-handler` npm package (optional dependency)
2. **LLNG Configuration**: Valid `lemonldap-ng.ini` file
3. **Virtual Host Configuration**: LDAP-Rest must be configured as a protected application in LLNG

### How It Works

1. Uses the LemonLDAP::NG Handler to validate requests
2. Extracts user identity from `Lm-Remote-User` header
3. Sets `req.user` to authenticated username
4. Inherits all LLNG authorization rules and features

### Installation

Install the optional dependency:

```bash
npm install lemonldap-ng-handler
```

### LLNG Configuration

Configure LDAP-Rest as a protected virtual host in LemonLDAP::NG:

```apache
# In LLNG Manager: Virtual Hosts > api.example.com
<VirtualHost *:443>
  ServerName api.example.com

  # LemonLDAP::NG Handler
  PerlHeaderParserHandler Lemonldap::NG::Handler::ApacheMP2

  # Proxy to LDAP-Rest
  ProxyPass / http://localhost:8081/
  ProxyPassReverse / http://localhost:8081/
</VirtualHost>
```

### Use Cases

- **Enterprise SSO**: Centralized authentication for multiple applications
- **Advanced Authorization**: Fine-grained access control using LLNG rules
- **Session Management**: Centralized session handling
- **Multi-Factor Authentication**: MFA support through LLNG

### Example: LLNG Authorization Rules

Configure access rules in LLNG Manager:

```perl
# Allow only HR group to access users endpoint
$groups =~ /\bhr\b/ and $uri =~ m#^/api/v1/ldap/users#

# Allow admins full access
$groups =~ /\badmins\b/

# Allow specific users to manage groups
$uid eq "groupmanager" and $uri =~ m#^/api/v1/ldap/groups#
```

## OpenID Connect Authentication

OAuth 2.0 / OpenID Connect authentication for modern identity providers.

### Configuration

```bash
--plugin core/auth/openidconnect \
--oidc-server "https://auth.example.com" \
--oidc-client-id "ldap-rest-client" \
--oidc-client-secret "client-secret-here" \
--base-url "https://api.example.com"
```

**Environment Variables:**

```bash
DM_OIDC_SERVER="https://auth.example.com"
DM_OIDC_CLIENT_ID="ldap-rest-client"
DM_OIDC_CLIENT_SECRET="client-secret-here"
DM_BASE_URL="https://api.example.com"
```

### Prerequisites

1. **OpenID Provider**: [Lemonldap-NG](https://lemonldap-ng.org), Keycloak, Auth0, Okta, Azure AD, etc.
2. **Client Registration**: LDAP-Rest registered as OAuth2/OIDC client
3. **Optional Dependency**: The `express-openid-connect` npm package

### Installation

Install the optional dependency:

```bash
npm install express-openid-connect
```

### How It Works

1. Uses `express-openid-connect` for OAuth2/OIDC flow
2. Handles authorization code flow automatically
3. Extracts user identity from `sub` claim
4. Sets `req.user` to user's subject identifier
5. Provides `beforeAuth` and `afterAuth` hooks for customization

### Provider Configuration

#### Keycloak

```bash
--oidc-server "https://keycloak.example.com/realms/master" \
--oidc-client-id "ldap-rest" \
--oidc-client-secret "abc123..." \
--base-url "https://api.example.com"
```

**Client Settings:**

- Access Type: `confidential`
- Valid Redirect URIs: `https://api.example.com/callback`
- Standard Flow Enabled: `ON`

#### Auth0

```bash
--oidc-server "https://tenant.auth0.com" \
--oidc-client-id "your-client-id" \
--oidc-client-secret "your-client-secret" \
--base-url "https://api.example.com"
```

#### Azure AD

```bash
--oidc-server "https://login.microsoftonline.com/{tenant-id}/v2.0" \
--oidc-client-id "application-id" \
--oidc-client-secret "client-secret" \
--base-url "https://api.example.com"
```

### Scopes

Default scopes requested:

- `openid` - Basic OpenID Connect
- `profile` - User profile information
- `email` - User email address

### Hooks

The OpenID Connect plugin supports custom hooks:

#### beforeAuth Hook

Called before authentication processing:

```javascript
hooks: {
  beforeAuth: async ([req, res]) => {
    // Custom pre-authentication logic
    console.log('Authentication attempt from:', req.ip);
    return [req, res];
  };
}
```

#### afterAuth Hook

Called after successful authentication:

```javascript
hooks: {
  afterAuth: async ([req, res]) => {
    // Access OIDC user data
    const user = req.oidc.user;
    console.log('User authenticated:', user.email);

    // Add custom user properties
    req.customData = {
      email: user.email,
      name: user.name,
    };

    return [req, res];
  };
}
```

### Use Cases

- **Modern Identity Providers**: Integration with cloud identity services
- **Social Login**: Google, Microsoft, GitHub authentication
- **Multi-Tenant Applications**: Different OIDC providers per tenant
- **Standards-Based**: Portable across OIDC-compliant providers

## Choosing an Authentication Method

| Feature                | Token         | TOTP              | HMAC                   | LemonLDAP::NG         | OpenID Connect                   |
| ---------------------- | ------------- | ----------------- | ---------------------- | --------------------- | -------------------------------- |
| **Setup Complexity**   | Simple        | Simple            | Medium                 | Medium                | Medium                           |
| **User Management**    | None          | Manual            | Manual (service-based) | External (LLNG)       | External (Provider)              |
| **SSO Support**        | No            | No                | No                     | Yes                   | Yes                              |
| **MFA Support**        | No            | Yes (TOTP itself) | N/A                    | Yes (via LLNG)        | Yes (via Provider)               |
| **Session Management** | Stateless     | Stateless         | Stateless              | LLNG Sessions         | OIDC Sessions                    |
| **Code Expiration**    | Never         | 30-60 seconds     | Per-request            | Session-based         | Session-based                    |
| **Request Integrity**  | No            | No                | Yes (body + path hash) | No                    | No                               |
| **Replay Protection**  | No            | Yes (time-based)  | Yes (timestamp)        | Session-based         | Session-based                    |
| **Best For**           | APIs, Scripts | APIs, Enhanced    | Backend Services       | Enterprises with LLNG | Cloud/SaaS, Enterprises with SSO |
| **Dependencies**       | None          | None              | None                   | lemonldap-ng-handler  | express-openid-connect           |

## Combining with Authorization

All authentication plugins set `req.user` to the authenticated identity. You can use hooks to implement custom authorization:

```javascript
hooks: {
  afterAuth: async ([req, res]) => {
    // Check if user can access this endpoint
    if (req.path.startsWith('/api/v1/ldap/users') && !isAdmin(req.user)) {
      throw new Error('Forbidden: Admin access required');
    }
    return [req, res];
  };
}
```

## Testing Authentication

### Token Authentication

```bash
# Valid request
curl -H "Authorization: Bearer valid-token" \
  http://localhost:8081/api/v1/ldap/users

# Invalid token
curl -H "Authorization: Bearer invalid-token" \
  http://localhost:8081/api/v1/ldap/users
# Returns: 401 Unauthorized

# Missing header
curl http://localhost:8081/api/v1/ldap/users
# Returns: 401 Unauthorized
```

### TOTP Authentication

```bash
# Get current code from authenticator app (e.g., Google Authenticator)
# Code changes every 30 seconds

# Valid request with current code
curl -H "Authorization: Bearer 123456" \
  http://localhost:8081/api/v1/ldap/users

# Invalid/expired code
curl -H "Authorization: Bearer 999999" \
  http://localhost:8081/api/v1/ldap/users
# Returns: 401 Unauthorized

# Test with browser client
node -e "
import { generateTotp } from './src/browser/shared/utils/totp.js';
const code = await generateTotp({ secret: 'JBSWY3DPEHPK3PXP', digits: 6 });
console.log('Current TOTP code:', code);
"
```

### HMAC Authentication

```bash
# Example: GET request with HMAC signature
SERVICE_ID="registration-service"
SECRET="secret-key-minimum-32-chars"
METHOD="GET"
PATH="/api/hello"
TIMESTAMP=$(date +%s000)

# Calculate signature
SIGNING_STRING="${METHOD}|${PATH}|${TIMESTAMP}|"
SIGNATURE=$(echo -n "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Test request
curl -H "Authorization: HMAC-SHA256 ${SERVICE_ID}:${TIMESTAMP}:${SIGNATURE}" \
  http://localhost:8081${PATH}

# Invalid signature should return 401
curl -H "Authorization: HMAC-SHA256 ${SERVICE_ID}:${TIMESTAMP}:invalid-sig" \
  http://localhost:8081${PATH}
# Returns: 401 Unauthorized
```

### LemonLDAP::NG

Access through LLNG portal - authentication is handled by LLNG infrastructure.

### OpenID Connect

Navigate to API in browser - will redirect to OIDC provider login page, then return with authenticated session.

## Troubleshooting

### Token Authentication

**Problem:** 401 Unauthorized despite correct token

**Solutions:**

1. Ensure `Authorization: Bearer {token}` format (not just the token)
2. Check token is in configured list
3. Verify no whitespace in token
4. Check server logs for token mismatch

### TOTP Authentication

**Problem:** 401 Unauthorized despite correct code from authenticator app

**Solutions:**

1. Verify secret matches exactly (Base32, case-sensitive)
2. Check system clock synchronization (use NTP: `ntpdate -q pool.ntp.org`)
3. Increase `--auth-totp-window` if experiencing timing issues
4. Ensure `--auth-totp-step` matches authenticator app (usually 30)
5. Check server logs: `"Unauthorized TOTP token: {code}"`
6. Verify `Authorization: Bearer {code}` format

**Problem:** Invalid Base32 secret warning in logs

**Solutions:**

1. Secret must be valid Base32 (A-Z, 2-7 characters only)
2. Remove any whitespace from secret
3. Generate new secret if corrupted:
   ```bash
   node -e "console.log(require('crypto').randomBytes(20).toString('base32'))"
   ```

**Problem:** Codes expire too quickly

**Solutions:**

1. Increase `--auth-totp-window` (default: 1, try 2-3 for more tolerance)
2. This allows codes from previous/next time windows
3. Be aware: larger windows reduce security slightly

### LemonLDAP::NG

**Problem:** Handler not found

**Solution:** Install optional dependency:

```bash
npm install lemonldap-ng-handler
```

**Problem:** authentication refused

**Solutions:**

1. Verify LLNG handler is configured correctly
2. Check virtual host configuration
3. Review LLNG access logs

### OpenID Connect

**Problem:** express-openid-connect not found

**Solution:** Install optional dependency:

```bash
npm install express-openid-connect
```

**Problem:** Missing config parameter

**Solution:** Ensure all required parameters are set:

- `--oidc-server`
- `--oidc-client-id`
- `--oidc-client-secret`
- `--base-url`

**Problem:** Redirect loop

**Solutions:**

1. Set a long secret, shorts are refused by `openid-client`
2. Verify `--base-url` matches actual public URL
3. Check redirect URI in provider matches `{base-url}/callback`
4. Ensure HTTPS in production (many providers require it)

## See Also

- [LemonLDAP::NG Documentation](https://lemonldap-ng.org/documentation)
- [OpenID Connect Specification](https://openid.net/connect/)
- [express-openid-connect](https://github.com/auth0/express-openid-connect)
