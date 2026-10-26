# Upgrading

What to check before deploying, newest first. Only releases that need a
decision or a configuration change appear here; see the
[CHANGELOG](../../CHANGELOG.md) for everything else.

## Unreleased

### The process stops on an uncaught exception

**Who is affected:** every deployment; a supervisor, Kubernetes or systemd,
restarts the process, as it should.

An exception nothing caught was logged and the process kept serving in a
state nobody knew. It now shuts down and exits with 1. On `SIGTERM` the
server also drains what is in flight within `--shutdown-timeout` (20 s)
before closing its connections, where it closed the listening socket and
left the rest to the signal. See [shutdown](operations.md#shutdown).

### The readiness of a pod follows the directory

**Who is affected:** a deployment of the Helm chart, whose probes now call
`GET /healthz` and `GET /readyz` instead of opening the listen port.

A pod leaves the endpoints while the directory does not answer, where it
kept receiving requests and answering 500; a rollout started during a
directory outage waits for the directory. Both routes are served without
authentication: an Ingress routing `/` exposes them, keep the two paths to
the cluster. See [operations](operations.md#health-and-readiness).

### `--ldap-dn` and `--ldap-pwd` are required

**Who is affected:** a deployment that left one of them unset, and so bound
as `cn=admin,dc=example,dc=com` or with the password `admin`; the published
Docker image carried both in its `ENV`, and the Helm chart's example only set
the password.

The server now stops at startup naming the missing option. Set `DM_LDAP_DN`
and `DM_LDAP_PWD` (or `--ldap-dn` and `--ldap-pwd`) to the values that were
implied.

### Every entity route checks the shape of a value

**Who is affected:** a script or connector writing through `/api/v1/ldap/<entity>`,
`/api/v1/ldap/groups` or `/api/v1/ldap/organizations` text that is not a
number for a `number` or `integer`, a `delete` of a `required` attribute as
a whole, or a change naming an attribute a strict schema does not declare;
one writing through `/api/v1/ldap/<entity>` several values for an attribute
the schema does not type `array`; and one changing a `fixed` attribute of a
group, which the server dropped from the change and answered 200. The
server now answers 400, naming the attribute. A group creation sending a
value under a `fixed` attribute now writes the schema's default, or the
value when the schema gives none, where it wrote nothing. The shipped LSC connector sends shapes that stay
accepted, a list of one in a `replace` and one value for an `array` on a
creation; its whole-attribute delete is refused for a `required` attribute,
as any, and a group synchronisation that forces `objectClass` or another
`fixed` attribute now has the whole update refused: keep those attributes
out of the group updates.

Send one value for a single-valued attribute, a list for an `array` (one
value, or a list of one, is taken either way), numbers as numbers or digits,
and `null` or `[]` in a `replace` to clear an attribute. The rules are in
[what a value must look like](../client-development/schemas/README.md#what-a-value-must-look-like).

### `--logger`: `console` or `file`

A `DM_LOGGER` set to anything else wrote `error.log` in the working
directory; the server now stops at startup. Set `DM_LOGGER=file` to keep
that file, and `DM_LOG_FILE` to name another one. An empty `DM_LOGGER` is
`console`.

## From 1.0 to 1.1.0

### The static files can no longer be framed by another origin

`core/static` sends `Content-Security-Policy: frame-ancestors 'self'` and
`X-Frame-Options: SAMEORIGIN`. A page of another origin, another sub-domain
or port of the same site included, that showed one of its applications in an
`<iframe>`, a portal for instance, now shows an empty frame. Name it:

```bash
--static-csp "frame-ancestors 'self' https://portal.example.com"
--static-frame-options off
```

See [security headers](plugins/utilities/static.md#security-headers).

### `--static-name`: an empty value is `static`

With `DM_STATIC_NAME=` the files were served at the root while the
configuration API and SCIM announced `/static`; they are now served under
`/static`. Slashes around the name are left out (`/static/` is `static`). A
name Express would not match as written, with an empty, `.` or `..` segment,
or what a URL encodes or Express reads as route syntax in it (a space, a
letter outside ASCII, `:`, `*`, `?`, `#`, `%`, brackets, quotes…), stops
the server at startup.

## From 0.26 to 1.0.0

Every breaking change since 0.26.0. Authorization fails closed in 1.0.0:
what used to pass because a call site forgot the request, or because a
name was spelled otherwise, is now judged, and may be refused.

### Attribute names in a write: one name per attribute, no option

**Who is affected:** a client, a CSV of the bulk import or a plugin writing
an attribute with an option other than `;binary` (`title;lang-fr`,
`member;x-tag`), or naming one attribute twice in one part of a write
(`mail` and `MAIL`, `mail` and `rfc822Mailbox`).

Every add and modify now names its attributes as this server does before
it is judged: the name is resolved through the directory schema, so `MAIL`,
`rfc822Mailbox` and `0.9.2342.19200300.100.1.3` are all written `mail`.
The spelling kept is the configuration's or a loaded schema's, else the
first name the directory declares. An option other than `;binary` is
refused with a 400: a tagged value is one of its own, which the rules
guarding the attribute would not see. Two names for one attribute in one
`add`, `replace` or `delete` are refused with a 400 too. Values already
stored under an option are still read, but cannot be written or deleted
through ldap-rest: clean them up in the directory.

A rename gives the entry one value of the attribute it is already named by
(`cn=new` for a group named by `cn`): a new RDN holding several values, or
naming another attribute, is refused with a 400. The directory writes the
values of the new RDN on the entry, where no check of a write saw them.

When the directory schema cannot be read, the names, aliases and OIDs of
the standard types (`cn`, `mail`, `uid`, `ou`…) are still resolved, as are
the spellings of the configuration and the schemas. A name given as another
OID is refused, and another alias is written as given.

### SCIM group members are looked up as the caller

**Who is affected:** a SCIM client writing group members by DN, and one
that tells an absent user from a hidden one by the message of
`PUT /Users/{id}`.

A member given by DN in `POST`, `PUT` or `PATCH /Groups` was taken as it
stood. It is now looked up as the caller, as a member given by id is: a DN
the caller cannot read, or that names no entry, is left out of the group,
and under a model judging by branch a member in a refused branch makes the
whole write refused. A DN outside the user base is left out, compared RDN by
RDN. A client that wrote members it may not read asks an administrator
whose rules cover them.

`PUT /Users/{id}` on a user that is not there answered `Resource not found`;
it now answers `User {id} not found`, as it did for a user the caller may
not read. The status, `404`, is unchanged.

### The group routes take a DN for a group only

**Who is affected:** a client calling `/api/v1/ldap/groups/{cn}` with a
DN rather than a name.

A DN given to these routes, to read, write, delete, create or rename a
group, must name a group below the groups branch (`--ldap-group-base`),
named by the groups' main attribute (`--ldap-groups-main-attribute`, `cn`
by default) and of a group class (`--group-class`, or a standard one) the
caller reads; anything else answers `404 Group not found`, and a DN the
directory would refuse `400`. A client that managed the organization
groups of `core/twake/groups` by DN through these routes, when they lie
outside `--ldap-group-base`, uses `/api/v1/organizations/{id}/groups`.
A deployment whose groups carry a class of their own, and none of the
standard ones, declares it in `--group-class`.

### Reference data still in use is not deleted

**Who is affected:** a deployment loading the shipped `twake` or `example`
schemas with `core/ldap/enterpriseRules`.

Deleting a mail domain an organization links, or a nomenclature value an
entry holds (account status, delivery mode, personal title, list type,
mailbox type), answers `409 still referenced` instead of leaving the
reference naming nothing. Change the referrers first. A deployment with
its own schemas marks its pointers `"referentialIntegrity": "restrict"` to
get the same. References are looked for under the base each entity is
configured with; a base the directory does not hold is logged once and
holds none.

### Plugins: an operation naming no request is judged as the caller

**Who is affected:** a third-party plugin calling `this.server.ldap.search`,
`add`, `modify`, `rename` or `delete` without a request, from a route, while
an authorization plugin is loaded. `move` is the server's and stays unjudged:
move an entry for a caller with `rename`.

Such an operation used to pass unjudged, as the server's. While an
authenticated request is being served, it is now judged as that request's
caller, and refused where the caller may not. Hand the request down
(`ldap.forRequest(req)`), or, for the server's own work, go through
`ldap.system`. Hooks run outside the request and keep acting as the server.

Under `core/auth/authzDynamic`, a hook's operations that named no request
used to be judged against the token, through an async context of the
plugin's own; they now act as the server, as under the other authorization
plugins. A hook writing on the caller's behalf passes the request it is
handed. That context, `authzContext`, is no longer exported: read the token
off the request (`req.authzToken`).

### An authorization plugin needs an authentication plugin

**Who is affected:** a deployment loading `core/auth/authzPerBranch`,
`core/auth/authzLinid1` or `core/auth/authzPerRoute` without any
authentication plugin.

Such a server no longer starts. No request carried an identity, so each of
these plugins stepped aside and every request passed, whatever the rules
said. Load the authentication plugin the rules were written for, or remove
the authorization plugins to serve the directory openly, as it already was.

### Nested branch rules of `authzPerBranch`

**Who is affected:** a deployment of `core/auth/authzPerBranch` whose rules
for one user, or one group, name a branch and a sub-branch of it.

The rule of the sub-branch now applies to everything below it, whatever
order the two are written in. It used to apply only where it matched
exactly — the sub-branch entry, and writes on its direct children, judged
on their parent — and below that the first rule written won. A sub-branch rule that
was ignored, a restriction or a grant, now takes effect in single reads and
writes and in searches: a search on the parent no longer lists what the
sub-branch rule refuses, so a listing may now be shorter. Check such rules:
they now mean what they say.

`default` no longer adds to what the rules grant: it applies to a
permission none of the rules that apply sets. A rule's `read`, `write` or
`delete` set to `false` now refuses, where `"default": {"read": true}` used
to grant it anyway. A permission a rule leaves unset is still the
default's, not the broader rule's.

Renaming or moving an entry a rule names, or one holding such an entry, now
needs read and write permission at each of those rules, and deleting it
needs delete there; changing the entry itself needs that rule's write
permission, as does creating it. A write setting the organization link and
changing anything besides the link and its path needs write where the
entry stands — its branch, or under `--authz-filter-attached-entries` the
organization it leaves: it used to need only read there, so the rest of
the write — a password, say — went through. Moving an entry between
organizations is unchanged.

### Organization groups need read access to the organization

**Who is affected:** a deployment loading an authorization plugin together
with `core/twake/groups` (and `core/twake/spaces`, which goes through it).

The `/organizations/{id}/groups` and `/organizations/{id}/spaces` routes read
as the caller. A client calling them must be granted read access to the
organization, its groups and its users, write access to change them and
delete access to delete one. An organization it cannot read answers `404`,
and a user it cannot read `404 USER_NOT_FOUND` where it used to get `403`.

Under `core/auth/authzLinid1` or `--authz-filter-attached-entries`, groups
written in an organization's branch now carry its link
(`--ldap-organization-link-attribute`): creating or changing a group needs
write on the organization, and a group without a link is read and changed by
every administrator. Link the groups written before; this script is an
example to adapt to your patterns, attribute names and organization names
(it expects plain ones, without spaces or commas):

```sh
# Connection to the directory, as for any ldapsearch
OPTS="-H ldap://localhost -D cn=admin,dc=example,dc=com -w secret"
# --twake-group-organization-dn and --twake-group-base, {org} left out
ORGS="dc=example,dc=com"
for org in $(ldapsearch $OPTS -LLL -s one -b "$ORGS" '(ou=*)' ou |
  sed -n 's/^ou: //p'); do
  ldapsearch $OPTS -LLL -o ldif-wrap=no -s one \
    -b "ou=groups,ou=$org,$ORGS" '(!(twakeDepartmentLink=*))' objectClass |
    awk -v link="ou=$org,$ORGS" '
      function flush() {
        if (!dn) return
        print "dn: " dn "\nchangetype: modify"
        # The class is added only to a group lacking one allowing the link
        if (!held) print "add: objectClass\nobjectClass: twakeGroup\n-"
        print "add: twakeDepartmentLink\ntwakeDepartmentLink: " link "\n"
        dn = ""
      }
      /^dn: / { flush(); dn = substr($0, 5); held = 0 }
      tolower($0) ~ /^objectclass: (twakegroup|twakestaticgroup)$/ { held = 1 }
      END { flush() }'
done | ldapmodify $OPTS
```

### The organization link holds one organization

**Who is affected:** a client or a CSV writing several organization links on
one entry, or an empty one.

A write giving the organization link (`--ldap-organization-link-attribute`)
several values, or an empty value, is refused with a 400: only one of them
was judged. Under any spelling of the attribute, adding a link to an entry
that had none is judged as a move: write where it goes and, judged by
branch, read where it stands.

### Smaller changes in answers

- `GET /api/v1/ldap/raw/search` below a base the caller may not read
  answers 404, as for a base that is not there; under `authzPerBranch`
  judging by DN it answered 403.
- Changing only the case of an account's mail is refused (409) while an
  applicative copy holds the old spelling, which the directory takes for
  the same address.

### External members in a domain the directory declares

**Who is affected:** a deployment of `core/ldap/externalUsersInGroups`
adding as external members addresses in a mail domain the directory
declares, without listing it in `--mail-domain`.

Such a member is refused, as one in a `--mail-domain` already was. The
managed domains are now also those of the directory's domain branches,
[docs](plugins/ldap/external-users.md#important-notes); `GET /config` lists
them in `managedDomains`.

### Quota and app accounts need read access to the account

**Who is affected:** a deployment loading an authorization plugin
(`core/auth/authzPerBranch`, `authzLinid1`, `authzDynamic`) together with
`core/twake/james` or `core/twake/appAccountsApi`.

`GET /users/{user}/quota-usage` and the app account routes answer `404` for
an account the caller cannot read. A client calling them must be granted
read access to the accounts it asks about, as it already needed write
access to create or delete an app account.

## To 0.24.0

### Links to deleted accounts

**Who is affected:** a deployment using the Twake schemas, or any schema
whose links to accounts now carry `referentialIntegrity: "remove"`
([details](plugins/ldap/enterprise-rules.md#deletion-and-references)).

Accounts deleted from now on leave the links naming them. Those deleted
before still appear as managers, local administrators, delegates or owners,
and an account created again at the same address gets their rights. List
the dangling ones and remove them:

```sh
# Connection to the directory, as for any ldapsearch
OPTS="-H ldap://localhost -D cn=admin,dc=example,dc=com -w secret"
BASE="dc=example,dc=com"
for attr in twakeLocalAdminLink twakeManagerLink twakeDelegatedUsers \
  owner manager; do
  ldapsearch $OPTS -LLL -o ldif-wrap=no -b "$BASE" "($attr=*)" "$attr" |
    sed -n -e 's/^dn: //p' -e "s/^$attr: />/p" |
    while IFS= read -r line; do
      case "$line" in
        ">"*) target="${line#>}"
          ldapsearch $OPTS -LLL -s base -b "$target" dn >/dev/null 2>&1 ||
            echo "$dn: $attr $target" ;;
        *) dn="$line" ;;
      esac
    done
done
```

Then, for each line, delete that value
(`ldapmodify`, `delete: <attribute>` with the DN shown). `owner` and
`manager` may also be listed for entries no schema marks `remove`, an
account's `manager` say: check before deleting those.

## To 0.22.0

### James follows the mail domains

**Who is affected:** a deployment that loads `twake/james` and holds mail
domain entries (`twake/nomenclature/twakeDomain.json`, or any schema giving
an attribute the `domainName` role).

From now on, adding a domain entry creates the domain in James, and deleting
one removes it there. A domain an organization still links, or that an
address still uses, can no longer be deleted (`409`): unlink it and move the
addresses first. The domains the directory already holds are not created in
James at startup: check that James knows each of them
(`GET /domains` on the WebAdmin) before relying on the directory.

If `core/ldap/trash` watches the domain branch, as it does when
`--trash-watched-bases` is empty, a warning in the log says so: keep the
domains out of the trash,
[details](plugins/integrations/james-mail.md#trash).

To let the administrators of the whole directory add and delete domains
while every administrator keeps reading them, name the domain branch in
`--authz-global-write-branches`
([global branches](plugins/auth/authz-linid1.md#global-branches)).

## To 0.21.0

### Accounts another tool created

**Who is affected:** a deployment that loads `twake/instances` with the
Cloudery, where another tool creates accounts under `--twake-instance-dn`
without the classes of `--user-class` (a plain `inetOrgPerson`, say).

Those accounts have an instance but neither its address nor the mark: the
directory refused the write. Once deployed,
[make sure of each pending account](plugins/integrations/instances.md#making-sure-an-account-has-its-instance): the call gives it the class it needs.

### Several password policies

**Who is affected:** a deployment that loads `core/ldap/passwordPolicy`
without `--ppolicy-default-dn`, whose directory holds several `pwdPolicy`
entries.

`GET /password-policy` answers `{}` and accounts without
`pwdPolicySubentry` are reported without expiry, until
`--ppolicy-default-dn` names the policy slapd's `olcPPolicyDefault` names. A
warning in the log says so.

## To 0.20.3

### Members whose uid the Cloudery refused as a slug

**Who is affected:** a deployment that loads `twake/instances` with the
Cloudery, whose members were created through SCIM or the API with a `uid`
holding characters such as `_` or `@`.

Those members got no instance: the Cloudery refused their slug. Once
deployed,
[make sure of each pending account](plugins/integrations/instances.md#making-sure-an-account-has-its-instance).
Two members whose `uid`s reduce to the same slug cannot both have an
instance: the second call answers `409`,
[details](plugins/integrations/instances.md#providers).

## To 0.20.2

### Members of organizations created before 0.13.0

**Who is affected:** a deployment that loads `twake/instances` with the
Cloudery and has organizations created before 0.13.0 that got members since.

Those members have neither an address nor the mark, and adding another
member does not release them. Once deployed,
[make sure of each pending account](plugins/integrations/instances.md#making-sure-an-account-has-its-instance),
as a caller who may write the organization entry. The first call announces
the organization, and each member's `user.created` follows once its instance
is built, [details](plugins/integrations/instances.md#organizations).

## To 0.20.0

### Team mailboxes keep their members to their domain

**Who is affected:** a deployment that loads `twake/james` and has team
mailboxes whose members, or some of them, have their address at another
domain than the mailbox's.

A write that adds such a member, or moves a team mailbox to a domain its
members are not at, is now refused with a `409`. The team mailboxes already
holding one stay as they are until their members or their address change,
[details](plugins/integrations/james-mailboxes.md#members-belong-to-the-mailboxs-domain).

To keep cross-domain team mailboxes, set `--james-team-mailbox-any-domain`
(`DM_JAMES_TEAM_MAILBOX_ANY_DOMAIN=true`).

## To 0.19.0

### Forwards are no longer copied to Twake Mail

**Who is affected:** a deployment that loads `twake/james` and stores
forwards in `--forward-attribute` (`mailForwardingAddress` by default).

`twake/james` no longer applies the changes of that attribute to Twake Mail's
forwards: users set them in Twake Mail. The forwards already in Twake Mail
stay as they are, except those left on an address an account takes, removed
as before,
[details](plugins/integrations/james-mail.md#forwards-left-on-an-address).

To keep the directory as the owner of the forwards, set
`--james-sync-forwards` (`DM_JAMES_SYNC_FORWARDS=true`); it then overwrites
what users set in Twake Mail,
[details](plugins/integrations/james-mail.md#forwards).

## To 0.18.0

### Mailing lists are no longer copied to James

**Who is affected:** a deployment that loads `twake/james`.

`twake/james` no longer creates, fills or deletes James address groups
(`/address/groups`) for mailing lists, the groups with a `mail` whose
`twakeMailboxType` is `mailingList` or is not set. Twake Mail must read them
from LDAP with its `LDAPMailingList` mailet: without it, a mail sent to a
list address is no longer delivered to its members.

The address groups already created for these lists stay in James. Delete
them: `GET /address/groups` lists the address groups,
`DELETE /address/groups/{group}` deletes one.

`--james-mailing-list-branches` now only keeps team mailboxes out of these
branches.

### The Twake schemas translate their hints and form sections

**Who is affected:** a deployment serving the shipped Twake schemas
(`twake/*.json`, or a schema extending one) to a client that reads `hint` or
`group` as a plain string.

These are now maps keyed by language tag, as `label` already was:
`{ "en": "Mailbox Settings", "fr": "Paramètres de messagerie" }`. Such a client
shows them as `[object Object]`, or not at all: upgrade it along with the
server.

## To 0.17.0

### The quota attribute defaults to `mailQuotaSize`

**Who is affected:** a deployment that loads `twake/james` or
`core/ldap/onChange`, or runs `bin/sync-james.mjs`, without setting
`--quota-attribute` (`DM_QUOTA_ATTRIBUTE`).

The default is now `mailQuotaSize`, the attribute the Twake schemas define,
instead of `mailQuota`. A directory that holds the quota in `mailQuota` must
set `DM_QUOTA_ATTRIBUTE=mailQuota` (or `--quota-attribute mailQuota`):
without it, quota changes are no longer sent to the mail server. A deployment
that already sets the option is unchanged.

## To 0.16.0

### Space events need the organization domain attribute

**Who is affected:** a deployment of `core/twake/spaces` with `--rabbitmq-url`
and `--twake-group-organization-dn`.

The space events now carry the organization's domain, read from
`--twake-instance-organization-domain-attribute` (default `twakeDomain`). The
server does not start when the directory schema does not define that
attribute: load a schema that does, or point the option at one it defines.

## To 0.15.0

### A DN option read from the environment splits on `;` only

**Who is affected:** a deployment that sets `DM_LDAP_RAW_BASE`,
`DM_JAMES_MAILING_LIST_BRANCHES`, `DM_TWAKE_TOMBSTONE_DN`,
`DM_TWAKE_TOMBSTONE_GROUP_BASES` or `DM_TWAKE_INSTANCE_DN`, or gives
`--ldap-raw-bases` or `--james-mailing-list-branches`.

Their values are no longer cut on spaces or commas: a DN such as
`DM_LDAP_RAW_BASE="ou=My Unit,dc=example,dc=com"` stays whole. Separate
several DNs with `;`, as already documented.

### HMAC and TOTP entries are no longer split on spaces

**Who is affected:** a deployment that sets `DM_AUTH_HMAC` or `DM_AUTH_TOTP`,
or gives `--auth-hmacs` or `--auth-totps`.

Separate entries with `,`, `;` or newlines. A name may now hold spaces, as in
`id:secret:Registration Service`. A list separated by spaces is read as one
entry: an HMAC list gives one service, the others cannot authenticate (their
requests get 401, and a warning is logged), and a TOTP list stops the server.

`core/auth/hmac` and `core/auth/totp` also stop the server on an entry that
cannot work, instead of skipping it with a warning: an HMAC entry with an
empty id, secret or name or fewer than 3 fields, a TOTP entry with an empty
secret or name, more than 3 fields, a secret that is not Base32 or digits that
are not an integer from 6 to 10. A TOTP entry such as `secret:name:abc` used
to register a user whose code was the string `NaN`.

### The plural command-line form of an array option splits on `;` first

**Who is affected:** a deployment that gives a plural form such as
`--auth-tokens`, `--ldap-urls` or `--plugins`.

A value containing `;` is now split on `;` and not on `,`, as the environment
variable does: `--auth-tokens 'a;b;c'` was one token and is now three, and
`--auth-tokens 'a;b,c'` was `a;b` and `c` and is now `a` and `b,c`. A value
without `;` is split as before.

`--authz-dynamic-bypass` and `--twake-space-class` now split on commas in their
singular form, as the other options holding identifiers do.

### An empty environment variable or a number that is not one

**Who is affected:** a deployment that sets an array option, a number or a JSON
option to an empty value, or a number option to something else than an integer.

- An array variable that is empty, only holds whitespace or only holds
  separators (`DM_GROUP_CLASSES=`, `DM_GROUP_CLASSES=,`) keeps the default
  instead of giving an empty list, which was a silent misconfiguration (a
  server without object class, for instance). `DM_LDAP_OPERATIONAL_ATTRIBUTES=`
  used to give `[]` and now gives the default; an option with a non-empty
  default cannot be given an empty list from the environment.
- `DM_LDAP_URL=` is the exception: its default, `ldap://localhost`, is a guess,
  not a fallback, so an empty value still stops the server. Set the variable
  or leave it out.
- An empty number or JSON value (`DM_PORT=`) keeps its default instead of
  giving `NaN` or stopping the server.
- A number option takes an integer only: `DM_PORT=abc`, `DM_PORT=1e3`,
  `DM_PORT=8080abc`, `--port ''` or `--port --log-level debug` stop the server
  instead of giving `NaN` or a truncated value.

Booleans and strings are unchanged.

### An array option on the command line replaces its default

**Who is affected:** a deployment that gives, on the command line, an array
option that has a default: `--user-class`, `--group-class`,
`--ldap-organization-class`, `--external-branch-class`,
`--scim-user-object-class`, `--scim-group-object-class`,
`--applicative-account-attribute`, `--ldap-operational-attribute` or
`--ldap-url`, in their singular or plural form.

Their values used to be added to the default, and now replace it. Repeat the
default values you want to keep:

```bash
# Until now: top, twakeAccount, twakeWhitePages, twakeExtra
ldap-rest --user-class twakeExtra

# Now
ldap-rest --user-class top,twakeAccount,twakeWhitePages,twakeExtra
```

Without its default classes, an entry is created without its structural
class. Without the default operational attributes, `appAccountsConsistency`
recreates an applicative account with `userPassword` and the attributes the
directory generates. The defaults are listed in
[the configuration reference](configuration.md).

`--ldap-url ldap://ldap.example.com` no longer keeps `ldap://localhost` next
to it.

An environment variable already replaced the default, and values given on the
command line are still added to it.

## To 0.14.0

### `--twake-instance-organization-account` is removed

**Who is affected:** a deployment that sets
`--twake-instance-organization-account` or
`DM_TWAKE_INSTANCE_ORGANIZATION_ACCOUNT`.

The option is ignored, and no account gets the organization's address any
more. An account that already got it keeps it. To copy the address to
accounts yourself, set `--twake-instance-organization-fqdn-attribute`. The
organization entry then keeps the address, but only for organizations
announced from then on. An organization already announced does not get it:
take its address from its account or from the Cloudery.

### HMAC refuses a body it does not sign

**Who is affected:** a client of `core/auth/hmac` that sends a body with a
GET, DELETE or HEAD, or a signed body under a `charset` other than UTF-8.

These methods are signed without a body, so one they carried reached the
route unsigned; and the signature covers the bytes, not the charset that says
how to read them. Both are now answered `401`: send GET, DELETE and HEAD
without a body (and without `Transfer-Encoding`, which announces one), and
bodies in UTF-8
([#257](https://github.com/linagora/ldap-rest/issues/257)).

## To 0.13.3

### HMAC hashes the body bytes received

**Who is affected:** a client of `core/auth/hmac` that signs a body other than
the bytes it sends.

The server used to hash the body re-serialized with `JSON.stringify` after
parsing, and now hashes the bytes received, as documented. A client that
sends its body as `JSON.stringify` writes it and hashes that string, as the
bundled browser client does, sees no change. One that hashed a
`JSON.stringify` rendering but sent other bytes (indented JSON, spaces after
`:`, a form body hashed as the JSON of its fields) is now refused with `401`:
hash the bytes sent instead, before compressing them if the request carries
a `Content-Encoding`.

A request without a body is signed with an empty `body-hash`, as documented.
0.13.2 hashed the `{}` the parser left for a request that carries
`Content-Type: application/json` without a body, and required
`sha256("{}")`. A client that signs this way is now refused with `401`. The
bundled browser client sends no `Content-Type` without a body and is not
affected.

## To 0.13.2

### HMAC refuses a body it cannot check

**Who is affected:** a client of `core/auth/hmac` that sends a POST, PATCH or
PUT body other than `application/json`, `application/x-www-form-urlencoded`
or `application/scim+json` — in particular a bulk import upload
(`multipart/form-data`).

Such a body is read by its route after the signature is checked, so the
signature never covered it. The request is now answered `401`, and the
bundled browser client throws on a `FormData` body instead of signing it
without its body. The bulk import API, whose upload its route reads, cannot
be used under HMAC: use another authentication for it.

## To 0.13.0

### An OpenID Connect session ends with its access token

**Who is affected:** a deployment loading `core/auth/openidconnect`.

A session used to last as long as its cookie, a day of inactivity and a week
at most. It now ends when its access token expires, unless the provider gave
a refresh token to renew it: a browser then goes back through the provider,
silently while the provider's own session lasts, and a client asking for
JSON only (`Accept: application/json`) is answered `401`.

To keep sessions going without that round trip, have the provider issue
refresh tokens to the client
([details](plugins/auth/oidc.md#session-lifetime)).

### SCIM `active` reads the lock value

**Who is affected:** a SCIM client of a directory with ppolicy lockouts. An
account locked out after failed binds now reads `active: true`, is left out
of `active eq false`, and keeps its lockout on `"active": true`; only the
configured lock value reads as inactive. See
[the SCIM plugin documentation](plugins/integrations/scim.md#deactivating-an-account-active).

### twake/instances links an organization before its members

**Who is affected:** a deployment running 0.12.0 with
`--twake-instance-provider cloudery` and `--twake-instance-organization-base`.

0.12.0 sent each member's `user.created` at once and marked the member, while
the Cloudery refused it because the organization was not linked to its
instance. The plugin now links the organization and holds its members until
then, but only releases members that are not marked, so those already marked
are not sent again on their own.

To repair an organization, clear `--twake-instance-sent-attribute` on its
marked members, then replay its `workplace.created` or call
`ensureOrganization` for it ([details](plugins/integrations/instances.md#organizations)).

### Trash watched bases are separated by `;`

**Who is affected:** a deployment loading `core/ldap/trash` with
`--trash-watched-bases` set.

The list was split on commas, so a DN such as `ou=users,dc=example,dc=com`
became the suffixes `ou=users`, `dc=example` and `dc=com`, and the trash
caught deletes in every branch under `dc=com`. Each base is now a whole DN,
and bases are separated by `;`:
`ou=users,dc=example,dc=com;ou=groups,dc=example,dc=com`. A single DN needs
no change. A list of full DNs joined by commas, such as
`ou=users,dc=example,dc=com,ou=groups,dc=example,dc=com`, or a list of RDNs,
such as `ou=users,ou=groups`, now reads as one DN that no entry sits under,
so the trash catches nothing and deletes there are permanent: rewrite it with
`;`, each branch as its full DN. The server logs a warning at startup for a
watched base that is not one DN under `--ldap-base`.

## To 0.12.0

### twake/instances replaces cozyProvision and clouderyProvision

**Who is affected:** a deployment loading `core/twake/cozyProvision` or
`core/twake/clouderyProvision`.

Replace the plugin with `core/twake/instances`
([doc](plugins/integrations/instances.md)); the server refuses to start with
both. Its options are its own. From cozyProvision, with
`--twake-instance-provider cozy-stack` and `--twake-instance-dn` set to the
accounts' branch:

- `--cozy-admin-url` → `--twake-instance-cozy-url`
- `--cozy-admin-user` → `--twake-instance-cozy-user`
- `--cozy-admin-passphrase` → `--twake-instance-cozy-passphrase`
- `--cozy-org-domain` → `--twake-instance-cozy-domain` (the instances'
  domain) and `--twake-instance-cozy-org-domain`
- `--cozy-org-id` → `--twake-instance-cozy-org-id`
- `--cozy-context-name` → `--twake-instance-cozy-context`
- `--cozy-apps` → `--twake-instance-cozy-apps`
- `--cozy-default-locale` → `--twake-instance-locale`
- `--cozy-auth-exchange` → `--twake-instance-auth-exchange`
- `--cozy-b2b-exchange` → `--twake-instance-b2b-exchange`
- `--cozy-user-created-routing-key` → `--twake-instance-user-created-key`

From clouderyProvision, with `--twake-instance-provider cloudery`:

- `--cloudery-manager-url` → `--twake-instance-cloudery-url`
- `--cloudery-manager-token` → `--twake-instance-cloudery-token`
- `--cloudery-offer` → `--twake-instance-cloudery-offer`
- `--cloudery-domain` → `--twake-instance-cloudery-domain`
- `--cloudery-default-locale` → `--twake-instance-locale`
- `--cloudery-fqdn-attribute` → `--twake-instance-fqdn-attribute`
- `--cloudery-user-branch` → `--twake-instance-dn`, with an `org` group for
  the organization id; `--twake-instance-id '{uid}{org}'` keeps the slugs

What no longer happens:

- An account gets its instance on any add under `--twake-instance-dn`, not
  only a SCIM create.
- `domain.user.deleted` is not published, and `--cozy-user-deleted-routing-key`
  has no plugin to read it. With the Cloudery, deleting an account no longer
  deletes its instance; cozy-stack instances still are.
- clouderyProvision's writes on a SCIM create are gone:
  `twakeOrganizationId`, `twakeOrganizationRole`, `twakeInvited`,
  `twakePhones`, `cn` set to the userName, and the lower-casing of the SCIM
  `userName`. The `x-cloudery-org-*` headers are not read; the organization
  comes from the DN. `--cloudery-org-*`, `--cloudery-phones-attribute`,
  `--cloudery-invited-attribute` and the workflow polling options are gone:
  the address arrives with `workplace.created` instead.
- With cozy-stack, the instance address drops the uid's dots and lower-cases
  it, as the Cloudery's slugs do: an account whose uid holds a dot or a
  capital gets a different address than cozyProvision gave it. Its OIDC id
  is still the uid.

`user.created` keeps its fields, `twakeId` still being the account's uid.

## To 0.11.0

### Group reads are judged

**Who is affected:** a deployment loading `core/ldap/groups` with an
authorization plugin.

Listing the groups and reading one went to the directory without the
request, so no authorization plugin saw them: any authenticated caller read
every group with its members. They are judged like any other read now.
Under `core/auth/authzPerBranch` without `--authz-filter-attached-entries`,
that means a `read` grant on the group base (`ou=groups`, or
`--ldap-group-base`): **a caller without one is answered `403`** where the
list used to come back.

### authzLinid1 judges accounts and groups by their organization

**Who is affected:** every deployment using `core/auth/authzLinid1`.

It now works as with `--authz-filter-attached-entries`, whatever the option
says. Without it, a flat `ou=users` was nobody's branch: no administrator
could list or change an account.

- An administrator lists the accounts and groups attached to their branches,
  and those attached to none.
- **The organization tree is readable by every administrator**, not only their
  own branches: an organization is reference data. `organizations/top` still
  answers their own branches, so a console starts there. Writes to the tree
  are judged as before.
- **A caller named in no `twakeLocalAdminLink` is refused every read** but the
  top organization's own entry.
- An account stored under the organization tree without a
  `twakeDepartmentLink` becomes readable by every administrator. **Where
  accounts sit under the tree, give them their link before upgrading.** This
  lists the accounts that have none, under `twakeDepartmentLink: missing`:

  ```bash
  npm run audit:directory -- --schema static/schemas/twake/users.json \
    --base ou=users,<base> --filter '(!(twakeDepartmentLink=*))'
  ```

## To 0.10.0

### LDAP base is now required

**Who is affected:** a deployment that starts `ldap-rest` without
`--ldap-base` (or `DM_LDAP_BASE`).

The server refuses to start without it. It used to take the second RDN of
`--ldap-dn` — `dc=example` for `cn=admin,dc=example,dc=com` — so subtree
searches failed or found nothing. Set `--ldap-base` to the DN under which
the entries are searched.

### Group rules now apply

**Who is affected:** a deployment whose `--authz-per-branch-config` declares
a `groups` section.

That section granted nothing: permissions came from `users` and `default`
alone. A member of a configured group now also gets what its rule grants.
**Check the `groups` rules before upgrading.**

### An identity naming several entries is refused

**Who is affected:** a directory where the same `uid` appears twice — one
without a `unique` overlay, or one where a homonym was left in the trash
while the uid was reused.

`authzLinid1` refuses every request of such a caller with a `403`.
`authzPerBranch` keeps the uid's `users` rules and withholds the `groups`
rules. Both log a warning naming the identity and the number of entries it
matched.

**Check your directory before upgrading:**

```bash
ldapsearch -x -b "<base>" "(uid=<uid>)" dn
```

must answer one entry. Where it answers two, remove the duplicate — the
trash included — or restore the uniqueness the `unique` overlay enforces.

### `onLdapChange` gives full values

**Who is affected:** plugins listening to `onLdapChange` that read the values
of an `add`, or of a `delete` naming values, as the values added or removed.

Each attribute now maps to all its values before and after the write. Adding
`c` to `member: [a, b]` gave `[null, [c]]` and gives `[[a, b], [a, b, c]]`.
Compute what was added or removed as the difference of the two sides, as the
plugins shipped with LDAP-Rest do. A `replace` with the current value no
longer fires the hook.

## To 0.9.0

### Two authorization plugins judging the same requests no longer start

**Who is affected:** anyone loading two of `core/auth/authzPerBranch`,
`core/auth/authzLinid1` and `core/auth/authzDynamic` together — including
`authzPerBranch` beside `authzDynamic`, where the branch plugin judged the
tokens too.

Every plugin judging LDAP operations registers the same hooks, and all of
them run: the first refusal wins. Loaded together, they composed as an AND
nobody had decided, and the 403 did not say whose refusal it was. The server
now refuses to start, naming both plugins. Two ways out:

- **Scope each plugin to its own callers** with `authz_for`, the instance
  names of the authentication plugins whose requests it judges — so that no
  request is judged by both:

  ```bash
  --plugin core/auth/authzDynamic
  --plugin 'core/auth/openidconnect:oidc:{"auth_path_prefix":"/api/admin"}'
  --plugin 'core/auth/authzPerBranch:authzPerBranch:{"authz_for":["oidc"]}'
  ```

- **Keep the AND**, if it was meant, with `--authz-combine`. Behaviour is
  then what it was, and the startup log says the two compose.

`authzPerRoute` is not concerned: it registers no LDAP hook, and route plus
branch stays a combination that starts as before.

**Hosts assembling the server themselves** — `registerPlugin` after `ready`
rather than `--plugin` — get the same refusal, out of the `registerPlugin`
call that brings the second plugin. A plugin arriving is judged against what
is already there: register the authentication plugins an `authz_for` names,
and the plugins `--authz-scope-source` names, before the plugin naming them.

A lone `authzPerBranch` is not refused, but mind its default: unset,
`--authz-per-branch-config` grants read everywhere and write nowhere to
**every** authenticated identity, whatever authenticated it. The startup
line `authzPerBranch judges … for every authenticated request (…)` names the
authenticators it judges; one it was not written for needs an `authz_for`.

`GET /v1/authz/scope` changes in two ways. It answers with a plugin that
judges the caller, lists every plugin judging them under `sources`, and says
which one answered under `source` — `--authz-scope-source` chooses when
several can. And when the only plugins judging the caller cannot describe a
scope — `authzPerRoute`, `authzDynamic` — it answers `described: false` with
no entity instead of `unrestricted: true` with `create: true` everywhere. A
client that enumerates the entities it may create offers nothing there
rather than everything. An anonymous caller is answered `401` as soon as any
authorization plugin is loaded, where it used to be told `unrestricted`.

### A second word after an option taking a list is refused

**Who is affected:** anyone whose command line puts two values after one
`--plugin`, `--authz-for`, `--mail-domain` or other list option.

`--authz-for oidc authToken` read as `["oidc"]`: the second word was dropped
in silence, and for `authz_for` that is a population smaller than the
command line says — requests of `authToken` that nothing judges. The server
now refuses to start on it, naming the option. Repeat the option for each
value (`--authz-for oidc --authz-for authToken`), or use the plural form
where there is one (`--plugins "a b"`), or the environment variable, which
splits on spaces and commas.

### `getLogger()` may return `undefined`, and its type says so

**Who is affected:** anyone building a plugin or a host in TypeScript
against the package's `expressformatedresponses` export and calling
`getLogger()`.

The logger is installed by the `DM` constructor, and before that there is
none. The type used to say `winston.Logger`, so a reader without a guard
compiled and threw `Cannot read properties of undefined` at runtime — from
inside an error path, which is how #182 and #199 happened. It now says
`winston.Logger | undefined`, and such a reader stops compiling:

```ts
getLogger().info('…'); // no longer compiles
getLogger()?.info('…'); // logs when there is a logger
```

A plugin holds `this.logger`, which is always set; `getLogger()` is for a
helper with no server in hand. `setLogger` accepts `undefined` as well, so a
test restoring the state it found no longer needs a cast.

### OpenID Connect honours `auth_path_prefix`

**Who is affected:** anyone running `core/auth/openidconnect`, and in
particular anyone who gave it an `auth_path_prefix`.

The plugin did not go through the authentication dispatcher: it mounted its
own middleware in `api()`, which kept its registration order, and it never
read `auth_path_prefix`. Three consequences, all of them now gone:

- **Scoping did nothing.** An instance scoped to `/api/admin` guarded the
  whole server. It now guards `/api/admin` — and **the paths it used to
  guard by accident are no longer guarded by it**. Check that another
  authentication plugin covers them, or drop the prefix to keep guarding
  everything. The startup line naming unguarded routes works again and is
  the fastest way to tell.
- **Authorization could run before the identity.** With
  `core/auth/authzPerRoute` loaded, a named OIDC instance landed in the
  parallel batch and mounted after it, so every rule was judged with no
  `req.user` — and an unidentified request is passed, not refused. Rules
  that read as enforced were inert.
- **Two authentications composed as an AND.** A valid `Authorization:
Bearer` answered by a catch-all token plugin was then redirected to the
  provider anyway. Only the plugin whose claim is most specific runs now.

`/login`, `/logout`, `/callback` and `/backchannel-logout` are claimed by
the plugin whatever its scope, so a catch-all authentication no longer
answers the provider's redirect with a 401.

Unauthenticated requests are unchanged: a browser is redirected, an API
client receives 401.

### `core/auth/llng` refuses a request the handler named nobody for

**Who is affected:** anyone whose LemonLDAP::NG configuration has a `skip`
rule on a path this plugin guards.

`skip` makes the handler return immediately — no session read, no
`Lm-Remote-User` header — and the plugin published `req.user = undefined`.
Every authorization plugin skips its check when a request carries no
identity, so the rule meant "authenticated, and scoped by nobody" rather
than "no authentication on this path". Such a request now answers 401.

Serve those paths from a virtual host this plugin does not guard, or scope
the plugin with `auth_path_prefix` so they fall outside it.

### `authzDynamic` no longer steps aside for another authenticator

**Who is affected:** anyone loading `core/auth/authzDynamic` beside another
authentication plugin on the same paths — `core/auth/token`,
`core/auth/openidconnect`, `core/auth/llng`.

The plugin returned early as soon as a request already carried a `req.user`,
so the token ACLs were applied to nothing. With `core/auth/token` registered
first, its static tokens reached the whole directory as unscoped
administrators; registered the other way round, the same configuration
demanded both credentials. Which one a deployment got was plugin import
order.

The ACLs now apply to the token a request carries, whoever else identified
it, and a request carrying none is refused. **A deployment relying on the
old behaviour will start answering 401** — its callers authenticate with the
other plugin and have no dynamic token.

`--authz-dynamic-bypass` names what may pass without a token:

```
--authz-dynamic-bypass any-authenticated   # what the plugin did before 0.9.0
--authz-dynamic-bypass ops-admin           # one identity, as another plugin publishes it
--authz-dynamic-bypass trusted-proxy       # what core/auth/trustedProxy vouched for
```

`any-authenticated` restores the previous behaviour in one line. The
difference is that it is now written down, logged per request with the
reason, and announced at startup when this plugin shares its paths with
another authenticator.

`trusted-proxy` is the composition the old code's comment described and
never performed: `core/auth/trustedProxy` sets `req.trustedProxy` and
`req.proxyAuthUser`, never `req.user`, so that pair never took the early
return — while every authenticator that does set it, did.

### An identity that does not resolve is refused

**Who is affected:** anyone running an authorization plugin that resolves
identities against the directory — `core/auth/authzLinid1` — behind an
authenticator that publishes something other than the directory's
`ldap_user_main_attribute`.

Every authorization hook skipped its check when `resolveUser` answered
null: a `warn`, then the read, the write or the delete went ahead. With
`authzLinid1`, whose `resolveUser` searches
`(<ldap_user_main_attribute>=<identity>)`, an authenticator publishing
anything else resolved to nothing on every request — `core/auth/openidconnect`
publishes the OIDC `sub`, `core/auth/llng` whatever `whatToTrace` traces — so
anyone the identity provider admitted read, wrote and deleted across the
whole tree, behind a line a `notice` production log does not show.

An authenticated identity that does not resolve is now refused, with the same
403 as any other refusal. **Check your logs before upgrading**: a deployment
in this state looks healthy, and the requests that were passing will start
answering 403.

```
grep 'could not be resolved' <your log>
```

If that matches, the caller's identity and the plugin's model disagree, and
the upgrade turns an open door into a refusal — which may be a service
outage where the door was being used. `--authz-unresolved-user allow`
restores the old behaviour while you fix the pairing; it keeps the warning,
and it keeps the door open.

An **anonymous** request is unchanged: no identity at all is still skipped,
and the route's own authentication is what answers it.

Both answers are cached now, negatives included, for the plugin's own cache
TTL. An identity added to the directory after being refused waits out that
TTL.

### `/subnodes/search` caps what it returns

**Who is affected:** a client reading the whole answer of
`/api/v1/ldap/organizations/<dn>/subnodes/search` and expecting every match.

It returned every attached entry it found, which is the one shape a directory
with a size limit cannot answer: past that limit the server refuses the
search rather than shortening it. It now caps them at
`--ldap-organization-max-subnodes` (default 50) and ends the list with the
`moreIndicator` row `/subnodes` already used, so the two endpoints answer the
same shape.

A client that treats every row as an entry will show that row as one. Drop
whatever carries `_isMoreIndicator` — see
[the endpoint's notes](plugins/ldap/organizations.md#get-organization-subnodes).

The same row can now also appear among the **child organizations**, which
were never capped and still are not: it says the directory refused to list
them all, and it carries no `_totalCount`, nothing having counted them.

### `/subnodes/search` is authorized, and lists the children by page

**Who is affected:** anyone whose callers reach that route with a token that
does not hold the whole directory, and anyone running against Active
Directory.

Neither of its searches carried the request, and an authorization plugin
skips its check when there is none — the same gap the flat routes had until
0.8.2. A caller now sees what its branch grants it, where it used to see
everything the directory held; a caller outside its branch is refused. This
is a fix, but it changes what an existing client receives.

The child organizations of both routes are also searched by page now. On
OpenLDAP that changes nothing — the server's size limit bounds a paged
search as it does an unpaged one. On **Active Directory** it does: an
unpaged search answered at most `MaxPageSize` entries (1000 by default) and
said nothing about the rest, so a node with more children than that now
returns all of them, and a client holding the answer in memory receives a
larger one than before.

### Back-Channel Logout keeps its marks in `core/storage`

`core/bcl/ldap` and `core/bcl/file` are gone, and with them
`--bcl-ldap-base`, `--bcl-ldap-object-class`, `--bcl-file-directory` and
`--bcl-sweep-interval`. One plugin, `core/bcl`, keeps what a logout killed in
`core/storage`, so a deployment chooses where records live once and every
consumer of that store follows. Sweeping is now `--storage-sweep-interval`;
`--bcl-retention` stays, because how long a mark is kept is Back-Channel
Logout's policy rather than the store's. See
[Storage](plugins/utilities/storage.md) and
[Back-Channel Logout](plugins/auth/back-channel-logout.md).

**Marks written before this are not read.** The key is namespaced now, and
the LDAP branch is the store's rather than the plugin's. Back-Channel Logout
shipped in no release — 0.8.2 predates it — so this can only affect an
instance running a build from `master`. If yours is one, everything logged out
within the retention window stops counting once you upgrade, and the old
`ou=BclTombstones` branch, or the old `--bcl-file-directory`, is left behind
for you to remove.

### Judging an account by what it is attached to

`--authz-filter-attached-entries` changes what a branch grant means, so it is
off by default and nothing moves until you set it.

Every account of a directory lives in the same `ou=users`, so a branch check
on its parent says the same thing about all of them: either every
administrator reaches every account, or none does. With the option on, an
account is judged by the organization its `twakeDepartmentLink` names —
listings drop the accounts attached elsewhere, and a write is refused on an
account outside the branch you hold. Entries attached to nothing, which is
what an organization or a nomenclature value is, stay readable by every
administrator.

**Turn it on only where a branch is a department.** Where a branch is a
tenant, the option also stops refusing a read on the branch it targets — the
organization tree and the reference data become readable across branches, and
what keeps one customer out of another's data is then the per-entry filter
alone.

It is honoured by `core/auth/authzPerBranch` and `core/auth/authzLinid1`.
`core/auth/authzDynamic` registers its own hooks and never sees the filter:
setting the option there does nothing at all.

## To 0.8.0

### Node 20 is the floor

**Who is affected:** anyone installing on Node 18 or older.

`engines` declares `>=20` — the version Debian 13 ships — and the CI runs the
suite on 20, 22, 24 and 26. Older runtimes are neither tested nor supported.

**`core/auth/llng` is the one plugin that does not follow.** It needs
`lemonldap-ng-handler`, which depends on the native `re2`, and no single `re2`
release installs on every supported Node: up to `1.24.0` it builds on 20 but
not on 26, and from `1.24.1` it declares `engines: >=22`. npm answers an
unsatisfied dependency of this kind by leaving an _optional_ package out
without a word, so on some runtimes the handler is simply absent.

Everything else builds, tests and runs there regardless. A server that
configures `core/auth/llng` on a runtime where the handler could not be
installed now fails at startup, naming the plugin and the missing package,
rather than accepting requests an authentication plugin cannot check. Check
after upgrading that the runtime you deploy on carries it:

```bash
node -e "require('lemonldap-ng-handler'); console.log('present')"
```

### The LLNG handler now needs a working configuration at startup

**Who is affected:** every deployment configuring `core/auth/llng`.

The handler used to do nothing at startup: `--llng-ini` was read into the
configuration but never handed to it, so every request failed with a `500`
regardless of what the file said. It is now initialized once, before the
server starts serving — which means the file finally matters, and two ways
it can be wrong now stop the server instead of answering `500`:

- `--llng-ini` defaults to `/etc/lemonldap-ng/lemonldap-ng.ini`, and a file at
  that path with no `[node-handler] nodeVhosts` listing this server — the
  normal state until now, since nothing read it — refuses to start where it
  used to start and answer `500` to every request instead;
- an LLNG configuration store (`[configuration] baseConfigUrl` and the rest)
  unreachable when the server boots crash-loops it under an orchestrator,
  until the portal or config store it depends on comes up.

List this server before upgrading:

```ini
[node-handler]
nodeVhosts = api.example.com
```

and, if the LLNG configuration store starts after this server does, sequence
the two or give the container a restart policy that tolerates a few
failures at boot.

### The Twake schemas now need `core/ldap/enterpriseRules`

**Who is affected:** every deployment loading `static/schemas/twake/*`.

Those schemas mark `twakeDepartmentPath`, `twakeAccountStatus` and
`twakeDeliveryMode` both `required` and `generated` — a client may not send
them, and a plugin has to fill them. Load the one that does:

```bash
--plugin core/ldap/enterpriseRules
```

Without it, a creation answers `400` naming the attribute, on the flat routes
as on `POST /ldap/organizations` and `POST /ldap/groups`. That refusal is
deliberate: the previous release wrote the entry anyway, missing an attribute
its own schema called required and that no client could ever add.

**The nomenclature has to hold what the schema defaults name.** The user
schema points at `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,<base>` and
`cn=active,ou=twakeAccountStatus,ou=nomenclature,<base>`. A directory never
seeded with those entries answers `400` on every creation, naming the DN that
does not resolve — rather than storing a dangling one on each account.

### Clients must stop sending the computed attributes

**Who is affected:** anything that creates or updates users, groups or
organizations against the Twake schemas.

`uid` (generated from the local part of `mail`), `twakeDepartmentPath`,
`twakeAccountStatus` and `twakeDeliveryMode` are refused in a request body
with a `400` naming the attribute. Drop them from the payload — the server
fills them.

To keep the old behaviour, copy the schema and remove the markers: each of
these is a `generated` or `readOnly` flag in the JSON, not code.

### Run the audit before switching

**Who is affected:** every directory holding entries written before this
release.

```bash
npm run audit:directory -- --schema static/schemas/twake/users.json \
  --plugin core/ldap/enterpriseRules
```

It reads the branch as it stands and reports what the schema would now refuse,
quoting each rule's own `hint`. Two rules tightened in ways that only show on
stored data:

- an array's `items.test` and `items.branch` are enforced on the flat,
  organization and group routes, where they never were —
  `mailAlternateAddress` has carried a pattern since 0.7.0 and accepted
  anything — and an array of pointers must name existing entries;
- a pointer's `branch` is compared RDN by RDN. A DN that merely ended with the
  branch as text, `uid=x,xou=users,dc=example,dc=com` against
  `ou=users,dc=example,dc=com`, used to pass.

Stored values are left alone. The refusal comes at the next update of an
offending entry, which is why it is worth knowing beforehand.

### `employeeNumber` is unique, apart from the `UNIT` placeholder

**Who is affected:** directories where accounts share a placeholder employee
number other than `UNIT`.

`static/schemas/twake/users.json` declares `employeeNumber` unique, exempting
the value `UNIT` — the placeholder the interface these schemas replace uses
for an account standing for a unit rather than a person. Once
`core/ldap/enterpriseRules` is loaded, every creation or update carrying a
value another account already holds answers `409`; `UNIT` is let through
however many accounts carry it.

A deployment whose placeholder is spelled otherwise has to say so, or its
second holder of that value is refused, and every existing holder at its next
update of the attribute. The audit cannot warn: uniqueness spans the whole
directory, and it only checks what each entry says on its own.

Find the shared values before switching:

```bash
ldapsearch -LLL -b "ou=users,<base>" "(employeeNumber=*)" employeeNumber \
  | awk '/^employeeNumber:/ {print $2}' | sort | uniq -cd
```

Then name yours in a copy of the schema, as
`static/schemas/example/users.json` does:

```json
"unique": { "sentinel": "YOUR-PLACEHOLDER" }
```

### Calendar resource ids, and the branch they are looked for in

**Who is affected:** deployments loading `core/twake/calendar` (the plugin
`calendarResources` was renamed to).

Three things changed in how an LDAP entry is matched to a Calendar resource.
A resource whose DN is `cn=…` or `uid=…` directly under the configured base,
with no escape in its value, keeps the identifier it had and needs nothing.

**`--calendar-resource-base` must be a full DN.** The branch was tested by
asking whether the DN _contained_ the configured value as text, so a partial
value like `ou=resources` matched — and matched a sibling branch such as
`ou=resourcesArchive` with it. It is compared by DN components now, which
also fixes the other direction: a DN written with spaces after its commas was
not recognised as a resource at all. Give the option the whole DN; the plugin
warns at startup when the value is not one under `--ldap-base`.

**The identifier is read from the entry's own RDN.** It used to come from an
unanchored search for `cn=` or `uid=` anywhere in the DN, so an entry whose
own RDN was neither borrowed the one of an ancestor; failing that, creation
fell back to a slug of the entry's name, under which modification and
deletion then found nothing. An RDN value carrying an escape — `cn=Salle\, 2`
— was cut at the escape.

So an entry of either of those shapes is now created, patched and deleted in
Calendar under a different identifier than before. **The resource Calendar
already holds under the old one is not migrated**: rename it there, or delete
it and let the next write recreate it. List what is affected before
upgrading — every resource whose RDN attribute is neither `cn` nor `uid`, and
every one whose RDN value contains a `\`.

**A modification or a deletion outside the base no longer reaches Calendar.**
Only creation checked the branch; the other two acted on any entry of the
entity whose DN yielded an identifier.

### Renaming an entry, and what the cascade reaches

**Who is affected:** anyone calling the new
`POST /v1/ldap/{resource}/{id}/rename`. Nothing changes for a deployment
that does not.

The identifier of a flat entry can be changed. The entry's DN changes with
it, so everything naming that DN has to be rewritten, and the endpoint waits
for that before it answers.

What it rewrites is read from the schemas, never from a list of attribute
names: every `pointer` — single or in an array — whose `branch` admits the
renamed entry, and every attribute carrying the `members` or `owners` role.
**Load `core/ldap/enterpriseRules`**: without it the entry is renamed and
nothing else is touched.

What it cannot reach is a DN held in a plain `string` attribute that carries
no role. Declare it a `pointer`, or give it its role, and it is covered.

A directory running OpenLDAP's `refint` overlay already fixes the attributes
it is configured for — usually `member`, `owner`, `uniqueMember` and
`memberOf` — in a task of its own, after the rename has answered. The server
converges with it rather than fighting it: what the overlay has already
fixed counts as done. `refint` is not a substitute, though. It never sees a
deployment's own pointers, `twakeManagerLink` and `twakeLocalAdminLink`
among them — and losing the second one silently costs an administrator every
branch they administer.

### A rename answers `207` when it could not finish

The rename of the entry and the rewrite of what points at it are separate
writes, and a directory has no transaction to hold them together.

If the rename itself fails, nothing else has happened and the directory's own
refusal is what you get. Once it succeeds the rename is a fact, and an error
would tell you the opposite — so a rewrite that fails answers `207` with the
attributes and the counts that could not be written. The referring DNs are
not in the body, where the caller has no business reading them; they are in
the log, at `error`, with the attribute and both DNs.

**Re-issue the identical request to finish it.** A rename whose source is
already gone and whose target is already there runs the rewrite alone. That
is also what to do if the server dies between the two writes.

### `unique` is not widened on a rename

A schema marking its identifier `unique: { "branches": [...] }` gets the
RDN's own branch checked on a rename, and nothing more: the wider check runs
from the add and modify hooks, which a rename does not go through. The
endpoint's own description says so too.

### Creating an entry that already exists answers `409`

**Who is affected:** any client that reads a failed creation by its status
code or by the text of its message — a bulk import recording per-line errors
most of all.

Two creations of the same entry racing past the existence checks answered
`500`, the add path having wrapped every LDAP error in a plain `Error`. The
directory's own `entryAlreadyExists` is now recognised once, in
`lib/ldapActions`, so every creation route answers `409` alike: the flat
routes, `POST /ldap/groups`, the organization routes, and the external
members `core/ldap/externalUsersInGroups` inserts.

The message is `Entry <dn> already exists`. The flat routes used to say
`<entity> <dn> already exists`, and `core/ldap/bulkImport` used to record
`LDAP add error: …` in its per-line `errors[]`; both read the same now.
SCIM still answers `uniqueness`, the numeric code being carried on the
error it is given.

### A flat schema may not claim a URL an LDAP plugin serves

**Who is affected:** anyone passing `--ldap-flat-schema` a schema whose
`entity.pluralName` is `groups`, `organizations`, `raw` or `bulk-import`
beside the plugin of the same name — `static/schemas/twake/groups.json` is
exactly that.

Both used to load, sharing a hook prefix and a URL; Express answered with
whichever registered first, and the loser stayed advertised by the
configuration API while being unreachable in fact. The schema is now dropped
with an error naming the holder. **Load one or the other, not both.**

### Organization paths: nothing to convert

**Who is affected:** directories written before the path order was settled.

`twakeDepartmentPath` reads from the root down, the entry's own name last.
What is already stored in the old order — the entry's own name first, the top
organization's last — is still accepted as it stands, so no organization
becomes unwritable on upgrade. Only paths the server computes from now on
follow the new order, and the two forms coexist until an entry is rewritten.

### The search cache works now, and is off by default

**Who is affected:** deployments that set `--ldap-cache-ttl` (or
`DM_LDAP_CACHE_TTL`) explicitly. Everyone else keeps exactly the behaviour
they had.

The base-scope search cache stored nothing since it was written: the branch
that would have kept a result could not be reached, so every read went to the
directory whatever the option said. It caches now — which means a deployment
that had set the option gets a working cache for the first time, where it used
to get none.

What a write through this service drops is what it changed, its subtree
included, whatever case the DN is written in. What this service cannot know
about, it cannot drop: another replica of it, an LSC synchronisation, a
hand-run `ldapmodify`. A cached read stays as it was until its TTL runs out.

So `--ldap-cache-ttl` now defaults to `0`, which means no caching at all. Set
it only where this service is the sole writer of the entries it reads, and
keep the value under the staleness you are willing to serve.

### `calendarResources` is renamed `calendar`

**Who is affected:** deployments loading `core/twake/calendarResources`, and
plugins importing `ldap-rest/plugin-twake-calendarresources` or looking the
plugin up by name.

Besides calendar resources, the plugin propagates user email and name changes
to the Twake Calendar registered users; the old name hid that. Nothing breaks
yet: `core/twake/calendarResources` still loads the same plugin, registered
under its old name, and logs a deprecation warning. It will be removed in a
future major release, so switch now by **replacing** the old name with the new
one:

```bash
# before
DM_PLUGINS="…,core/twake/calendarResources"
# after
DM_PLUGINS="…,core/twake/calendar"
```

Do not list both: they register under different names, so the loader does not
see a duplicate and runs two instances — every resource change and every user
email or name change is then sent to Calendar twice.

Plugin code should import `ldap-rest/plugin-twake-calendar` and look the
plugin up as `calendar`. Configuration flags (`--calendar-*`) are unchanged.

## To 0.7.0

### `externalId` on Groups is no longer served

**Who is affected:** anyone provisioning Groups from an identity provider and
reading `externalId` back, or filtering on it.

A Group's `externalId` used to answer its `entryUUID`. RFC 7643 section 3.1
makes `externalId` the _provisioning client's_ identifier, so the id Okta or
Entra ID sent was discarded on write, and `filter=externalId eq "<their id>"`
searched `entryUUID` and matched nothing.

Name an attribute to store it in:

```bash
--scim-group-external-id-attribute description
```

Left unset, `externalId` is simply not supported on Groups — absent from
answers, and refused in filters. That is the honest behaviour; the previous
one looked like support and was not.

Users are unaffected: theirs was already stored in `employeeNumber`.

**Migrating existing Groups.** Values sent before this release were never
stored, so there is nothing to convert — re-send them from the provisioning
side once the flag is set.

### `active` is now writable, and needs an attribute your directory holds

**Who is affected:** every SCIM deployment. Deactivations that used to be
silently dropped now reach the directory.

`active` is modelled on the presence of one LDAP attribute:

```bash
--scim-user-lock-attribute pwdAccountLockedTime   # default
--scim-user-lock-value     000001010000Z          # default, "locked forever"
```

The default is the ppolicy overlay's convention, and **`pwdAccountLockedTime`
only exists where slapd loads that overlay**. On a directory without it —
plain OpenLDAP, 389-ds, AD — a deactivation is refused by the schema and
answers `400 invalidValue` naming the flags. Point them elsewhere:

```bash
--scim-user-lock-attribute nsAccountLock
--scim-user-lock-value     TRUE
```

Two configuration mistakes are now refused at startup rather than accepted
and silently ineffective: naming an attribute without a value, and a name
that is not an LDAP attribute description. Two more are warned about. See
[the SCIM plugin documentation](plugins/integrations/scim.md#deactivating-an-account-active) for the
detail.

**Verify once, by hand, that a deactivation actually prevents a bind.**
Nothing here can check that your directory honours the value you chose:
`active` is read back from the mere presence of the attribute, so a value the
directory stores and ignores still reads as `false`.

**One deliberate deviation from RFC 7644 section 3.5.1:** a `PUT` that omits
`active` leaves the lock as it stands rather than clearing it. Clearing it
would release locks SCIM never set — a ppolicy auto-lockout after failed
binds, or one an administrator placed — so a routine profile sync would
defeat the brute-force control. Send `"active": true` to reactivate
deliberately.

### `forRequest()` for plugin authors

No action needed to upgrade. If you maintain a plugin that serves HTTP
requests, `this.server.ldap.forRequest(req)` returns a directory whose methods
carry the request, so the authorization hooks always see it. The unbound
methods take the request as a trailing optional argument, and omitting it
skips every authorization check silently. See the
[plugin development guide](../plugin-development/README.md#using-ldap-operations).

## To 0.6.2

### Writes that a bypass was letting through are now refused

**Who is affected:** deployments using `core/auth/authzPerBranch` or
`core/auth/authzLinid1` together with `plugins/ldap/onChange` or
`plugins/ldap/organizations`.

Both plugins rebuilt the hook tuple without the request, which made every
authorization plugin registered after them skip its check. Every `modify`,
and every `rename` for the second, went through unchecked.

**Check your grants before rolling this out widely.** An identity whose
grants were never quite right may start seeing `403` where it saw `200`. That
is the fix, not a regression.

Whether a given deployment was exposed was decided by plugin load order,
which is a race — it could differ from one restart to the next.
`core/auth/authzDynamic` was never affected: it reads its token from an
`AsyncLocalStorage` rather than from the request.

## To 0.6.1

### SCIM reads are authorized

**Who is affected:** any SCIM identity granted `write` without `read` on the
same branch.

Every search the SCIM plugin issued omitted the request, so
`ldapsearchrequest` — the hook the authorization plugins use — skipped its
check, and any authenticated identity could read any branch the plugin was
pointed at.

**An identity that writes now needs `read` on the same branch.** A SCIM write
answers with the resource it just changed, so it reads the entry back; a
grant of `write` without `read` no longer serves a write.

`GET /Users`, `GET /Users/{id}` and their Group counterparts answer `403`
where read is denied.
