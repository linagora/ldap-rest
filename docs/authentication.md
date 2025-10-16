# Authentication Plugins

LDAP-Rest provides multiple authentication plugins to secure API access. These plugins can be used individually or combined depending on your infrastructure requirements.

## Available Authentication Methods

1. **Token Authentication** (`core/auth/token`) - Simple bearer token authentication
2. **LemonLDAP::NG** (`core/auth/llng`) - Integration with LemonLDAP::NG SSO
3. **OpenID Connect** (`core/auth/openidconnect`) - OAuth 2.0 / OpenID Connect authentication
4. **Authorization Per Branch** (`core/auth/authzPerBranch`) - Branch-level access control (see [authzPerBranch.md](authzPerBranch.md))

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

| Feature                | Token         | LemonLDAP::NG         | OpenID Connect                   |
| ---------------------- | ------------- | --------------------- | -------------------------------- |
| **Setup Complexity**   | Simple        | Medium                | Medium                           |
| **User Management**    | None          | External (LLNG)       | External (Provider)              |
| **SSO Support**        | No            | Yes                   | Yes                              |
| **MFA Support**        | No            | Yes (via LLNG)        | Yes (via Provider)               |
| **Session Management** | Stateless     | LLNG Sessions         | OIDC Sessions                    |
| **Best For**           | APIs, Scripts | Enterprises with LLNG | Cloud/SaaS, Enterprises with SSO |
| **Dependencies**       | None          | lemonldap-ng-handler  | express-openid-connect           |

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
