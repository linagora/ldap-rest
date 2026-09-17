# LemonLDAP::NG Authentication

Integration with [LemonLDAP::NG](https://lemonldap-ng.org/) (LLNG) Web SSO solution.

## Configuration

```bash
--plugin core/auth/llng \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini
```

**Environment Variable:**

```bash
DM_LLNG_INI="/etc/lemonldap-ng/lemonldap-ng.ini"
```

## Prerequisites

1. **LemonLDAP::NG Handler**: The `lemonldap-ng-handler` npm package (optional dependency)
2. **LLNG Configuration**: Valid `lemonldap-ng.ini` file
3. **Virtual Host Configuration**: LDAP-Rest must be configured as a protected application in LLNG

The handler runs inside LDAP-Rest and reads `lemonldap-ng.ini` when the server
starts. The file tells it where the LLNG configuration is, and which virtual
hosts it protects — a Node.js handler serves only those listed in
`nodeVhosts`:

```ini
[configuration]
type = REST
baseConfigUrl = https://auth.example.com/index.fcgi/config

[node-handler]
nodeVhosts = api.example.com
```

A file that cannot be read, a configuration that cannot be reached or a
missing `nodeVhosts` stops the server at startup, with the reason.

## How It Works

1. Uses the LemonLDAP::NG Handler to validate requests
2. Extracts user identity from `Lm-Remote-User` header
3. Sets `req.user` to authenticated username
4. Inherits all LLNG authorization rules and features

## Installation

Install the optional dependency:

```bash
npm install lemonldap-ng-handler
```

## LLNG Configuration

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

## Use Cases

- **Enterprise SSO**: Centralized authentication for multiple applications
- **Advanced Authorization**: Fine-grained access control using LLNG rules
- **Session Management**: Centralized session handling
- **Multi-Factor Authentication**: MFA support through LLNG

## Example: LLNG Authorization Rules

Configure access rules in LLNG Manager:

```perl
# Allow only HR group to access users endpoint
$groups =~ /\bhr\b/ and $uri =~ m#^/api/v1/ldap/users#

# Allow admins full access
$groups =~ /\badmins\b/

# Allow specific users to manage groups
$uid eq "groupmanager" and $uri =~ m#^/api/v1/ldap/groups#
```

## Troubleshooting

**Problem:** Handler not found

**Solution:** Install optional dependency:

```bash
npm install lemonldap-ng-handler
```

**Problem:** Authentication refused

**Solutions:**

1. Verify LLNG handler is configured correctly
2. Check virtual host configuration
3. Review LLNG access logs

## See Also

- [LemonLDAP::NG Documentation](https://lemonldap-ng.org/documentation)
