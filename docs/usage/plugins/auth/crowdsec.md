# CrowdSec Integration

IP reputation and blocking using [CrowdSec](https://crowdsec.net/).

## Configuration

```bash
--plugin core/auth/crowdsec \
--crowdsec-url "http://localhost:8080" \
--crowdsec-api-key "your-api-key"
```

**Environment Variables:**

```bash
DM_CROWDSEC_URL="http://localhost:8080"
DM_CROWDSEC_API_KEY="your-api-key"
```

## Prerequisites

1. **CrowdSec Installation**: Running CrowdSec instance
2. **API Key**: Bouncer API key from CrowdSec

## How It Works

1. Extracts client IP from request (respects trusted proxy)
2. Queries CrowdSec API for IP reputation
3. Blocks requests from banned IPs with `403 Forbidden`
4. Allows legitimate requests to proceed

## Use Cases

- **IP Reputation**: Block known malicious IPs
- **Threat Intelligence**: Leverage community-shared threat data
- **Dynamic Blocking**: Automatic response to attacks
- **Compliance**: Security monitoring and logging

## CrowdSec Setup

### Install CrowdSec

```bash
# Debian/Ubuntu
curl -s https://packagecloud.io/install/repositories/crowdsec/crowdsec/script.deb.sh | sudo bash
sudo apt install crowdsec

# Generate bouncer API key
sudo cscli bouncers add ldap-rest-bouncer
```

### Configure LDAP-Rest

```bash
npx ldap-rest \
  --plugin core/auth/crowdsec \
  --crowdsec-url "http://localhost:8080" \
  --crowdsec-api-key "generated-api-key" \
  ...
```

## Combining with Other Security Plugins

Recommended security stack:

```bash
--plugin core/auth/trustedProxy \
--trusted-proxy "127.0.0.1" \
--plugin core/auth/crowdsec \
--crowdsec-url "http://localhost:8080" \
--crowdsec-api-key "your-api-key" \
--plugin core/auth/rateLimit \
--rate-limit-max 100 \
--plugin core/auth/token \
--auth-token "your-token"
```

Order matters:

1. `trustedProxy` - Sanitize IP headers first
2. `crowdsec` - Block known bad IPs
3. `rateLimit` - Limit request frequency
4. Authentication plugins

## Security Considerations

- Keep CrowdSec updated for latest threat intelligence
- Monitor CrowdSec logs for blocked requests
- Consider local decisions for sensitive applications
- Use HTTPS between LDAP-Rest and CrowdSec API

## See Also

- [CrowdSec Documentation](https://docs.crowdsec.net/)
- [CrowdSec Hub](https://hub.crowdsec.net/)
