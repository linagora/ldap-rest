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
  there, and adds the deletion date and the original DN as metadata. The
  native delete is cancelled. `--trash-watched-bases` selects the branches;
  an empty list watches every branch.
- **`core/twake/tombstone`** keeps the entry in place: one modify sets the
  deleted attribute, the deletion date, the reason and the lock, and removes
  the attributes the deployment names. The identifier is reserved until an
  operator erases the tombstone, once the deletion is old enough or
  immediately when forced. Erasing removes the entry and its group
  memberships and announces nothing.

Both run at the end of the `ldapdeleterequest` chain, after every
authorization plugin has judged the delete, so a refused delete changes
nothing. The tombstone is written by the server, not as the caller: the
caller's delete right is what was judged.

SCIM treats a tombstone as gone: reads answer 404, lists omit it, and a create
with the same identity erases the tombstone and creates a new entry. A delete
of an existing tombstone writes nothing and fires `twakedeletionreplay`, so
lifecycle events can replay a lost deletion.

The server refuses to start when a `--trash-watched-bases` entry covers or
sits under a `--twake-tombstone-dn` pattern: the trash would move the entry
before the tombstone saw the delete, and no tombstone would be written.

## Consequences

- A delete is no longer a delete. Code that lists a branch sees what the
  trash or the tombstone left there, filtered by the plugin that owns the
  branch.
- Trash and tombstone cannot watch the same branch; the startup check names
  the overlap.
- A tombstone cannot be restored: clearing its deleted attribute by hand is
  not a supported operation.
- Trash moves the entry, so its DN changes and references to it are not
  rewritten by the move beyond what the directory's `refint` overlay does.
- Tombstones are erased by an explicit operator action, so a retention policy
  has to run it.

See [tombstone](../../usage/plugins/integrations/tombstone.md), the plugin
list in [plugins](../../usage/plugins/README.md), and
`src/plugins/ldap/trash.ts`, `src/plugins/twake/tombstone.ts`.
