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

The rate limiter will use the real client IP from `X-Forwarded-For` when the request comes from a trusted proxy.

## Security Considerations

- Always use with `trustedProxy` plugin behind reverse proxies
- Consider different limits for different endpoints
- Monitor for legitimate users hitting limits
- Combine with CrowdSec for IP reputation
