# 0006 — Search cache

## Context

Reading one entry by DN is the most frequent operation a route makes: before a
write, before an authorization decision, to render a page. A directory round
trip per read is measurable, and a cache in front of it is easy to add and
hard to keep honest. Serving a stale entry after a write is worse than the
round trip.

## Decision

`SearchCache` caches non-paginated, base-scope searches — single-entry
lookups by DN — keyed by base, scope, filter, attributes, options and values
mode, in an LRU bounded by `--ldap-cache-max`. It is **off by default**
(`--ldap-cache-ttl=0`): no deployment has run with it on, and turning it on
for everyone would be a silent behaviour change.

`ldapActions` drops, around every write it makes through this process:

- the reads of the entry written and of its subtree (a rename or a move
  re-parents a whole branch);
- the `memberOf` of the members a group change adds or removes;
- the reads of entries naming the entry renamed or deleted, because the
  directory's `memberof` and `refint` overlays rewrite them.

Entries are dropped before the directory call as well as after it, and a
generation counter stops a read that started before the write from storing
its stale answer afterwards. DNs are compared the way the directory does:
case, spacing, escapes, aliases and multi-valued RDN order do not matter.

Writes made elsewhere — another replica, an LSC synchronisation, a hand-run
`ldapmodify` — do not invalidate anything. Each process caches on its own.

## Consequences

- Enable the cache only when this service is the only writer, or when serving
  an entry up to `--ldap-cache-ttl` seconds old is acceptable.
- A read of a subtree, a paged search or a filter is never cached; the cache
  does not accelerate listings.
- The cache does not lift a miss: a read of an absent DN throws and caches
  nothing.
- The invalidation rules follow the overlays this project documents
  (`memberof`, `refint`); a deployment with an overlay that rewrites other
  entries must accept a miss or leave the cache off.

See [configuration](../../usage/configuration.md#the-search-cache) and
`src/lib/ldap/searchCache.ts`.
