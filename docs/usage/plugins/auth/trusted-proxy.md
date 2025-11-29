# Trusted Proxy

When running behind a reverse proxy (nginx, Apache, HAProxy, etc.), client IP addresses are typically passed via `X-Forwarded-For` headers. The `trustedProxy` plugin validates these headers to prevent IP spoofing attacks.

## Configuration

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

## How It Works

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

## Supported Formats

- **IPv4 addresses:** `192.168.1.1`
- **IPv6 addresses:** `::1`, `fe80::1`
- **CIDR ranges:** `10.0.0.0/8`, `192.168.0.0/16`, `2001:db8::/32`
- **IPv4-mapped IPv6:** Automatically handled (e.g., `::ffff:127.0.0.1` matches `127.0.0.1`)

## Auth-User Header

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

## Example: nginx Configuration

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

## Example: HAProxy Configuration

```haproxy
frontend https
    bind *:443 ssl crt /etc/ssl/cert.pem
    default_backend ldap_rest

backend ldap_rest
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    server ldap_rest 127.0.0.1:8081
```

## Use Cases

- **Reverse Proxy Deployments:** Ensure correct client IP for rate limiting and logging
- **Load Balancers:** Trust headers from known load balancer IPs
- **CDN Integration:** Trust headers from CDN edge servers
- **Kubernetes:** Trust headers from ingress controllers
- **Security:** Prevent attackers from spoofing `X-Forwarded-For` to bypass rate limits

## Security Considerations

- **Only trust known proxies:** Never use `0.0.0.0/0` or trust all IPs
- **Use specific IPs/ranges:** Limit to your actual proxy infrastructure
- **HTTPS between proxy and LDAP-Rest:** Prevent header injection attacks
- **Monitor logs:** Watch for warnings about removed X-Forwarded-For headers

## Plugin Load Order

The `trustedProxy` plugin is automatically loaded **first** (via `priority.json`) to ensure all other plugins see sanitized headers:

1. `core/auth/trustedProxy` - Sanitizes X-Forwarded-For headers
2. `core/weblogs` - Logs requests with correct client IP
3. `core/auth/crowdsec` - Checks IP reputation
4. `core/auth/rateLimit` - Rate limits by IP
5. Authentication plugins...
