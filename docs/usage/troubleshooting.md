# Troubleshooting

Guide for resolving common issues.

## Connection Issues

### Plugin not found

**Symptom:** "Plugin not found" error at startup

**Solutions:**

1. Verify exact plugin name
2. Use full path (e.g., `core/ldap/flatGeneric`)
3. Check that plugin has no missing dependencies

### LDAP connection failed

**Symptom:** Unable to connect to LDAP server

**Solutions:**

1. Verify LDAP URL (`--ldap-url`)
2. Verify bind DN (`--ldap-dn`)
3. Verify password (`--ldap-pwd`)
4. Test with `ldapsearch`:
   ```bash
   ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=example,dc=com" -W -b "dc=example,dc=com"
   ```

### Schema validation failed

**Symptom:** Schema validation error

**Solutions:**

1. Verify JSON schema syntax
2. Check required fields
3. Enable debug for more details:
   ```bash
   --log-level debug
   ```

## API Issues

### 404 on API endpoint

**Symptom:** API endpoint returns 404

**Solutions:**

1. Verify that the plugin providing the endpoint is loaded
2. Check exact endpoint URL
3. Check logs for registered routes

### 401 Unauthorized

**Symptom:** Authentication refused

**Solutions:**

1. Verify `Authorization: Bearer {token}` header format
2. Verify token is in configured list
3. For TOTP, verify clock synchronization

### 403 Forbidden

**Symptom:** Access denied despite authentication

**Solutions:**

1. Check authorization rules (`authzPerBranch`)
2. Verify IP is not blocked by CrowdSec
3. Check logs for blocking reason

## Debug Mode

Enable detailed logging:

```bash
ldap-rest --log-level debug ...
```

Or via environment variable:

```bash
DM_LOG_LEVEL=debug ldap-rest
```

## Testing

Run the test suite:

```bash
# All tests
source ~/.test-env && npm run test:dev

# Single file
source ~/.test-env && npm run test:one test/path/to/file.test.ts
```

## Support

- **Issues:** https://github.com/linagora/ldap-rest/issues
- **Documentation:** https://github.com/linagora/ldap-rest/tree/master/docs
