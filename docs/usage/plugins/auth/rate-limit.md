# Rate Limiting

Prevent brute force attacks by limiting the number of requests per IP address.

## Configuration

```bash
--plugin core/auth/rateLimit \
--rate-limit-window 60000 \
--rate-limit-max 100
```

**Environment Variables:**

```bash
DM_RATE_LIMIT_WINDOW=60000   # Time window in milliseconds (default: 60000 = 1 minute)
DM_RATE_LIMIT_MAX=100        # Maximum requests per window (default: 100)
```

## How It Works

1. Tracks request count per IP address
2. Uses sliding window algorithm
3. Returns `429 Too Many Requests` when limit exceeded
4. Automatically respects `X-Forwarded-For` when behind trusted proxy

## Use Cases

- **Brute Force Prevention**: Limit authentication attempts
- **API Protection**: Prevent abuse of API endpoints
- **DDoS Mitigation**: Basic protection against flood attacks
- **Fair Usage**: Ensure equitable API access

## Headers

When rate limiting is active, responses include:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1698765492
```

## Combining with Trusted Proxy

For correct IP detection behind reverse proxies:

```bash
--plugin core/auth/trustedProxy \
--trusted-proxy "127.0.0.1" \
--plugin core/auth/rateLimit \
--rate-limit-max 100
```

The limiter reads the client address `trustedProxy` publishes on the request
(`req.clientIp`). That plugin walks `X-Forwarded-For` from the right, skips
the addresses it trusts as proxies, and takes the first one it does not, so a
value a client writes at the left of the chain never becomes its key. Without
`trustedProxy`, the limiter uses the TCP peer and a reverse proxy makes every
client share one counter; the plugin says so at startup:

```
Auth rate limiting ignores X-Forwarded-For because core/auth/trustedProxy is
not loaded and uses the TCP peer: requests through a proxy share one counter.
```

Load `trustedProxy` when a reverse proxy sits in front. It is no longer
necessary for the proxy to overwrite the header: appending
(`$proxy_add_x_forwarded_for`) is read correctly.

## Security Considerations

- Always use with `trustedProxy` plugin behind reverse proxies
- Consider different limits for different endpoints
- Monitor for legitimate users hitting limits
- Combine with CrowdSec for IP reputation
