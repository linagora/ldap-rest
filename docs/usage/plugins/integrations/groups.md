# Organization Groups

`core/twake/groups` is [`core/ldap/groups`](../ldap/groups.md) with one group
branch per organization. It serves the groups of an organization under
`/api/v1/organizations/:id/groups`, in place of the flat `/api/v1/ldap/groups`.

## Behaviour

- An organization's groups and users live in branches given by DN patterns,
  where `{org}` stands for the organization id.
- A group is a `groupOfNames` with a generated `cn` (a UUID), its name in the
  display name attribute, an optional color and its creation date.
- A group's members belong to its organization: adding a user of another
  organization, or of no organization, is refused with a 400, whichever API
  writes the group (REST, SCIM, another plugin). The placeholder
  (`--group-dummy-user`) is the one exception.
- An empty group holds the placeholder, because `groupOfNames` needs a member.
  The placeholder is never listed.
- A tombstone (see [tombstone](tombstone.md)) keeps its memberships until it
  is erased, and is hidden from every member list read through LDAP-Rest.
  A SCIM `PUT` of a group replaces its whole member list, so it drops the
  hidden tombstones too; the routes below add and remove one member at a
  time and keep them. Hiding them costs one search of each organization's
  user branch per search that returns a group with its members, whichever
  plugin makes it.
- An erased member leaves its groups through the directory: enable the
  `refint` overlay on `member`. Unlike `core/ldap/groups`, this plugin does
  not remove a deleted entry from its groups itself, since that write would
  announce a member removed on an erase.
- Every route of an organization whose status says deleted answers 410.

## Routes

Every route answers 404 `ORGANIZATION_NOT_FOUND` when the organization entry
is missing, and 410 `ORGANIZATION_DELETED` when it is deleted. Errors are
`{ "error": "...", "code": "..." }`. A request an authorization plugin refuses
answers 403 `REFUSED`.

A group reads:

```json
{
  "id": "8f14e45f-ceea-467d-9a3e-7c2b0a1d5e10",
  "cn": "8f14e45f-ceea-467d-9a3e-7c2b0a1d5e10",
  "displayName": "Engineering",
  "description": "Engineering team",
  "color": "#3366FF",
  "organizationId": "acme",
  "baseDN": "cn=8f14e45f-ceea-467d-9a3e-7c2b0a1d5e10,ou=groups,ou=acme,dc=example,dc=com",
  "members": ["jdoe"],
  "createdAt": "2026-01-23T11:00:00.000Z"
}
```

`members` are the RDN values of the organization's users. A group without a
display name reads its `cn`.

- `GET /groups?page&limit&search&sortBy&sortOrder`: `search` (2 characters
  or more; an empty one lists everything) matches the display name and the
  description; `sortBy` is `displayName`, `description` or `createdAt`. Answers
  `{ organizationId, groups, pagination: { page, limit, total, totalPages } }`.
- `POST /groups` with `{ name, description?, color? }`: `name` is at most 256
  characters, not blank, without control characters, and unique in the
  organization among groups made here (409 `GROUP_EXISTS`); `color` is `#RGB`
  or `#RRGGBB`. Answers 201 with the group.
- `GET /groups/:groupId`: the group, or 404 `GROUP_NOT_FOUND`.
- `PATCH /groups/:groupId` with any of `name`, `description`, `color`: an
  empty `description` or `color` clears it; any other field is a 400.
- `DELETE /groups/:groupId`.
- `GET /groups/:groupId/members?page&limit&search&sortBy&sortOrder`: the
  members' public profiles, `sortBy` `uid` (default), `displayName`, `mail`
  or `jobTitle`. A member that cannot be read is `{ "uid": "..." }`.
- `POST /groups/:groupId/members` with `{ usernames: [...] }`: every user must
  exist in the organization (404 `USER_NOT_FOUND`, nothing added), at most
  `--twake-group-max-page-limit` per request.
- `DELETE /groups/:groupId/members/:userId`: 404 `MEMBER_NOT_FOUND` for a user
  who is not a member.

Name uniqueness holds for groups made through these routes only: an identity
provider may push two groups of one name, and a SCIM create is never refused
for it.

## Configuration

```bash
--plugin core/twake/groups \
--twake-group-base 'ou=groups,ou={org},dc=example,dc=com' \
--twake-group-user-base 'ou=users,ou={org},dc=example,dc=com' \
--twake-group-organization-dn 'ou={org},dc=example,dc=com' \
--group-class top,groupOfNames,twakeGroup \
--group-dummy-user cn=placeholder \
--group-schema static/schemas/twake/organizationGroups.json
```

- `--group-schema`: `static/schemas/twake/organizationGroups.json` declares
  the groups' `cn`, members and description. The default group schema
  describes department groups and requires `twakeDepartmentLink`, which these
  groups do not have. Groups created through SCIM are written directly and
  are not checked against this schema.
- `--twake-group-base`, `--twake-group-user-base`: required, each with
  `{org}`.
- `--twake-group-organization-dn`: the organization entry. Empty means no
  organization is checked.
- `--twake-group-organization-status-attribute` (default `twakeOrgStatus`),
  `--twake-group-organization-deleted-value` (default `deleted`).
- `--twake-group-display-name-attribute` (default `twakeDisplayName`),
  `--twake-group-color-attribute` (default `twakeGroupColor`),
  `--twake-group-created-at-attribute` (default `twakeCreatedAt`): the
  group's attributes. The group classes (`--group-class`) must allow them.
  The plugin adds them to the loaded group schema under these names, in any
  case, so a renamed attribute needs no schema of its own.
- `--twake-group-max-page-limit` (default 1000): the largest page, and the
  most users added in one request.
- `--twake-group-member-fields`: JSON of `{ field: attribute }` for the member
  profile, over the defaults `uid`, `_id` (`entryUUID`), `cn`, `sn`,
  `givenName`, `displayName`, `mail`, `mobile`, `jobTitle`
  (`twakeJobTitle`), `company` (`twakeCompany`), `organizationRole`
  (`twakeOrganizationRole`) and `organizationId` (`twakeOrganizationId`).
  A profile also has `name` from `sn`, `givenName`, `twakeAdditionalName` and
  `twakeNamePrefix`, and `isTechnical` from `twakeIsTechnical`.
- Tombstones are recognized by `--twake-lifecycle-deleted-attribute` and
  `--twake-lifecycle-deleted-value`, as [tombstone](tombstone.md) writes them.

## Events

[Lifecycle events](lifecycle-events.md) publishes a group's changes from the
directory writes, whichever API made them. A rule for the pattern above:

```json
{
  "dn": "^cn=(?<id>[^,]+),ou=groups,ou=(?<org>[^,]+),dc=example,dc=com$",
  "exchange": "groups",
  "events": {
    "created": {
      "routingKey": "group.created",
      "payload": {
        "organizationId": "$dn.org",
        "id": "$dn.id",
        "name": "$twakeDisplayName",
        "description": "$description",
        "color": "$twakeGroupColor",
        "createdAt": "$twakeCreatedAt",
        "members": { "$members": { "username": "$uid", "email": "$mail" } },
        "timestamp": "$now"
      }
    },
    "updated": {
      "routingKey": "group.updated",
      "payload": {
        "organizationId": "$dn.org",
        "id": "$dn.id",
        "name": "$changed.twakeDisplayName",
        "description": "$changed.description",
        "color": "$changed.twakeGroupColor",
        "timestamp": "$now"
      }
    },
    "memberAdded": {
      "routingKey": "group.member.added",
      "payload": {
        "organizationId": "$dn.org",
        "id": "$dn.id",
        "members": {
          "$added": {
            "username": "$uid",
            "email": "$mail",
            "firstName": "$givenName",
            "lastName": "$sn"
          }
        },
        "timestamp": "$now"
      }
    },
    "memberRemoved": {
      "routingKey": "group.member.removed",
      "payload": {
        "organizationId": "$dn.org",
        "id": "$dn.id",
        "members": { "$removed": { "username": "$uid", "email": "$mail" } },
        "timestamp": "$now"
      }
    },
    "deleted": {
      "routingKey": "group.deleted",
      "payload": {
        "organizationId": "$dn.org",
        "id": "$dn.id",
        "timestamp": "$now"
      }
    }
  }
}
```

Erasing a member publishes no `memberRemoved` when the directory's `refint`
removes it from its groups, since that write does not go through LDAP-Rest.
Without `refint`, the [tombstone](tombstone.md) erase takes the member out
of the groups under `--twake-tombstone-group-bases` itself, through
LDAP-Rest: each of those groups then publishes a `memberRemoved` naming the
member by its RDN. That option defaults to the flat group base, which holds
no group here; point it at the organizations' group branches.

## SCIM groups

SCIM groups take the organization's group branch through SCIM's per-request
group base (`--scim-group-base-header`, `--scim-base-header-root`), the same
classes through `--scim-group-object-class`, and the provider's `externalId`
through `--scim-group-external-id-attribute`. Map SCIM `displayName` to the
display name attribute in `--scim-group-mapping`: the name is kept there,
SCIM reads, updates and `displayName` filters go through it, and a SCIM group
of an organization gets a generated `cn` (a UUID), which is also its SCIM
`id`, and a creation date, as a group made by the routes does. The date is
added only to a group that holds the display name attribute, so classes that
allow the display name must allow the creation date too: the default
attributes both come with `twakeGroup`, but a display name kept in an
attribute `groupOfNames` allows, such as `description`, next to the default
`twakeCreatedAt` makes every SCIM create fail. Without that mapping, a SCIM
group's `cn` is its `displayName`, and the plugin logs a warning at startup. A group whose `cn` is already its `displayName` keeps
that `cn` and `id`.

## Dependencies

```
core/twake/groups
  └─ extends: core/ldap/groups
```
