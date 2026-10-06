# Organization Spaces

`core/twake/spaces` serves the spaces of an organization under
`/api/v1/organizations/:id/spaces`. A space gathers users and groups of the
organization, each with a role in it: `viewer`, `editor` or `admin`.

## Behaviour

- A space lives in the organization's space branch, given by a DN pattern
  where `{org}` stands for the organization id. Its `cn` is a generated UUID,
  its name is in the display name attribute.
- A space holds DNs in three attributes, one per role. Each holds users of
  the organization's user branch and groups of its group branch, the
  branches [groups](groups.md) serves.
- A user or a group holds one role in a space. A user's role in a space is
  the strongest of their own role and the roles of the linked groups they
  belong to.
- The routes keep at least one admin among a space's users: a request that
  would demote or remove the last one is refused with 409 `LAST_ADMIN`. A
  linked group does not count as an admin. A tombstoned or erased admin is
  not a request, and can leave a space with none.
- A space holds users and groups of its organization only: any other value is
  refused with a 400, whichever API writes the space. The one role and the
  admin are kept by the routes below only; a user or group a direct write, or
  two requests at once, left under two roles reads with the strongest, and a
  role change or removal takes it out of all of them.
- A tombstone (see [tombstone](tombstone.md)) keeps its roles until it is
  erased, and is hidden from the spaces read through these routes. It cannot
  be added.
- An erased user or group leaves its spaces through the directory: enable the
  `refint` overlay on the three role attributes.
- When a user who is erased or becomes a tombstone was the last admin among
  a space's users, its editors become admins, or its viewers when it has no
  editor. A space left with no user of its own is deleted, whatever groups
  it links. Both happen shortly after the deletion, and publish their
  events. Erasing a tombstone checks its spaces again, for a hand-over that
  failed or was never made. The hand-over relies on refint: without it an erased admin's DN
  stays in the space and still counts as an admin, so erasing two admins
  one after the other hands nothing over. A write of the space made at the
  same moment is retried twice; past that the hand-over is logged and left
  undone.
- With `--twake-space-user-role-attribute`, each user entry holds one
  `<space id>:<role>` value per space they are in, their resolved role. It
  follows every write of a space, every change of a linked group's members,
  and the deletion of a linked group, whichever API makes them, shortly after
  the write. A change only tells which users to look at: each one's values
  are then rewritten from the directory as it is, so changes made close
  together end the same whatever order they are followed in. Values not
  ending in `:viewer`, `:editor` or `:admin` are left alone. A tombstone keeps
  the values it held when it was deleted. The plugin refuses to start when
  core/ldap/trash watches the group branches: a group it moves away is never
  followed.
- With `--rabbitmq-url`, every write of a space and every change of a
  member's role is published as an event, see below.

## Events

Each event goes to the `--twake-space-exchange` topic exchange with the
routing key `twake.space.<event>`. Like the user role attribute, events follow
every write, whichever API makes it, shortly after it.

```json
{
  "organizationId": "acme",
  "id": "3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091",
  "members": [
    {
      "uuid": "6f1c0a52-8e3b-4d7f-a9c2-5b0e1d4f7a83",
      "username": "jdoe",
      "email": "jdoe@acme.example.org",
      "firstName": "John",
      "lastName": "Doe",
      "role": "editor"
    }
  ],
  "actor": "jsmith",
  "timestamp": "2026-10-06T09:12:44.512Z"
}
```

Every event carries `organizationId`, `id` (the space), `actor` (who made
the write, when known) and `timestamp`. A member is described as above, its
`uuid` the user's `entryUUID`; a group is `{ id, name, role }`.

- `created`: `name`, `members` (every user in the space with their resolved
  role, linked groups' members included) and `groups`.
- `updated`: the changed `name`.
- `deleted`.
- `member.added`, `member.role.changed`, `member.removed`: `members`, the one
  user whose resolved role changed, whatever the cause: a member write, a
  group linked, unlinked or given another role, a user joining or leaving a
  linked group. `member.removed` gives the role the user held.
- `group.linked`, `group.role.changed`, `group.unlinked`: `groups`, the one
  group, with its name when the event is published. A deleted group is
  unlinked from each of its spaces once, whether refint or a later write
  takes its DN out of them. Renaming a linked group publishes nothing.

A user who is deleted or becomes a tombstone publishes no member event.

The server does not start when the broker cannot be reached. An event the
broker drops later is logged with `result: "no broker"` and not sent again.

Member events compare each moved user's roles before and after a change:

- With `--twake-space-user-role-attribute`, the roles before are the values
  on the user's entry, so changes made close together announce each role
  once, in whatever order they are followed.
- Without it, the roles before are worked out from the directory with the
  change undone. Two changes followed late may announce a role twice, or
  not at all. Consumers that need an exact copy resync from the routes.

## Routes

Every route answers 404 `ORGANIZATION_NOT_FOUND` when the organization entry
is missing, and 410 `ORGANIZATION_DELETED` when it is deleted. Errors are
`{ "error": "...", "code": "..." }`. A write answers `{ "success": true }`
unless stated otherwise.

A space reads, strongest role first:

```json
{
  "id": "3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091",
  "name": "Design Sprint",
  "organizationId": "acme",
  "members": [
    { "username": "jsmith", "role": "admin" },
    { "username": "jdoe", "role": "editor" }
  ],
  "groups": [{ "id": "c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17", "role": "viewer" }]
}
```

`username` is the RDN value of a user, `id` the `cn` of a group.

- `GET /spaces?page&limit&search&sortBy&sortOrder&user`: `search` (2
  characters or more) matches the name; `sortBy` is `name`. With `user`, the
  spaces that user is in, directly or through a linked group, each with the
  user's `role` (404 `USER_NOT_FOUND` for an unknown user). Answers
  `{ organizationId, spaces, pagination: { page, limit, total, totalPages } }`.
- `POST /spaces` with `{ name, members: [{ username, role }], groups?: [{ id, role }] }`:
  `name` follows the [groups](groups.md) rule, `members` holds at least one
  admin (400 `ADMIN_REQUIRED`), every user and group must exist in the
  organization (404 `USER_NOT_FOUND`, `GROUP_NOT_FOUND`). Answers 201 with the
  space.
- `GET /spaces/:spaceId`: the space, or 404 `SPACE_NOT_FOUND`.
- `PATCH /spaces/:spaceId` with `{ name }`: renames the space; any other
  field is a 400.
- `DELETE /spaces/:spaceId`.
- `GET /spaces/:spaceId/members?page&limit&search&sortBy&sortOrder`: the
  members' public profiles, as [groups](groups.md) answers them, each with
  its `role`; `sortBy` is `uid` (default), `displayName`, `mail`, `jobTitle`
  or `role`.
- `POST /spaces/:spaceId/members` with `{ usernames: [...], role }`: every
  user must exist in the organization (404 `USER_NOT_FOUND`, nothing added),
  at most `--twake-group-max-page-limit` per request, as for every list of
  users or groups below.
  A member already holding that role is left as is; one holding another role
  answers 409 `MEMBER_EXISTS`, nothing added.
- `PATCH /spaces/:spaceId/members/:userId` with `{ role }`, and
  `DELETE /spaces/:spaceId/members/:userId`: 404 `MEMBER_NOT_FOUND` for a
  user who is not a member.
- `GET /spaces/:spaceId/groups`: `{ organizationId, id, groups }`, each group
  `{ id, name, role }`, by name.
- `POST /spaces/:spaceId/groups` with `{ groupIds: [...], role }`: every group
  must exist in the organization (404 `GROUP_NOT_FOUND`, nothing linked). A
  group already linked with another role answers 409 `GROUP_ALREADY_LINKED`.
- `PATCH /spaces/:spaceId/groups/:groupId` with `{ role }`, and
  `DELETE /spaces/:spaceId/groups/:groupId`: 404 `GROUP_NOT_FOUND` for a group
  that is not linked.

## Configuration

```bash
--plugin core/twake/spaces \
--twake-space-base 'ou=spaces,ou={org},dc=example,dc=com'
```

The plugin loads [groups](groups.md), and reads its options for the
organization's users, groups and organization entry.

- `--twake-space-base`: required, with `{org}`.
- `--twake-space-class` (default `top,twakeSpace`): the classes of a space
  created.
- `--twake-space-display-name-attribute` (default `twakeDisplayName`).
- `--twake-space-admin-attribute` (default `twakeSpaceAdmin`),
  `--twake-space-editor-attribute` (default `twakeSpaceEditor`),
  `--twake-space-viewer-attribute` (default `twakeSpaceViewer`): the role
  attributes, holding DNs.
- `--twake-space-user-role-attribute` (no default): the multi-valued user
  attribute holding the user's role in each space, such as `twakeSpaceRole`.
  Unset, no user entry is written.
- `--twake-space-exchange` (default `space`): the topic exchange of the
  events, published only when `--rabbitmq-url` is set.

## Dependencies

```
core/twake/spaces
  ├─ requires: core/twake/groups
  ├─ requires: core/ldap/onChange
  └─ requires: core/rabbitmq (with RabbitMQ)
```
