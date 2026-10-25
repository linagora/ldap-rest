# Back-Channel Logout

Honouring a logout the provider performed elsewhere.

## Overview

When someone logs out at the OpenID Provider — or an administrator ends their
sessions — the provider sends a **logout token** to every application that
asked for one. Without it, an application keeps honouring its own cookie: the
session stays alive until it expires on its own, which is exactly what a
logout is supposed to prevent.

`core/bcl` records what such a token killed, and `core/auth/openidconnect`
asks, on every request, whether the session it holds is still alive.

**Nothing here stores a session.** A logout token only leaves a _tombstone_
saying that one `sid`, or every session of one `sub`, is dead. Sessions stay
in their cookie, and the storage holds only what died — which is what keeps
it small.

## The Server's Own `/logout`

A provider sends logout tokens to the other applications, not to the one
that asked it to log out. So `core/auth/openidconnect` records the session
its own `/logout` ends, as a logout token naming it would: by the id it gave
that session at login, kept in the cookie, which ends that one session and
leaves the person's others alone. The same person logging in again over a
live session keeps its id, so a copy taken before is ended with it.

A session from before that id existed is named by the provider's `sid`, when
it sent one. A provider that sends none (Dex) leaves such a session
unnamed: its copies keep working until its tokens expire, and the first
`/logout` of one logs a warning. That lasts until those sessions have
expired, a week at most.

Without `core/bcl`, `/logout` drops the browser's cookie and nothing else,
and a copy of it keeps working until its tokens expire.

A plugin subscribing to `oidclogouttoken` receives `{ iss, session }` from
`/logout`, with neither `sid` nor `sub`: `session` names one session of this
server, and is matched against the `session` that `oidcsessionvalid`
carries.

## Configuration

```bash
--plugin core/auth/openidconnect \
--plugin core/storage --storage-backend file --storage-file-directory /var/lib/ldap-rest/storage \
--plugin core/bcl --bcl-retention 604800
```

| Option            | Environment        | Default  | Description                 |
| ----------------- | ------------------ | -------- | --------------------------- |
| `--bcl-retention` | `DM_BCL_RETENTION` | `604800` | Seconds a tombstone is kept |

Where the marks live, and how often expired ones are reclaimed, belongs to
[`core/storage`](../utilities/storage.md) — `core/bcl` keeps only the policy.

At the provider, register the back-channel logout URI:

```
https://ldap-rest.example.com/backchannel-logout
```

## Retention

A tombstone has to outlive the session it kills, or a cookie older than the
mark would be honoured again. The default matches `express-openid-connect`'s
own seven-day session; shorten it only alongside the session lifetime.

A copy of a session `/logout` ended is refused, so no longer renewed: it
dies a day after its last use at the latest, the cookie's rolling lifetime.
While the store cannot answer, though, a copy is still renewed, up to the
week; keep the retention at the session lifetime.

Expiry is enforced when the mark is read, not only when the sweeper passes,
so a late sweeper never keeps out someone who has since logged in again.

## `core/bcl` Refuses to Start Without Storage

`core/storage` must be loaded and `--storage-backend` set, or the plugin
throws at startup.

That is deliberate. A logout check that quietly does nothing would leave
every session outliving the logout that closed it, and nothing would say so.
For a feature that can be skipped, a warning is the right answer; for this
one, a refusal to start is the honest failure.

The refusal answers for the configuration, not for the order it is written
in. `core/bcl` declares `core/storage` as a dependency, so a configuration
naming only `core/bcl` loads the store anyway; and `core/storage` is in the
priority list, so one that names both gets a single instance whichever comes
first.

## What a Login Forgets

A mark on the `sub` kills every session of that person. Left in place it
would also kill the sessions created _after_ it, for the whole retention —
so a successful login clears the marks matching its own claims.

This has a consequence worth knowing, which the SDK's own default shares: a
login also revives sessions that a "log out everywhere" token killed without
naming a `sid`.

## Failures Are Not Swallowed

If the store cannot record a tombstone, the provider is answered `400` rather
than `204`. A provider retries a `400`; a `204` tells it a logout was honoured
that nothing kept.

## See Also

- [Storage](../utilities/storage.md) — where the marks live
- [OpenID Connect](oidc.md)
