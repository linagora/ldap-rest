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

| Method                                          | Plugin                     | Description                  |
| ----------------------------------------------- | -------------------------- | ---------------------------- |
| [Authorization Per Branch](authz-per-branch.md) | `core/auth/authzPerBranch` | Branch-level access control  |
| [Authorization Per Route](authz-per-route.md)   | `core/auth/authzPerRoute`  | HTTP route-level ACL         |
| [Authorization LinID 1.x](authz-linid1.md)      | `core/auth/authzLinid1`    | LinID 1.x integration        |
| [Authorization Scope](authz-scope.md)           | `core/auth/authzScope`     | What the current user may do |

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

A prefix must be a string starting with `/`. Anything else — a number left in the JSON, an empty entry, a prefix without its leading slash — refuses to start rather than being skipped: a dropped entry shrinks what the plugin guards, which is the failure that leaves a branch open while the configuration still reads as if it were covered. `/` is not a prefix but the whole server, so a list containing it makes the plugin a catch-all: `["/", "/api/admin"]` guards everything, not only `/api/admin`.

### One branch apart, a token on everything else

Leaving a plugin unscoped makes it the **catch-all**: it guards everything no scoped plugin claims. There is no list of "everything else" to write, and none to keep up to date when a route is added:

```bash
ldap-rest \
  --plugin 'core/auth/openidconnect:auth-admins:{"auth_path_prefix":"/api/admin"}' \
  --plugin core/auth/token \
  --auth-token "…:robot"
```

`/api/admin` requires the SSO session, everything else requires the token.

### How the choice is made

Authentication is not a middleware each plugin mounts for itself. The server mounts **one dispatcher**, positioned after the guards (`protect`: rate limiting, proxy trust, CrowdSec) and access logging, and before the first plugin able to register a route. Authentication plugins register with it instead of adding a layer.

Two properties follow, and both are load-bearing:

- **Order of declaration does not matter.** A plugin that registers after the API it guards still guards it, because the dispatcher — not the plugin — owns the layer. With per-plugin middlewares that was untrue and silent: a guard mounted after its routes never ran for them.
- **The most specific claim wins.** `/api/admin` is handled by the plugin scoped to it, `/api` by the plugin scoped to `/api`, and anything unclaimed by an unscoped plugin. Only the winner runs, so two plugins covering the same request never compose as an AND that no credential can satisfy.

Several plugins sharing the same winning prefix all run, in registration order: requiring two credentials on one branch is a legitimate ask, and an accident there fails closed rather than open.

### The gap to watch

A route registered **outside every prefix is served without authentication**. That is the price of scoping, and it is silent — the server starts, the API answers. To make it visible, the routes no plugin guards are listed at startup:

```
Authentication is restricted to /api/m, /api/admin, so these routes are
served without authentication: /api/v1/config, /api/v1/ldap/users
```

Read that line on every configuration change. Either scope the missing routes to a prefix as well, add an unscoped plugin as the catch-all, or keep them public deliberately. Nothing is reported when no authentication is configured (the server is open on purpose) or when a catch-all covers what the scoped plugins do not.

Note the converse: with a catch-all there is no public branch at all. Making one API reachable without credentials means scoping every authentication plugin and leaving that branch out — the warning will then name it, which is correct but reads as an oversight rather than a decision.

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
