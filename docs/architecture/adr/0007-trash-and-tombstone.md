# 0007 — Trash and tombstone

## Context

Deleting an entry destroys the identifiers it held: a mail address, a login, a
DN. An administrator who deletes the wrong account cannot undo it, and a
deleted account's address can be taken by a new one immediately — which, for a
mail system, means the new account receives the old one's mail. The directory
has no undelete of its own.

## Decision

Two plugins answer a delete at the `ldapdeleterequest` hook, and a deployment
picks one per branch:

- **`core/ldap/trash`** moves the entry, by an atomic `modifyDN`, to a trash
  branch under `--trash-base`, overwriting an earlier entry with the same RDN
  there; unless `--trash-add-metadata=false`, it then replaces `description`
  with the deletion date and the original DN, a failure there being logged
  and not fatal. The native delete is cancelled. `--trash-watched-bases`
  selects the branches; an empty list watches every branch.
- **`core/twake/tombstone`** keeps the entry in place: one modify sets the
  deleted attribute and the lock, the deletion date and the reason when their
  attributes are configured, and removes the attributes the deployment names.
  The identifier is reserved until an operator erases the tombstone, once the
  deletion is old enough or immediately when forced. Erasing removes the entry
  and its group memberships and announces nothing.

The tombstone moves itself last in the `ldapdeleterequest` and
`ldapaddrequest` chains (`hookBus.toLast`), so every plugin that may refuse
has judged. The trash does not: it runs in load order, after the authorization
judges but possibly before another plugin that can refuse a delete
(`organizations`, `enterpriseRules`, `james`). A plugin that refuses a delete
and loads after the trash refuses one that has already been moved. The
tombstone is written by the server, not as the caller: the caller's delete
right is what was judged.

SCIM treats a tombstone as gone: its reads carry a not-deleted filter, so
reads answer 404 and lists omit it; a create with the same identity erases
the tombstone and creates a new entry. A non-SCIM delete of an existing
tombstone writes nothing and fires `twakedeletionreplay`, so lifecycle events
can replay a lost deletion. A SCIM DELETE never gets there: its existence
check hides the tombstone and answers 404.

The server refuses to start when the tombstone is loaded beside the trash and
any watched branch overlaps a `--twake-tombstone-dn` pattern: the trash would
move the entry before the tombstone saw the delete, and no tombstone would be
written. An empty `--trash-watched-bases` watches every branch, so it overlaps
any pattern and refuses too.

## Consequences

- A delete is no longer a delete. Code that lists a branch sees what the
  trash or the tombstone left there, filtered by the plugin that owns the
  branch.
- Trash and tombstone cannot watch the same branch; the startup check names
  the overlap.
- A deployment that loads the trash must load it before the plugins that can
  refuse a delete, or accept that a refusal can come after the entry moved.
- A tombstone cannot be restored: clearing its deleted attribute by hand is
  not a supported operation.
- Trash moves the entry, so its DN changes and references to it are not
  rewritten by the move beyond what the directory's `refint` overlay does.
- Tombstones are erased by an explicit operator action, so a retention policy
  has to run it.

See [tombstone](../../usage/plugins/integrations/tombstone.md), the plugin
list in [plugins](../../usage/plugins/README.md), and
`packages/ldap-trash/src/trash.ts`, `src/plugins/twake/tombstone.ts`.
