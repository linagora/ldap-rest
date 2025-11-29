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
