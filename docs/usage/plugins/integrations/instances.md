# Workplace Instances

`core/twake/instances` gives every account this server creates its workplace
instance. It replaces `core/twake/cozyProvision` and
`core/twake/clouderyProvision`, and refuses to start when either is loaded
too. What changes when moving to it is in the
[upgrade notes](../../upgrading.md#twakeinstances-replaces-cozyprovision-and-clouderyprovision).

Every account must be created through this server (REST, SCIM, the LSC
plugin, scripts through the API). An entry written straight to the directory
gets no instance.

## Behaviour

- Once an add has written an entry whose DN matches `--twake-instance-dn`,
  the instance is looked up, then asked for if missing, before the add
  answers (through the
  [`ldapaddafter`](../../../plugin-development/hooks.md#ldapaddafter) hook).
  An entry holding `--twake-instance-skip-value` in
  `--twake-instance-skip-attribute`, a technical account for instance, gets
  none, and neither does a tombstone
  (`--twake-lifecycle-deleted-attribute`) put back in place.
- The address (`--twake-instance-fqdn-attribute`) and the mark
  (`--twake-instance-sent-attribute`) are this plugin's to write: an add that
  carries them has them removed, and an address written by a modify is taken
  only when it is the one the provider gives the account, or once the
  provider confirms it.
- A refused, unreachable or slow provider leaves the entry written and
  without an address: it is pending, and the error is logged. The add itself
  succeeds, whatever the door (REST, SCIM, bulk import).
  `--twake-instance-timeout` bounds each call, so a lookup, a creation and,
  with cozy-stack, the onboarding can hold an add up to three times as long.
- Once the instance exists, its address is written, `user.created` is
  published on the auth exchange, without a password hash, and the entry is
  marked with the date. The event is sent at least once: a failure between
  the publication and the mark sends it again on the next attempt, and two
  replicas handling the same account at once may both send it. Within one
  replica, the work on one account is done one step at a time.
- The server does not start without a reachable broker, and an event that
  cannot be published fails its attempt rather than being marked as sent.
- With cozy-stack, deleting an account destroys its instance, when that
  instance's OIDC id is this account's.

## Making sure an account has its instance

`POST /api/v1/twake/instances/ensure` with `{ "dn": … }` or `{ "mail": … }`
(or `ensureInstance(dn)` from another plugin) writes a missing address and
announces the account when its instance exists, and asks for the instance
when it does not. It answers `ready` or `pending`, and `400` when the body
names no account.

The route reads and writes the account with the caller's rights: an account
the caller cannot read answers `404`, as a missing one does, and one it
cannot write is refused before the provider or the broker hear of it.

Pending accounts are the entries under the `--twake-instance-dn` branches
with a mail and no address, for instance
`(&(mail=*)(!(twakeWorkspaceUrl=*)))`, technical accounts aside.

## Organizations

`ensureOrganization({ id, name, domain })` asks for an organization's own
instance, for the application that creates organizations to call once it
has written the organization entry. With the Cloudery it creates the
Cloudery organization first. The organization entry, found under
`--twake-instance-organization-base` by
`--twake-instance-organization-id-attribute`, gets the address when
`--twake-instance-organization-fqdn-attribute` names where. With the
Cloudery the organization is then linked to its instance (`PATCH
/api/v2/organizations/<id>` with `instance_fqdn`), which the Cloudery needs
before it takes its members' `user.created`. Then `organization.created` is
published on the b2b exchange, and the entry is marked. The message carries
the organization's id, address, domain, and its name as `organization`, read
from `--twake-instance-organization-name-attribute`, which
`ensureOrganization` fills from `name` when the entry has none. The mark, not
the address, says the organization is done.

`--twake-instance-organization-account` names an account of the
organization by a DN template, `{id}` standing for the organization id, for
example `uid={id},ou=users,ou={id},ou=organizations,dc=example,dc=com`. It
is usually a technical account, kept from an instance of its own by
`--twake-instance-skip-attribute`. When the organization is announced, and on
any replay, the account gets the organization's address in
`--twake-instance-fqdn-attribute`, when it exists and has none. An account
added once the organization is marked gets it at creation, read from the
organization entry or else from the provider.

With the Cloudery, a member's `user.created` waits for its organization's: a
member under an organization entry that is not marked yet gets its address
but no event and no mark. A member outside its organization entry is not
held, since nothing would find it to release it: it is announced with a
warning, and needs sending again once the organization is linked. A stored
address the provider does not confirm keeps a member held, with a warning,
until `ensureInstance` sends it. Once the organization is
marked, every member under its entry with an address and no mark gets its
`user.created`, each on its own: one that fails is logged, the others are
still sent, and the message is redelivered. A stored address is sent only
if it is the one the provider gives the account, or once the provider
confirms it. Nothing of this is kept in memory: the organization's
`workplace.created` again, or `ensureOrganization` on a marked organization,
links the organization again and sends whatever is still held, from any
replica. That also links an organization marked before the link existed.

The Cloudery builds no member instance for an organization it does not
have. Before asking for a member's instance, the plugin asks for its
organization and the organization's instance when the Cloudery has neither,
so making sure of a member also repairs an organization whose creation
failed.

## Providers

- `cloudery`: the Cloudery accepts the request and builds the instance
  afterwards. An instance already at the account's address is taken when it
  is this account's, so a re-created account keeps its instance. The address
  arrives with `workplace.created`, consumed on `--twake-instance-queue`,
  with a dead-letter queue. The message goes to an organization when its
  `twakeId` is an organization id and its `internalEmail` that
  organization's own (`<id>@<domain>`); otherwise to the account with that
  `internalEmail`.
- `cozy-stack`: the admin API builds the instance before answering, and the
  address is written in the request. The instance's onboarding is marked as
  finished, so its first login does not open the setup wizard. An instance
  already there is taken only when its email and OIDC id are this account's.

The instance id is `--twake-instance-id`, a template of the account's `uid`
and the named groups of the matching DN expression, for example
`{uid}{org}`; dots are dropped. A name no expression captures stops the
server at startup. It is the slug of the instance's address; the OIDC id is
this slug with the Cloudery, and the `uid` with cozy-stack. `user.created`
names the account by its `uid` (`twakeId`). A group named `org` is the organization id sent to the provider
and in `user.created`, with the mail's domain as its domain; with cozy-stack
and no such group, `--twake-instance-cozy-org-id` and
`--twake-instance-cozy-org-domain` stand for them.

## Configuration

```bash
--plugin core/twake/instances \
--twake-instance-dn '^uid=(?<uid>[^,]+),ou=users,ou=(?<org>[^,]+),ou=organizations,dc=example,dc=com$' \
--twake-instance-id '{uid}{org}' \
--twake-instance-skip-attribute employeeType \
--twake-instance-skip-value technical \
--twake-instance-provider cloudery \
--twake-instance-cloudery-url https://manager.example.com \
--twake-instance-cloudery-token … \
--twake-instance-cloudery-domain example.com \
--twake-instance-cloudery-organization-offer organization \
--twake-instance-organization-base ou=organizations,dc=example,dc=com
```

A DN holds commas, so in `DM_TWAKE_INSTANCE_DN` end each expression with `;`.
Every option and its default is listed in the
[configuration reference](../../configuration.md). The plugin needs
`--rabbitmq-url`.

The directory schema must define the address and mark attributes, and with
`--twake-instance-organization-base` the organization domain (and address)
attributes: the defaults `twakeWorkspaceUrl`, `twakeCreatedEventAt` and
`twakeDomain` come from the Twake schema, which this repository does not
ship. The server refuses to start when one is missing.
