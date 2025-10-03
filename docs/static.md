# Static Files Plugin

Serve static files and JSON schemas with dynamic configuration replacement.

## Overview

The `static` plugin serves static files (HTML, CSS, JS, JSON, images) from a directory and provides special handling for JSON schema files with automatic configuration placeholder replacement.

## Configuration

```bash
--plugin core/static \
--static-path ./static \
--static-prefix /static
```

**Environment Variables:**

```bash
DM_STATIC_PATH="./static"
DM_STATIC_PREFIX="/static"
```

### Parameters

- `--static-path`: Directory containing static files (required)
- `--static-prefix`: URL prefix for serving files (default: `/static`)

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

**Response (with `--ldap-base "o=gov,c=mu"`):**

```json
{
  "entity": {
    "base": "ou=users,o=gov,c=mu"
  },
  "attributes": {
    "twakeAccountStatus": {
      "type": "pointer",
      "branch": ["ou=twakeAccountStatus,ou=nomenclature,o=gov,c=mu"]
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

| Placeholder                 | CLI Argument              | Example Value                |
| --------------------------- | ------------------------- | ---------------------------- |
| `__LDAP_BASE__`             | `--ldap-base`             | `o=gov,c=mu`                 |
| `__LDAP_TOP_ORGANIZATION__` | `--ldap-top-organization` | `ou=organization,o=gov,c=mu` |
| `__API_PREFIX__`            | `--api-prefix`            | `/api`                       |
| `__STATIC_PREFIX__`         | `--static-prefix`         | `/static`                    |

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
--static-prefix /
```

Files:

```
./static/
  index.html          → http://localhost:8081/
  css/app.css         → http://localhost:8081/css/app.css
  js/ldap-tree.js     → http://localhost:8081/js/ldap-tree.js
  schemas/users.json  → http://localhost:8081/schemas/users.json
```

### 3. API Documentation

Serve OpenAPI/Swagger documentation:

```bash
--plugin core/static \
--static-path ./api-docs \
--static-prefix /docs
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
--static-prefix /static
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

```bash
--plugin core/static \
--static-path ./web \
--static-prefix /
```

Serves files from root:

```
http://localhost:8081/index.html
http://localhost:8081/about.html
```

### Example 3: Schema Deployment

```bash
--plugin core/static \
--static-path ./static \
--static-prefix /static \
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

Not directly supported, but you can nest directories:

```bash
--plugin core/static \
--static-path ./static
```

```
./static/
  docs/
    index.html
  app/
    index.html
  schemas/
    users.json
```

Access via:

```
/static/docs/index.html
/static/app/index.html
/static/schemas/users.json
```

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
// schema.entity.base = "ou=organization,o=gov,c=mu" (resolved)
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

3. Verify prefix matches URL:
   ```bash
   --static-prefix /static
   ```

### Problem: Placeholders Not Replaced

**Symptoms:**
Schema still contains `__LDAP_BASE__` after fetching.

**Solutions:**

1. Ensure file is in `schemas/` subdirectory
2. Check file extension is `.json`
3. Verify config parameter is set:
   ```bash
   --ldap-base "o=gov,c=mu"
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
