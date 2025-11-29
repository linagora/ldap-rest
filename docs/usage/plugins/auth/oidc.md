# OpenID Connect Authentication

OAuth 2.0 / OpenID Connect authentication for modern identity providers.

## Configuration

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

## Prerequisites

1. **OpenID Provider**: [Lemonldap-NG](https://lemonldap-ng.org), Keycloak, Auth0, Okta, Azure AD, etc.
2. **Client Registration**: LDAP-Rest registered as OAuth2/OIDC client
3. **Optional Dependency**: The `express-openid-connect` npm package

## Installation

Install the optional dependency:

```bash
npm install express-openid-connect
```

## How It Works

1. Uses `express-openid-connect` for OAuth2/OIDC flow
2. Handles authorization code flow automatically
3. Extracts user identity from `sub` claim
4. Sets `req.user` to user's subject identifier
5. Provides `beforeAuth` and `afterAuth` hooks for customization

## Provider Configuration

### Keycloak

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

### Auth0

```bash
--oidc-server "https://tenant.auth0.com" \
--oidc-client-id "your-client-id" \
--oidc-client-secret "your-client-secret" \
--base-url "https://api.example.com"
```

### Azure AD

```bash
--oidc-server "https://login.microsoftonline.com/{tenant-id}/v2.0" \
--oidc-client-id "application-id" \
--oidc-client-secret "client-secret" \
--base-url "https://api.example.com"
```

## Scopes

Default scopes requested:

- `openid` - Basic OpenID Connect
- `profile` - User profile information
- `email` - User email address

## Hooks

The OpenID Connect plugin supports custom hooks:

### beforeAuth Hook

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

### afterAuth Hook

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

## Use Cases

- **Modern Identity Providers**: Integration with cloud identity services
- **Social Login**: Google, Microsoft, GitHub authentication
- **Multi-Tenant Applications**: Different OIDC providers per tenant
- **Standards-Based**: Portable across OIDC-compliant providers

## Troubleshooting

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

- [OpenID Connect Specification](https://openid.net/connect/)
- [express-openid-connect](https://github.com/auth0/express-openid-connect)
