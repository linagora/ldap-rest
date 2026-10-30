# Declaring routes

`defineRoute` declares an HTTP route once: its inputs, their schemas, what
the OpenAPI document says of it, and the handler. The schemas are checked
before the handler runs, the openapi generator describes the route from the
declaration, and the route probe finds it in the registry.

```typescript
import { Type } from '@sinclair/typebox';
import type { Express } from 'express';

import DmPlugin, { defineRoute, type Role } from '../../abstract/plugin';

/** Exported: the OpenAPI generator reads it without running the plugin. */
export const GroupParams = Type.Object({
  cn: Type.String({ minLength: 1 }),
});

export const GroupQuery = Type.Object({
  dryRun: Type.Optional(Type.Boolean()),
});

export const GroupMembers = Type.Object(
  { member: Type.Union([Type.String(), Type.Array(Type.String())]) },
  { additionalProperties: false }
);

export const MembersAdded = Type.Object({ added: Type.Number() });

export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  roles: Role[] = ['api'] as const;

  api(app: Express): void {
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/v1/ldap/groups/:cn/members`,
      params: GroupParams,
      query: GroupQuery,
      body: GroupMembers,
      responses: {
        200: { schema: MembersAdded, description: 'Members added' },
      },
      summary: 'Add members to a group',
      tags: ['Groups'],
      handler: async ({ params, query, body, res }) => {
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

## Schemas

Each schema is an **exported constant**, possibly imported from another
module. `npm run generate:openapi` does not run the plugin: it finds the
`defineRoute` call in the source, imports the module that exports each
schema, and reads its value — a TypeBox schema is JSON Schema already. A
schema written inline in the declaration is checked at runtime but is not
in the document, and the generator warns about it.

Keep in mind that the schemas are part of the published API: give the
properties a `description`, or rely on what TypeBox emits.

## Inputs

| Field    | Source       | Checked as |
| -------- | ------------ | ---------- |
| `params` | `req.params` | converted  |
| `query`  | `req.query`  | converted  |
| `body`   | `req.body`   | as parsed  |

Path and query values always arrive as strings, so they are converted before
being checked: a `Type.Number()` query accepts `?limit=10` and hands the
handler `10`. The body is whatever the registered parser left in `req.body`;
a request carrying none is checked as an empty object, so an all-optional
schema accepts it and a required field is refused by name.

A part the route declares no schema for is handed to the handler unchecked,
as before. The declaration feeds the document the same way: `params` becomes
the path parameters, `query` the query parameters, `body` the JSON request
body, and `responses` the answers; the standard 400/401/404/500 entries stay.

An answer is a schema, or `{ schema, description }` when the document needs
a sentence of its own:

```typescript
responses: {
  200: { schema: MembersAdded, description: 'Members added' },
  409: { schema: AlreadyMember, description: 'Already a member' },
  500: ErrorSchema,
}
```

Only the parameters the path actually carries (`:cn` → `{cn}`) become path
parameters: a `params` key the path does not name is reported by the
generator and left out, since OpenAPI refuses it.

## Refusals

A request that fails a schema is answered with `400` and a body naming every
failing path:

```json
{
  "error": "Invalid request: body.member: Expected string; query.limit: Expected number"
}
```

A caller whose `Accept` excludes JSON is answered `400 Bad request` before
the handler runs. A route serving another media type sets `json: false` and
answers it itself; SCIM does, for `application/scim+json`. Its declared
schemas are still checked first, and a failure there is answered in the REST
shape (`Invalid request: …`): such a route validates the rest of its input
itself. The handler also receives Express's `next`, for a route that falls
through or has already answered.

`Type.Object` accepts unknown keys unless the schema says
`{ additionalProperties: false }`. A route migrated from hand-written checks
starts without that option, so it refuses no client it accepted before;
tighten it one route at a time.

## The registry

Every declaration is recorded on the app, schemas included, without its
handler. `registeredRoutes(app)` returns them, and `unregisteredRoutes(app)`
lists what the Express stack carries that `defineRoute` did not declare.

## The migration guard

`npm run lint` refuses `app.<verb>(` under `src/plugins` and `src/abstract`,
through `eslint-rules/no-raw-route.mjs`. The files still to migrate are
listed in `eslint-rules/route-allowlist.json`; remove a file from it as its
routes move. `test/scripts/routeAllowlist.test.ts` keeps the list exact: a
file that no longer declares a raw route must leave it, and a raw route in an
unlisted file fails.
