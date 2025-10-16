# OpenAPI Documentation Generation

Mini-DM includes an automatic OpenAPI 3.0 specification generator that analyzes TypeScript source code to generate API documentation without modifying production code.

## Features

- **Zero runtime overhead**: Generator runs as a build tool, not in production
- **TypeScript AST analysis**: Parses TypeScript directly to extract routes
- **No code annotations required**: Works with existing code structure
- **Automatic route discovery**: Finds all `app.get()`, `app.post()`, etc. calls
- **Template variable resolution**: Converts `${this.config.api_prefix}` to `/api`
- **Express to OpenAPI conversion**: Translates `:param` to `{param}` format
- **Plugin categorization**: Groups routes by plugin with proper tags

## Quick Start

### Generate OpenAPI Specification

```bash
npm run generate:openapi
```

This creates `openapi.json` in the project root containing the complete API specification for all loaded plugins.

### View the Specification

You can use the generated `openapi.json` with various tools:

**Swagger UI** (online viewer):
```bash
# Serve the spec with a simple HTTP server
npx http-server -p 8080

# Visit: https://editor.swagger.io/
# File → Import URL → http://localhost:8080/openapi.json
```

**Redoc** (documentation generator):
```bash
npx @redocly/cli preview-docs openapi.json
```

**Postman**: Import `openapi.json` directly

**VS Code**: Use "OpenAPI (Swagger) Editor" extension

## How It Works

### 1. TypeScript AST Parsing

The generator uses the TypeScript Compiler API to parse all plugin files:

```typescript
// Creates a TypeScript program
const program = ts.createProgram(fileNames, options);
const checker = program.getTypeChecker();
```

### 2. Plugin Discovery

Searches for classes extending `DmPlugin`:

```typescript
class LdapGroups extends DmPlugin {
  name = 'ldapGroups';  // Extracted as plugin name

  api(app: Express): void {
    // Routes extracted from here
  }
}
```

### 3. Route Extraction

Finds all Express route definitions:

```typescript
// Input (in plugin code):
app.get(`${this.config.api_prefix}/v1/ldap/groups/:cn`, (req, res) => {...});

// Output (in openapi.json):
{
  "/api/v1/ldap/groups/{cn}": {
    "get": {
      "summary": "Get groups",
      "tags": ["Groups"],
      "parameters": [
        {
          "name": "cn",
          "in": "path",
          "required": true,
          "schema": { "type": "string" }
        }
      ]
    }
  }
}
```

### 4. Template Variable Resolution

Replaces template variables with actual values:

| Template Variable | Replacement |
|-------------------|-------------|
| `${this.config.api_prefix}` | `/api` |
| `${apiPrefix}` | `/api` |
| `${this.config.static_name}` | `static` |
| `${resourceName}` | `{resource}` |

### 5. Special Handling

**Multipart Form Data** (Bulk Import):
```typescript
// Detected from path pattern
if (pathTemplate.includes('bulk-import')) {
  requestBody.content = {
    'multipart/form-data': {
      schema: {
        properties: {
          file: { type: 'string', format: 'binary' },
          dryRun: { type: 'boolean' },
          // ...
        }
      }
    }
  };
}
```

**CSV Templates**:
```typescript
// Detected from path pattern
if (method === 'get' && pathTemplate.includes('template.csv')) {
  responses = {
    '200': {
      description: 'CSV template',
      content: {
        'text/csv': { schema: { type: 'string' } }
      }
    }
  };
}
```

## Generated Structure

The `openapi.json` file contains:

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "Mini-DM API",
    "version": "1.0.0",
    "description": "RESTful API for LDAP management with Mini-DM"
  },
  "servers": [
    {
      "url": "http://localhost:8081",
      "description": "Development server"
    }
  ],
  "paths": {
    "/api/v1/ldap/groups": { ... },
    "/api/v1/ldap/organizations": { ... }
  },
  "tags": [
    { "name": "Groups", "description": "Groups operations" },
    { "name": "Organizations", "description": "Organizations operations" }
  ]
}
```

## Supported Plugins

The generator automatically discovers routes from all plugins:

| Plugin | Tag | Routes |
|--------|-----|--------|
| `ldapGroups` | Groups | 8 endpoints |
| `ldapOrganizations` | Organizations | 7 endpoints |
| `ldapBulkImport` | Bulk Import | 2 endpoints |
| `configApi` | Configuration | 1 endpoint |
| `static` | Static Files | 2 endpoints |

*Note: Number of routes may vary based on configuration and loaded plugins*

## Customizing Summaries

While the generator provides default summaries, you can add JSDoc comments to improve them:

```typescript
/**
 * @openapi summary: List all groups with optional filtering
 * @openapi description: Returns all LDAP groups, optionally filtered by match query
 */
app.get(`${this.config.api_prefix}/v1/ldap/groups`, async (req, res) => {
  // ...
});
```

The generator will extract these annotations:
- `@openapi summary:` → `summary` field
- `@openapi description:` → `description` field

## Plugin Tag Mapping

The generator maps plugin names to human-readable tags:

```typescript
private pluginTags: Map<string, string> = new Map([
  ['ldapGroups', 'Groups'],
  ['ldapOrganizations', 'Organizations'],
  ['ldapFlatGeneric', 'Entities'],
  ['ldapBulkImport', 'Bulk Import'],
  ['james', 'Apache James Integration'],
  ['calendarResources', 'Calendar Resources'],
  ['configApi', 'Configuration'],
  ['static', 'Static Files'],
]);
```

To add mappings for custom plugins, edit `scripts/generate-openapi.ts`.

## Integration with CI/CD

### Verify Spec is Up-to-Date

Add to your CI pipeline:

```bash
# Generate fresh spec
npm run generate:openapi

# Check if it differs from committed version
git diff --exit-code openapi.json
```

### Generate on Pre-Commit

Add to `.git/hooks/pre-commit`:

```bash
#!/bin/sh
npm run generate:openapi
git add openapi.json
```

### Publish to API Documentation Platform

```bash
# After generation, upload to your docs platform
npm run generate:openapi
npx @redocly/cli push openapi.json
```

## Limitations

### Current Limitations

1. **No type inference**: Schemas are generic `{ type: 'object' }`
2. **No JSDoc parsing**: Only basic `@openapi` annotations supported
3. **Static analysis only**: Cannot analyze dynamic routes
4. **No response schemas**: All responses use generic object type

### Why These Limitations?

The generator uses **static analysis** to avoid runtime dependencies. This means:

- ✅ Zero impact on production code
- ✅ No decorators or annotations required
- ✅ Fast generation
- ❌ Limited type information

### Future Enhancements

Planned improvements:

- [ ] Extract TypeScript interfaces for request/response bodies
- [ ] Parse JSDoc `@param` and `@returns` annotations
- [ ] Generate schema definitions from TypeScript types
- [ ] Support for custom response status codes
- [ ] Query parameter detection from `req.query`

## Troubleshooting

### "tsconfig.json not found"

The generator needs a valid TypeScript configuration:

```bash
# Ensure tsconfig.json exists
ls tsconfig.json
```

### "Found 0 plugins"

Check that:
1. Plugins extend `DmPlugin`
2. Plugins have an `api(app: Express)` method
3. TypeScript compilation succeeds: `npm run check:ts`

### Wrong paths generated

Template variables not replaced correctly? Check:

```typescript
// Supported:
`${this.config.api_prefix}/v1/...`
`${apiPrefix}/v1/...`
`${this.config.static_name}/...`

// Not supported:
`${someOtherVariable}/...`
```

Add custom replacements in `scripts/generate-openapi.ts`:

```typescript
pathTemplate = text
  .replace(/\$\{myVariable\}/g, 'replacement')
  // ...
```

### Routes missing

The generator only finds routes in `api()` methods of plugin classes. Routes defined elsewhere won't be detected.

## Examples

### Example 1: View API in Swagger Editor

```bash
# 1. Generate spec
npm run generate:openapi

# 2. Start local server
npx http-server -p 8080

# 3. Visit https://editor.swagger.io/
# 4. File → Import URL → http://localhost:8080/openapi.json
```

### Example 2: Generate TypeScript Client

```bash
# Generate spec
npm run generate:openapi

# Generate TypeScript axios client
npx @openapitools/openapi-generator-cli generate \
  -i openapi.json \
  -g typescript-axios \
  -o ./generated-client
```

### Example 3: Validate API Responses

```bash
# Generate spec
npm run generate:openapi

# Install validator
npm install --save-dev @seriousme/openapi-schema-validator

# Use in tests
import { Validator } from '@seriousme/openapi-schema-validator';

const validator = new Validator();
await validator.validate('./openapi.json');
```

## Comparison with Alternatives

### tsoa (TypeScript OpenAPI)

**Pros**:
- Full type inference
- Automatic validation
- Schema generation

**Cons**:
- ❌ Requires decorators in production code
- ❌ Changes code structure
- ❌ Runtime overhead

### swagger-jsdoc

**Pros**:
- JSDoc annotations
- Familiar syntax

**Cons**:
- ❌ Requires extensive annotations
- ❌ Pollutes code with comments
- ❌ Manual maintenance

### Mini-DM Generator

**Pros**:
- ✅ No production code changes
- ✅ Zero runtime overhead
- ✅ Automatic route discovery
- ✅ Works with existing code

**Cons**:
- ⚠️ Limited type information
- ⚠️ Generic schemas

## Contributing

To improve the generator:

1. Edit `scripts/generate-openapi.ts`
2. Test with `npm run generate:openapi`
3. Verify output in `openapi.json`
4. Submit PR with changes

Common improvements:

- Add plugin tag mappings
- Improve summary generation
- Add more template variable replacements
- Extract TypeScript types for schemas

## See Also

- [Plugin Development Guide](DEVELOPER_GUIDE.md)
- [Plugin Dependencies](PLUGIN_DEPENDENCIES.md)
- [OpenAPI 3.0 Specification](https://swagger.io/specification/)
- [TypeScript Compiler API](https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API)
