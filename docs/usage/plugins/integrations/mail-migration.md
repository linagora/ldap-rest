# Mail migration proxy

`core/twake/migrationProxy` keeps the migrated-users list of the
[Twake Mail migration proxy](https://github.com/linagora/tmail-backend/blob/master/docs/modules/ROOT/pages/migration-proxy/objective.adoc)
in step with the accounts of the directory, while a mail platform is moved
to Twake Mail.

The proxy sits in front of the old and the new mail backends. It relays
each IMAP (and, when enabled, submission) connection to the backend hosting
the authenticated user, and routes inbound mail per recipient. A user on its
migrated list lives on the new backend; any other user lives on the old one.
An account created during the migration has no mailbox on the old system,
so it has to be on the list before its first login: this plugin puts it
there.

Load it for the duration of the migration, next to `core/twake/james`, and
drop it once the old backend is gone.

## Behaviour

Through the `onLdapEntryChange` hook, after the write has answered:

- An entry that gains a mail address, when created or later, is put on the
  list: `PUT /migratedUsers/{mail}`. Groups (`groupOfNames`,
  `groupOfUniqueNames`, `groupOfURLs`) are left alone: the list is keyed by
  the users who log in, and the address of a group is a mailing list or a
  team mailbox.
- A user whose mail address changes keeps its side. When the proxy says the
  old address is migrated (`HEAD /migratedUsers/{old}` answers 204), the new
  address is put on the list, then the old one taken off. A user the proxy
  does not know is on the old system: its rename is left to the migration,
  which will put the new address on the list when it moves the mailbox.
- An account deleted, or losing its mail address, is taken off the list:
  `DELETE /migratedUsers/{mail}`. A tombstone or a trashed entry keeps its
  address, so it stays on the list until it is erased.

Only the first value of `--mail-attribute` is sent; aliases are not, as the
proxy routes on the address the user logs in with and James resolves
aliases on its side.

A call the proxy answers with 500, 502, 503 or 504 is retried,
`--migration-proxy-retry-attempts` times in all, `--migration-proxy-retry-delay`
milliseconds times the number of attempts made between two; a refusal, such
as 400 for an address the proxy does not take as a username, is not. The
last failure is logged as an error with the address and the call, and every
call is counted in the
[outbound metrics](../../operations.md#metrics) under
`plugin="migrationProxy"`. A failed `PUT` leaves the account routed to the
old backend, where it does not exist: watch those errors, and put the
address on the list by hand through the proxy's webadmin.

Marking existing accounts migrated is the migration's job, through the
proxy's webadmin or its `migration:switch` exchange; this plugin never does
it.

## Where an account lives

`GET /api/v1/users/:user/mail-migration` answers `{ "migrated": true }`
when the proxy routes the user to the new backend, `{ "migrated": false }`
otherwise, from the proxy's `HEAD`. The user is found by `uid` across the
directory, and answered only when the caller may read the entry: another
one gets 404, as a user that is not there. A user without mail gets 400,
and a proxy that does not answer 502.

## Readiness

The plugin asks the proxy's `GET /healthcheck` for `/readyz`, and reports
`degraded` when it answers an error or not within 1.5 s, see
[what the shipped plugins report](../../operations.md#what-the-shipped-plugins-report).

## Configuration

```bash
--plugin core/ldap/onChange \
--plugin core/twake/james \
--plugin core/twake/migrationProxy \
--migration-proxy-url http://migration-proxy:8000 \
--migration-proxy-token "$MIGRATION_PROXY_TOKEN"
```

| Option                             | Env                                 | Default | Description                                                               |
| ---------------------------------- | ----------------------------------- | ------- | ------------------------------------------------------------------------- |
| `--migration-proxy-url`            | `DM_MIGRATION_PROXY_URL`            |         | Webadmin URL of the proxy; the plugin refuses to start without it         |
| `--migration-proxy-token`          | `DM_MIGRATION_PROXY_TOKEN`          |         | Bearer token, when the webadmin asks for one                              |
| `--migration-proxy-concurrency`    | `DM_MIGRATION_PROXY_CONCURRENCY`    | `10`    | Calls to the proxy at once                                                |
| `--migration-proxy-retry-attempts` | `DM_MIGRATION_PROXY_RETRY_ATTEMPTS` | `5`     | Attempts in all of a call the proxy answers 5xx; `1` disables the retries |
| `--migration-proxy-retry-delay`    | `DM_MIGRATION_PROXY_RETRY_DELAY`    | `1000`  | Base wait between two attempts, in ms; the wait grows with the attempt    |

Requires `core/ldap/onChange`.
