# Documenting plugin endpoints (OpenAPI)

The published API reference at <https://linagora.github.io/ldap-rest/api/> is
generated from `openapi.json`, which itself is built statically by
[`scripts/generate-openapi.ts`](../../scripts/generate-openapi.ts) — it walks
every plugin's `api()` method and reads the JSDoc comments above each route.

You don't need to touch the generator to enrich your plugin's documentation.
Two JSDoc directives drive the entire pipeline:

- `@openapi` — placed **just above an `app.method(path, handler)` call**,
  describes that single route.
- `@openapi-component` — placed anywhere in the file, registers reusable
  schemas under `components.schemas` so multiple routes can `$ref` them.

Both directives carry inline **YAML** that follows the
[OpenAPI 3.0 Operation Object](https://spec.openapis.org/oas/v3.0.3#operation-object)
(or [Schema Object](https://spec.openapis.org/oas/v3.0.3#schema-object) for
components). The generator parses the YAML and merges it on top of the
defaults it would have emitted, so you only describe what you want to enrich.

## Per-route metadata: `@openapi`

```ts
/**
 * @openapi
 * summary: Get group by CN
 * description: |
 *   The `:cn` segment may be either the group's RDN value or its full DN.
 *   Returns the raw LDAP entry.
 * responses:
 *   '200':
 *     description: Group entry.
 *     content:
 *       application/json:
 *         schema: { $ref: '#/components/schemas/Group' }
 *         example:
 *           dn: cn=admins,ou=groups,dc=example,dc=com
 *           cn: admins
 *           description: Server administrators
 *   '404':
 *     description: Group not found.
 */
app.get(`${this.config.api_prefix}/v1/ldap/groups/:cn`, asyncHandler(...));
```

Anything below the `@openapi` line (up to the next `@directive` or the end of
the JSDoc block) is YAML. The keys you provide override the auto-generated
ones; everything you omit keeps the generator's defaults.

### What you can override

Any field of an OpenAPI Operation Object, including:

| Field         | Notes                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `summary`     | Short, one-line title.                                                           |
| `description` | Long description (markdown).                                                     |
| `tags`        | Array of strings; defaults to the plugin's tag.                                  |
| `parameters`  | Concatenated with auto-generated path params (your entries win on duplicates).   |
| `requestBody` | Replace the generic `application/json` placeholder with a real schema + example. |
| `responses`   | Replace per status code.                                                         |
| `security`    | List of security requirement objects (works as-is).                              |
| `deprecated`  | `true` to mark the operation as deprecated.                                      |
| `operationId` | Stable identifier for code generators.                                           |

### What is autodetected

The generator already extracts:

- the **HTTP method** (`get`, `post`, …) from the call expression;
- the **path** (substituting local `const prefix = ...` variables, the
  `${this.config.api_prefix}` template, and a few well-known config knobs);
- **path parameters** from `:param` segments;
- a default **summary** built from the verb and the last path segment;
- the plugin's **tag** (configured in `pluginTags` in the generator).

So a minimal, correct `@openapi` block is often only two or three keys.

## Reusable schemas: `@openapi-component`

Place this anywhere in your plugin file (the convention is right above the
class). The body is a YAML map of `<SchemaName>: <SchemaDefinition>` pairs:

```ts
/**
 * @openapi-component
 * Group:
 *   type: object
 *   required: [dn, cn]
 *   properties:
 *     dn: { type: string, example: cn=admins,ou=groups,dc=example,dc=com }
 *     cn: { type: string, example: admins }
 *     member:
 *       type: array
 *       items: { type: string }
 * Error:
 *   type: object
 *   properties:
 *     error: { type: string }
 *     code: { type: integer }
 */
export default class LdapGroups extends DmPlugin {
  // ...
}
```

Refer to them from any route using `$ref`:

```yaml
schema: { $ref: '#/components/schemas/Group' }
```

Component names are global to the spec, so prefix them with the plugin's
domain (`Group`, `ScimUser`, `PasswordPolicy`) to avoid collisions.

## Tips

- **Examples beat specs.** A single concrete `example:` block is worth a
  dozen `description:` lines for someone trying the API for the first time.
- **YAML alignment.** The generator strips the leading `*` from each line
  before parsing, then dedents the block, so you can use any consistent
  indentation as long as it's even within the block.
- **Multiline strings.** Use YAML block scalars (`description: |`) for
  paragraphs and code samples — they round-trip cleanly through Redoc.
- **Annotation is opt-in.** Routes without an `@openapi` block are
  **excluded** from the published spec — the generator prints a
  `⚠️  Skipping undocumented route` warning so the author notices, but
  the route does not surface in Redoc. The published doc therefore
  reflects intentionally-documented API surface only, not every Express
  call we happened to find.
- **A plugin with zero annotated routes disappears entirely** from the
  spec, by the same rule.

## Regenerate locally

```sh
npm run generate:openapi   # writes openapi.json
npm run build:pages        # rebuilds the static site under _site/
```

Open `_site/api/index.html` to preview the Redoc rendering. The published
site at <https://linagora.github.io/ldap-rest/api/> is rebuilt automatically
on every `v*` tag push.
