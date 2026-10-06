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

## Dependencies

```
core/twake/spaces
  └─ requires: core/twake/groups
```
