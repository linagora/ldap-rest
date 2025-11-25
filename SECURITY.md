# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### How to Report

If you discover a security vulnerability, please report it by sending an email to:

**hosting@linagora.com**

Please include the following information:

- Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
- Full paths of source file(s) related to the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability (what an attacker could achieve)

## Security Measures

### Authentication & Authorization

This project supports multiple authentication/authorization mechanisms:

- Token-based authentication
- TOTP (Time-based One-Time Password)
- HMAC authentication
- LemonLDAP::NG integration
- OpenID Connect
- Authorization based on branch or fixed configuration file

Also:

- Trusted proxy validation for X-Forwarded-For headers
- Rate limiting
- CrowdSec integration for IP blocking

See [Authentication Guide](./docs/authentication.md) for configuration.

### Best Practices

When deploying LDAP-Rest in production:

1. **Use LDAPS** (LDAP over TLS) instead of plain LDAP:
2. **Enable authentication**
3. **Enable authorization**
4. **Enable rate limiting** to prevent brute force:
5. **Use CrowdSec** for IP reputation:
6. **Set appropriate log level**:
   ```bash
   --log-level notice  # Recommended for production
   ```
7. **Use environment variables** for secrets (never commit credentials):

   ```bash
   export DM_LDAP_PWD="secret-password"
   export DM_AUTH_TOKENS="token1,token2"
   ```

8. **Configure LDAP failover** for high availability:

   ```bash
   --ldap-url ldaps://ldap1.example.com,ldaps://ldap2.example.com
   ```

9. **Run behind a reverse proxy** (nginx, Apache) with:
   - TLS termination
   - Request size limits
   - Additional rate limiting
   - WAF (Web Application Firewall)

10. **Keep dependencies updated**:
    ```bash
    npm audit
    npm update
    ```

## Vulnerability Disclosure Policy

We follow responsible disclosure:

1. **Private Disclosure**: Report vulnerabilities privately first
2. **Fix Period**: Allow time for fix development and deployment (typically 90 days)
3. **Coordinated Disclosure**: Publish advisory after fix is available
4. **CVE Assignment**: We will request CVE numbers for confirmed vulnerabilities

## Security Updates

Security updates are published as:

- **GitHub Security Advisories**: https://github.com/linagora/ldap-rest/security/advisories
- **NPM Security Advisories**: For published npm packages
- **Release Notes**: Security fixes are clearly marked in CHANGELOG

Subscribe to GitHub notifications to receive security alerts.

## Compliance

### Cyber Resilience Act (CRA)

This project aims to comply with the EU Cyber Resilience Act:

- ✅ Security by design approach
- ✅ Vulnerability disclosure process
- ✅ Regular security updates
- ✅ Documentation of security measures
- ✅ SBOM (Software Bill of Materials) via package.json and package-lock.json

### Open Source Exemption

This software is provided as **open source, non-commercial software**. Organizations that deploy this software commercially are responsible for ensuring their own compliance with applicable regulations including the Cyber Resilience Act.

## Security Audits

We welcome security audits and penetration testing:

- Please notify us before conducting security testing
- Respect rate limits and avoid disrupting services
- Focus on security issues, not denial-of-service vulnerabilities
- Report findings through our responsible disclosure process

## Contact

- **Security Issues**: hosting@linagora.com
- **General Issues**: https://github.com/linagora/ldap-rest/issues
- **Website**: https://linagora.com

## Acknowledgments

We thank the security researchers who have responsibly disclosed vulnerabilities to us. A list of acknowledgments will be maintained here as vulnerabilities are disclosed and fixed.

---

**Last Updated**: 2025-01-03

[![Powered by LINAGORA](./docs/linagora.png)](https://linagora.com)
