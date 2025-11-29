# Token Authentication

Simple stateless authentication using bearer tokens.

## Configuration

### Basic Configuration

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

### Named Tokens (Recommended)

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

## Usage

Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer 9f8e7d6c5b4a" \
  http://localhost:8081/api/v1/ldap/users
```

## How It Works

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

## Use Cases

- **Development/Testing**: Quick authentication without complex setup
- **Service-to-Service**: API access for backend services
- **CI/CD Pipelines**: Automated scripts and deployments
- **Simple Deployments**: Small teams without SSO infrastructure

## Security Considerations

- Tokens are static and shared (not user-specific)
- Use HTTPS in production to protect tokens in transit
- Rotate tokens regularly
- Limit token count to necessary services only
- Consider combining with IP whitelisting

## Example: Multiple Services with Named Tokens

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

## Example: Mixed Named and Unnamed Tokens

You can mix named and unnamed tokens for backward compatibility:

```bash
--auth-token "abc123:production-api" \
--auth-token "def456"  # Unnamed, will be "token 1" in logs \
--auth-token "ghi789:staging-app"
```

## Troubleshooting

**Problem:** 401 Unauthorized despite correct token

**Solutions:**

1. Ensure `Authorization: Bearer {token}` format (not just the token)
2. Check token is in configured list
3. Verify no whitespace in token
4. Check server logs for token mismatch
