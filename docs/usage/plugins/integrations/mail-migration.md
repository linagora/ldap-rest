# Mail migration proxy

`core/twake/migrationProxy` keeps the migrated-users list of the
[Twake Mail migration proxy](https://github.com/linagora/tmail-backend/blob/master/docs/modules/ROOT/pages/migration-proxy/objective.adoc)
in step with the directory, while a mail platform is moved to Twake Mail.

The proxy sits in front of the old and the new mail backends. It relays
each IMAP (and, when enabled, submission) connection to the backend hosting
the authenticated user, and routes each inbound recipient to the backend
hosting it. An address on its migrated list lives on the new backend; any
other address lives on the old one. An account created during the migration
has no mailbox on the old system, so it has to be on the list before its
first login and its first mail: this plugin puts it there, and keeps the
addresses of a migrated account on the list as they change.

Load it for the duration of the migration, next to `core/twake/james`, and
drop it once the old backend is gone. It requires `core/ldap/onChange`.

## Scope

Only the entries under `--migration-proxy-branch` are followed, the
branches holding the accounts whose addresses the proxy routes: users, and
the groups whose address is a team mailbox or a mailing list when those are
created during the migration, as inbound mail for them is routed by
recipient too. Keep out the branches whose entries carry an address that is
not their own, the applicative accounts of
[app-accounts](app-accounts.md) for instance: they would put their owner on
the list or take it off.

The addresses of an entry are every value of `--mail-attribute` and of
`--alias-attribute`, the first mail being the one that says where the
account lives. The proxy folds usernames to lower case, so a change of case
is no change.

## Behaviour

Through the `onLdapEntryChange` hook, after the write has answered, one
entry at a time:

- An entry that gains its mail, when created or later, is put on the list
  with all its addresses: `PUT /migratedUsers/{address}`.
- An entry that keeps its mail and whose addresses change asks the proxy
  about its first mail (`HEAD /migratedUsers/{mail}`). When the account is
  migrated, the addresses it gained are put on the list, then the ones it
  lost are taken off, once every addition holds; a user the proxy does not
  know is on the old system, and its change is left to the migration, which
  puts the new addresses on the list when it moves the mailbox.
- An entry deleted, or losing its mail, is taken off the list with all its
  addresses: `DELETE /migratedUsers/{address}`. A tombstone or a trashed
  entry keeps its address, so it stays on the list until it is erased.

The plugin cannot tell a new account from an existing one whose mail was
cleared and set again, or from one created anew over its tombstone: those
are put on the list too. Marking the existing accounts migrated is the
migration's job, through the proxy's webadmin or its `migration:switch`
exchange.

### Failures

A call the proxy answers with 500, 502, 503 or 504 is made again,
`--migration-proxy-retry-attempts` times in all, after
`--migration-proxy-retry-delay` milliseconds times the number of attempts
made. A refusal, such as 400 for an address the proxy does not take as a
username, and a call the proxy does not answer at all, connection refused
or reset, are not. Each failed attempt logs a warning, the last failure an
error naming the address, the call and the entry. Every call is counted in
the [outbound metrics](../../operations.md#metrics), under the target
`migrationProxy`.

A failed `PUT` leaves the account routed to the old backend, where it does
not exist: watch those errors, and put the address on the list by hand
through the proxy's webadmin. When the proxy has not said whether a renamed
account is migrated, nothing is changed and the error is logged.

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
--migration-proxy-token "$MIGRATION_PROXY_TOKEN" \
--migration-proxy-branch "ou=users,dc=example,dc=com"
```

The options are listed in
[configuration](../../configuration.md#coretwakemigrationproxy).
