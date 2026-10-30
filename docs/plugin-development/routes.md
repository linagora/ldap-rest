# Declaring routes

`defineRoute` declares an HTTP route once: its inputs, their schemas, what
the OpenAPI document says of it, and the handler. The schemas are checked
before the handler runs, and the declaration is recorded on the app for the
API document.

```typescript
import { Type } from '@sinclair/typebox';

import DmPlugin, { defineRoute, type Role } from '../../abstract/plugin';

export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  roles: Role[] = ['api'] as const;

  api(app: Express): void {
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/v1/ldap/groups/:cn/members`,
      params: Type.Object({ cn: Type.String({ minLength: 1 }) }),
      query: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
      body: Type.Object(
        { member: Type.Union([Type.String(), Type.Array(Type.String())]) },
        { additionalProperties: false }
      ),
      responses: { 200: Type.Object({ added: Type.Number() }) },
      summary: 'Add members to a group',
      tags: ['Groups'],
      handler: async ({ params, query, body, req, res }) => {
        const added = await this.addMembers(params.cn, body.member, {
          dryRun: query.dryRun ?? false,
        });
        res.json({ added });
      },
    });
  }
}
```

The handler has the same duties as an `asyncHandler` callback: it answers
through `res`, and a rejection is passed to the error middleware.

## Inputs

| Field    | Source       | Checked as |
| -------- | ------------ | ---------- |
| `params` | `req.params` | converted  |
| `query`  | `req.query`  | converted  |
| `body`   | `req.body`   | as parsed  |

Path and query values always arrive as strings, so they are converted before
being checked: a `Type.Number()` query accepts `?limit=10` and hands the
handler `10`. The body is whatever the registered parser left in `req.body`.

A part the route declares no schema for is handed to the handler unchecked,
as before.

## Refusals

A request that fails a schema is answered with `400` and a body naming every
failing path:

```json
{
  "error": "Invalid request: body.member: Expected string; query.limit: Expected number"
}
```

`Type.Object` accepts unknown keys unless the schema says
`{ additionalProperties: false }`. A route migrated from hand-written checks
starts without that option, so it refuses no client it accepted before;
tighten it one route at a time.

## The registry

Every declaration is recorded on the app, schemas included. The OpenAPI
generator reads the registry to describe migrated routes, and the route
probe reads it to check that no Express route escapes it. `registeredRoutes(app)`
returns the declarations, without their handlers.
