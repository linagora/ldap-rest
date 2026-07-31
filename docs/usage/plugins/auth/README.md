# Authentication Plugins

LDAP-Rest provides multiple authentication plugins to secure API access. These plugins can be used individually or combined depending on your infrastructure requirements.

## Available Authentication Methods

| Method                    | Plugin                    | Description                                      |
| ------------------------- | ------------------------- | ------------------------------------------------ |
| [Token](token.md)         | `core/auth/token`         | Simple bearer token authentication               |
| [TOTP](totp.md)           | `core/auth/totp`          | Time-based One-Time Password authentication      |
| [HMAC](hmac.md)           | `core/auth/hmac`          | HMAC-SHA256 request signing for backend services |
| [LemonLDAP::NG](llng.md)  | `core/auth/llng`          | Integration with LemonLDAP::NG SSO               |
| [OpenID Connect](oidc.md) | `core/auth/openidconnect` | OAuth 2.0 / OpenID Connect authentication        |

## Authorization Plugins

| Method                                          | Plugin                     | Description                 |
| ----------------------------------------------- | -------------------------- | --------------------------- |
| [Authorization Per Branch](authz-per-branch.md) | `core/auth/authzPerBranch` | Branch-level access control |
| [Authorization Per Route](authz-per-route.md)   | `core/auth/authzPerRoute`  | HTTP route-level ACL        |
| [Authorization LinID 1.x](authz-linid1.md)      | `core/auth/authzLinid1`    | LinID 1.x integration       |

## Security Plugins

| Method                            | Plugin                   | Description                                           |
| --------------------------------- | ------------------------ | ----------------------------------------------------- |
| [Trusted Proxy](trusted-proxy.md) | `core/auth/trustedProxy` | Validate X-Forwarded-For headers from reverse proxies |
| [Rate Limiting](rate-limit.md)    | `core/auth/rateLimit`    | Prevent brute force attacks                           |
| [CrowdSec](crowdsec.md)           | `core/auth/crowdsec`     | IP reputation and blocking                            |

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

## Serving several populations from one server

Populations rarely authenticate the same way: machines carry a token, administrators arrive with an SSO session. `--auth-path-prefix` restricts an authentication plugin to one or more path prefixes, so a single server can host both without either credential being valid on the other's branch of the API.

Any plugin can be loaded more than once under a distinct name with its own configuration (`module:name:{json}`), which is what makes this work:

```bash
ldap-rest \
  --plugin 'core/auth/token:auth-machines:{"auth_path_prefix":"/api/m","auth_token":"…:robot"}' \
  --plugin 'core/ldap/raw:raw-machines:{"api_prefix":"/api/m"}' \
  --plugin 'core/auth/openidconnect:auth-admins:{"auth_path_prefix":"/api/admin"}' \
  --plugin 'core/ldap/raw:raw-admins:{"api_prefix":"/api/admin"}'
```

A token presented on `/api/admin` is refused, and a session presented on `/api/m` is refused too: each authentication plugin only sees the branch it was mounted on. Prefixes match on segment boundaries, so `/api/m` guards `/api/m` and `/api/m/entry` but never `/api/machines`.

### The gap to watch

A route registered **outside every prefix is served without authentication**. That is the price of scoping, and it is silent — the server starts, the API answers. To make it visible, the routes no plugin guards are listed at startup:

```
Authentication is restricted to /api/m, /api/admin, so these routes are
served without authentication: /api/v1/config, /api/v1/ldap/users
```

Read that line on every configuration change. Either scope the missing routes to a prefix as well, load one unscoped authentication plugin as a catch-all, or keep them public deliberately. Nothing is reported when no authentication is configured (the server is open on purpose) or when at least one plugin guards every path.

Note that a prefix scopes **authentication**, not authorization: once past it, a caller reaches everything the branch exposes. Restrict what each population may do with [authz-per-route](authz-per-route.md) or [authz-per-branch](authz-per-branch.md).

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

## See Also

- [LemonLDAP::NG Documentation](https://lemonldap-ng.org/documentation)
- [OpenID Connect Specification](https://openid.net/connect/)
- [express-openid-connect](https://github.com/auth0/express-openid-connect)
