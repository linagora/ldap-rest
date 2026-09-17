# Directory console

A complete administration interface — the equivalent of what an administrator
does in _Active Directory Users and Computers_ and in the _Exchange Admin
Center_, served by `ldap-rest` itself.

It is built entirely from what the server advertises. `GET /v1/config` gives
the entities, their schemas and their endpoints; `GET /v1/authz/scope` gives
what the signed-in administrator may do. No entity name, attribute name or
label is written in the console, so a deployment that names its things
differently gets its own interface without a change.

## Using it

```html
<link rel="stylesheet" href="/static/browser/directory-console.css" />
<div id="console"></div>
<script type="module">
  import { DirectoryConsole } from '/static/browser/directory-console.esm.js';
  await new DirectoryConsole({ containerId: 'console' }).init();
</script>
```

A ready-made page ships with the repository. Serve the repository root and
open it:

```sh
node bin/index.mjs --plugin core/static --static-path . …
# http://localhost:8081/static/examples/web/directory-console.html
```

```ts
new DirectoryConsole({
  containerId: 'console',
  apiBaseUrl: 'https://directory.example.org', // defaults to the page's origin
  apiPrefix: '/ldap', // only if the server does not serve the API under `/api`
  language: 'fr', // defaults to the browser's, falling back to English
});
```

`apiPrefix` exists because everything else is asked at the prefix
`GET {apiPrefix}/v1/config` advertises — and that one request has nothing to
read it from. A server started without `--api-prefix` needs neither option.

An `apiBaseUrl` on another origin makes every call a cross-origin one, sent
with credentials: that deployment has to allow the console's origin _and_
credentials in its CORS policy, or the browser drops the answer.

## What the server has to expose

| Plugin                       | What the console does with it                      |
| ---------------------------- | -------------------------------------------------- |
| `core/configApi`             | Discovers the entities and their schemas           |
| `core/ldap/flatGeneric`      | Lists, reads, creates, updates and deletes entries |
| `core/ldap/groups`           | Same, for groups                                   |
| `core/ldap/organizations`    | The tree, with `--organization-schema` set         |
| `core/ldap/accountLifecycle` | The state and password actions on an account       |
| `core/auth/authzScope`       | The scope banner, and which actions to offer       |

Only `core/configApi` and one entity plugin are required; the rest add
capabilities as they are loaded.

## What the schema drives

Everything the console shows about an attribute comes from its schema
definition — see [flat-generic](../../usage/plugins/ldap/flat-generic.md).

| Schema                  | Effect in the interface                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `label`                 | Column heading, field label, term in the detail card                      |
| `hint`                  | Shown under the field, and repeated when a value is refused               |
| `test`                  | Checked before the round trip, so the hint answers before the server does |
| `required`              | Marked with `*`, with the legend that explains it                         |
| `generated`, `readOnly` | Shown on the detail card, never offered for editing                       |
| `neverReturn`           | Offered on the form, never shown back                                     |
| `type: array`           | A list of removable tokens, with the instruction to press Enter           |
| `type: pointer`         | A select filled from the branch the pointer names                         |
| `type: boolean`, `date` | A yes/no select, a date picker                                            |
| `group`                 | Groups the fields under a heading                                         |
| `states`                | The states the account can be moved to                                    |
| `role`                  | Which columns the table shows, and which actions appear                   |

## Behaviour worth knowing

- **Long forms open as a side panel**, short ones as a dialog. A form of
  twenty fields inside a modal puts its Save button off screen.
- **The search covers every field the schema marks `searchable`**, not the
  identifier alone, and the selector still narrows it to one. A schema that
  marks nothing is guessed at, which is why a large branch should mark its
  indexed attributes — see
  [flat-generic](../../usage/plugins/ldap/flat-generic.md).
- **A large branch is not listed unfiltered.** Entities attached to an
  organization ask for three characters before searching; the small reference
  tables are listed whole.
- **The page size is remembered**, along with the chosen language.
- **A deep organization path is shortened** to its root and its leaf, with the
  whole path in the cell's tooltip.
- **The tree stays on screen** while a node is read or edited.
- **The scope is shown permanently** — which branches the caller administers,
  and with which rights. An action they cannot perform is not offered. A
  server that does not load `core/auth/authzScope` restricts nothing and the
  console says so; a scope request that _fails_ is a different thing, and the
  console then offers no write action at all rather than every one of them.
- **The interface is in one language at a time**, and the whole of it, not
  only the chrome. Two catalogues meet: the console's own, which holds the
  interface words (`Search`, `Per page`, `Delete selection`) and ships with the
  product; and the schema's `label` / `entity.label`, which names _your_
  entities and attributes and travels with your configuration. Neither knows
  the other's words, which is what lets a deployment be fully translated
  without the product learning its vocabulary.

  A lifecycle state is named by the console when it is one it knows —
  `enabled`, `disabled`, `noAccess`, `toDelete` — and keeps the name the
  deployment gave it otherwise. The chosen language is remembered.

## Exported pieces

The bundle exports the components as well as the application, for a client
that wants to assemble its own:

```ts
import {
  DirectoryConsole,
  ConsoleApiClient,
  EntityList,
  EntityDetail,
  EntityForm,
  OrganizationTree,
  Translator,
  roleAttribute,
} from 'ldap-rest/browser-directory-console-index';
```

## Filling a pointer field

A `pointer` names a branch, and the console fills the select from it:

- the branch of the organization tree is walked through the organization
  endpoints, so a department field lists organizations by their readable path;
- a branch that is the base of a known entity is listed through that entity;
- any other branch is read through `core/ldap/raw`, so load that plugin for
  nomenclature branches (titles, list types, delivery modes) to be offered.
  Without it the select keeps the value the entry already holds and offers no
  others.

## Adding a language

The console ships with English and French. A third one is a catalogue in
`src/browser/directory-console/i18n.ts` plus, on the deployment side, the
matching key in every schema `label`. The schema test in
`test/schemas/twakeUsersSchema.test.ts` fails when a shipped schema leaves an
attribute unnamed or untranslated, which is what keeps a half-translated
screen from shipping.

## Known limits

- The list endpoint returns a whole branch: the search guard keeps that
  workable, but a search matching many thousands of entries is still fetched
  in full. Server-side pagination would remove the need for the guard.
- Moving an entry between organizations is exposed by the API
  (`POST {entity}/:id/move`) but has no control in the interface yet.
- Bulk actions cover export and deletion; assignment is not there yet.
- The exported CSV neutralises a cell a spreadsheet would read as a formula by
  prefixing it with an apostrophe, so such a value comes back with one.
- There is no sign-out control. The console never authenticates anyone — it
  sends whatever credential the browser already holds for the API — so ending
  a session is the host application's to offer, not its own.
- The members listed under an organization's card stop at
  `ldap_organization_max_subnodes` (50 by default) and the card does not say
  it truncated. The tree itself is unaffected: child organizations are asked
  for by class and are not capped.
