# Static Files Plugin

Serve static files and JSON schemas with dynamic configuration replacement.

## Overview

The `static` plugin serves static files (HTML, CSS, JS, JSON, images) from a directory and provides special handling for JSON schema files with automatic configuration placeholder replacement.

## Configuration

```bash
--plugin core/static \
--static-path ./static \
--static-name static
```

**Environment Variables:**

```bash
DM_STATIC_PATH="./static"
DM_STATIC_NAME="static"
```

### Parameters

- `--static-path`: Directory containing static files (required)
- `--static-name`: the path the files are served under, without a slash
  around it (default: `static`, for `/static/…`). Slashes around it are left
  out and an empty value is `static`; a segment that is empty, `.` or `..`,
  or that holds what a URL encodes or Express reads as route syntax (a
  space, a letter outside ASCII, `:`, `*`, `?`, `#`, `%`, brackets, quotes…), stops the server at startup
- `--static-csp` (`DM_STATIC_CSP`): the `Content-Security-Policy` of the
  files it serves, default `frame-ancestors 'self'`; `off` sends none. See
  [Security headers](#security-headers)
- `--static-frame-options` (`DM_STATIC_FRAME_OPTIONS`): the
  `X-Frame-Options` of the files it serves, default `SAMEORIGIN`; `off`
  sends none

## How It Works

### Regular Files

Serves files directly from the configured directory:

```
GET /static/index.html → ./static/index.html
GET /static/css/app.css → ./static/css/app.css
GET /static/js/main.js → ./static/js/main.js
```

### Schema Files

For JSON files in the `schemas/` subdirectory, performs on-the-fly placeholder replacement:

**Schema file (`./static/schemas/users.json`):**

```json
{
  "entity": {
    "base": "ou=users,__LDAP_BASE__"
  },
  "attributes": {
    "twakeAccountStatus": {
      "type": "pointer",
      "branch": ["ou=twakeAccountStatus,ou=nomenclature,__LDAP_BASE__"]
    }
  }
}
```

**Request:**

```bash
GET /static/schemas/users.json
```

**Response (with `--ldap-base "dc=example,dc=com"`):**

```json
{
  "entity": {
    "base": "ou=users,dc=example,dc=com"
  },
  "attributes": {
    "twakeAccountStatus": {
      "type": "pointer",
      "branch": ["ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"]
    }
  }
}
```

## Placeholder Replacement

### Format

Placeholders use double underscores and uppercase:

```
__CONFIG_KEY__
```

### Replacement Rules

Configuration keys are transformed:

- CLI: `--ldap-base` → Placeholder: `__LDAP_BASE__`
- CLI: `--ldap-top-organization` → Placeholder: `__LDAP_TOP_ORGANIZATION__`
- Env: `DM_LDAP_BASE` → Placeholder: `__LDAP_BASE__`

### Common Placeholders

| Placeholder                 | CLI Argument              | Example Value                       |
| --------------------------- | ------------------------- | ----------------------------------- |
| `__LDAP_BASE__`             | `--ldap-base`             | `dc=example,dc=com`                 |
| `__LDAP_TOP_ORGANIZATION__` | `--ldap-top-organization` | `ou=organization,dc=example,dc=com` |
| `__API_PREFIX__`            | `--api-prefix`            | `/api`                              |
| `__STATIC_NAME__`           | `--static-name`           | `static`                            |

## Use Cases

### 1. Schema Sharing

Share schemas between server and client-side JavaScript:

**Server-side:**

```javascript
// Schemas loaded with resolved placeholders
const schema = require('./schemas/users.json');
```

**Client-side:**

```javascript
// Fetch schema with resolved placeholders
const response = await fetch('/static/schemas/users.json');
const schema = await response.json();
```

Both get the same schema with configuration values resolved.

### 2. Web Interface

Serve web-based LDAP management interface:

```bash
--plugin core/static \
--static-path ./static \
--static-name app
```

Files:

```
./static/
  index.html          → http://localhost:8081/app/
  css/app.css         → http://localhost:8081/app/css/app.css
  js/ldap-tree.js     → http://localhost:8081/app/js/ldap-tree.js
  schemas/users.json  → http://localhost:8081/app/schemas/users.json
```

### 3. API Documentation

Serve OpenAPI/Swagger documentation:

```bash
--plugin core/static \
--static-path ./api-docs \
--static-name docs
```

```
GET /docs/openapi.json → ./api-docs/openapi.json
GET /docs/swagger-ui/  → ./api-docs/swagger-ui/index.html
```

## Examples

### Example 1: Basic Static Files

```bash
--plugin core/static \
--static-path ./public \
--static-name static
```

**Directory structure:**

```
./public/
  index.html
  favicon.ico
  css/
    style.css
  js/
    app.js
```

**URLs:**

```
http://localhost:8081/static/index.html
http://localhost:8081/static/favicon.ico
http://localhost:8081/static/css/style.css
http://localhost:8081/static/js/app.js
```

### Example 2: Root Path Serving

Not supported: the files are always served under `/<static-name>/`, and
the schema routes, which replace the placeholders, are built on that name.
To show an application at `/`, have the reverse proxy redirect `/` to it,
for instance to `/static/index.html`.

### Example 3: Schema Deployment

```bash
--plugin core/static \
--static-path ./static \
--static-name static \
--ldap-base "dc=example,dc=com"
```

**Schema file (`./static/schemas/config.json`):**

```json
{
  "ldapBase": "__LDAP_BASE__",
  "apiEndpoint": "__API_PREFIX__/v1/ldap"
}
```

**Served as:**

```json
{
  "ldapBase": "dc=example,dc=com",
  "apiEndpoint": "/api/v1/ldap"
}
```

### Example 4: Multiple Static Plugins

One plugin serves several applications from sub-directories:

```
./static/
  docs/
    index.html
  app/
    index.html
  schemas/
    users.json
```

```
/static/docs/index.html
/static/app/index.html
/static/schemas/users.json
```

A second directory takes a second instance, loaded under a name of its own
with its own `static_name` and `static_path`
([`module:name:{json}`](../auth/README.md#serving-several-populations-from-one-server)):

```bash
--plugin core/static --static-path ./static \
--plugin 'core/static:console:{"static_name":"console","static_path":"./console"}'
```

Give them paths that do not nest: `console` and `console/app` would have the
first one answer requests meant for the second. The plugins that announce a
schema URL (groups, organizations, flat entities, SCIM) ask every instance,
the one registered as `static` first, and leave out one whose path lies under
an earlier one's.

## Security Considerations

### Path Traversal

The plugin uses Express's `express.static()` which prevents path traversal attacks:

```bash
# These are blocked:
GET /static/../../../etc/passwd
GET /static/%2e%2e%2f%2e%2e%2fetc/passwd
```

### Sensitive Files

**Do not serve** sensitive files:

- Configuration files with secrets
- Private keys
- Database files
- .env files

Use a dedicated static directory with only public files.

### Access Control

The static plugin has **no authentication**. All files are publicly accessible.

For restricted access:

1. Use authentication plugins
2. Implement custom middleware
3. Use reverse proxy with access controls

### Security headers

The files served here are applications, an administration console among
them. So that no other origin frames one signed in (clickjacking), another
sub-domain or port of the same site included, the responses under the prefix
carry:

```
Content-Security-Policy: frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
```

`X-Frame-Options` is for browsers that ignore `frame-ancestors`. A page that
must be framed by another origin names it:

```bash
--static-csp "frame-ancestors 'self' https://portal.example.com"
--static-frame-options off
```

A full policy can be given the same way, for instance
`default-src 'self'; frame-ancestors 'none'`, as long as the applications
served allow it: the policy applies to every file under the prefix. One
written on several lines, as a YAML block holds it, is sent as one line; a
value a header cannot hold stops the server at startup. An empty value keeps
the default, as a compose file expands an unset `${VAR:-}` to one; `off`
sends no header (`false` in a plugin's JSON override), when the reverse
proxy sets its own. Keeping both is harmless as long as they agree.

A redirect or a 404 that Express answers itself (a directory without its
slash, a missing file) carries `Content-Security-Policy: default-src 'none'`
instead; `X-Frame-Options`, unless set to `off`, still keeps it from being
framed, and it shows nothing to click.

Every response of the server, API routes included, also carries
`X-Content-Type-Options: nosniff`, and none says `X-Powered-By: Express`.

## MIME Types

Express automatically sets Content-Type based on file extension:

| Extension | Content-Type             |
| --------- | ------------------------ |
| `.html`   | `text/html`              |
| `.css`    | `text/css`               |
| `.js`     | `application/javascript` |
| `.json`   | `application/json`       |
| `.png`    | `image/png`              |
| `.jpg`    | `image/jpeg`             |
| `.svg`    | `image/svg+xml`          |

## Caching

Express `static` middleware supports HTTP caching headers:

```bash
# Browser caches for 1 day
Cache-Control: public, max-age=86400
```

For production, consider using a CDN or reverse proxy with caching.

## Integration with ldap-tree-viewer

The LDAP tree viewer web interface uses the static plugin:

```bash
--plugin core/static \
--plugin core/ldap/organization \
--static-path ./static \
--ldap-organization-max-subnodes 50
```

Files:

```
./static/
  ldap-tree-viewer.html    # Web interface
  schemas/                 # JSON schemas with placeholders
```

The viewer fetches schemas with resolved LDAP configuration:

```javascript
const response = await fetch('/static/schemas/organizations.json');
const schema = await response.json();
// schema.entity.base = "ou=organization,dc=example,dc=com" (resolved)
```

## Troubleshooting

### Problem: 404 Not Found

**Symptoms:**

```
GET /static/index.html → 404
```

**Solutions:**

1. Verify file exists:

   ```bash
   ls ./static/index.html
   ```

2. Check static path configuration:

   ```bash
   --static-path ./static
   ```

3. Verify that the name matches the first segment of the URL:
   ```bash
   --static-name static
   ```

### Problem: Placeholders Not Replaced

**Symptoms:**
Schema still contains `__LDAP_BASE__` after fetching.

**Solutions:**

1. Ensure file is in `schemas/` subdirectory
2. Check file extension is `.json`
3. Verify config parameter is set:
   ```bash
   --ldap-base "dc=example,dc=com"
   ```

### Problem: CORS Errors

**Symptoms:**
Browser blocks requests from different origin.

**Solutions:**

1. Use reverse proxy to serve from same origin
2. Add CORS headers via custom middleware
3. Configure browser to allow CORS (development only)

## See Also

- [ldapOrganizations.md](ldapOrganizations.md) - LDAP tree viewer integration
- [ldapFlatGeneric.md](ldapFlatGeneric.md) - Schema-driven LDAP management
