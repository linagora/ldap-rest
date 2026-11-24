# LemonLDAP::NG Authentication

Integration with [LemonLDAP::NG](https://lemonldap-ng.org/) (LLNG) Web SSO solution.

## Configuration

```bash
--plugin core/auth/llng \
--llng-ini /etc/lemonldap-ng/lemonldap-ng.ini
```

**Environment Variable:**

```bash
DM_LLNG_INI="/etc/lemonldap-ng/lemonldap-ng.ini"
```

## Rules that name nobody

The plugin serves a request only when the handler named a user. A LemonLDAP::NG
location rule set to `skip` makes the handler return at once — no session
read, no `Lm-Remote-User` written — and such a request is refused with 401
rather than served with no identity: every authorization plugin skips its
check when a request carries no identity, so "no authentication on this path"
would have become "authenticated, and scoped by nobody".

Serve such a path from a virtual host this plugin does not guard, or scope
the plugin with `auth_path_prefix` so the path falls outside it.

The identity header is read whatever case the handler wrote it in, and
whatever the client sent under that name is dropped before the handler runs:
only the handler may name the caller.

`req.user` is what `whatToTrace` traces, which is often a mail or a display
name. `--llng-username-header` names a second header LemonLDAP::NG exports
carrying the login, published as `req.userName`; with
`--authz-identity req.userName`, rules are then written on logins. Export it
from the LLNG configuration as you would any other header.

Whatever the request carried under that name is dropped before the handler
runs, exactly as the identity header is: a rule can be keyed on
`req.userName`, so a client supplying it would otherwise take over the
identity that rule names. The consequence is that the value must come from
the handler — a header set by an upstream proxy does not survive, and would
only have been trustworthy if that proxy stripped the client's copy itself.

## Requests from other sites

The LemonLDAP::NG cookie goes with every request, whichever page asks: a
request that changes something is refused (`403`) when the browser reports it
as coming from an origin other than `--base-url` or those listed in
`--auth-trusted-origin`. A console served from another origin must be listed
([details](README.md#cookie-sessions-and-other-sites)).

## Location rules and letter case

LDAP-Rest routes paths ignoring letter case: `/API/V1/LDAP/USERS` reaches the
same routes as `/api/v1/ldap/users`. The handler is therefore given the path in
lower case, letters sent percent-encoded included, so that a location rule
covers every spelling of the paths it names. The request itself is routed as
it was sent. The handler matches non-ASCII characters percent-encoded, with
upper-case digits: write `équipe` as `%C3%A9quipe` in a key.

Write the location keys in lower case, `^/scim/v2/users` rather than
`^/scim/v2/Users`, or start them with `(?i)`. The plugin refuses a key that
may need a capital letter outside a part that ignores case, whether written
(`Users`, `É`, `[A-Z]`) or encoded (`\x55`, `\p{Lu}`, `[[:upper:]]`): it
stops the server at startup, and a configuration reloaded with one makes the
plugin answer 503 until it is corrected. The check errs on the side of
refusing: an optional capital (`U?`) or an alternative (`(U|u)`) is refused
too, while `[Uu]` and `(?i:…)` are accepted.

## Prerequisites

1. **LemonLDAP::NG Handler**: The `lemonldap-ng-handler` npm package (optional dependency)
2. **LLNG Configuration**: Valid `lemonldap-ng.ini` file
3. **Virtual Host Configuration**: LDAP-Rest must be configured as a protected application in LLNG

The handler runs inside LDAP-Rest and reads `lemonldap-ng.ini` when the server
starts. The file tells it where the LLNG configuration is, and which virtual
hosts it protects — a Node.js handler serves only those listed in
`nodeVhosts`:

```ini
[configuration]
type = REST
baseConfigUrl = https://auth.example.com/index.fcgi/config

[node-handler]
nodeVhosts = api.example.com
```

A file that cannot be read, a configuration that cannot be reached or a
missing `nodeVhosts` stops the server at startup, with the reason.

## How It Works

1. Uses the LemonLDAP::NG Handler to validate requests
2. Extracts user identity from `Lm-Remote-User` header
3. Sets `req.user` to authenticated username
4. Inherits all LLNG authorization rules and features

## Installation

Install the optional dependency:

```bash
npm install lemonldap-ng-handler
```

## LLNG Configuration

Declare the virtual host of LDAP-Rest in LemonLDAP::NG and list it in
`nodeVhosts`. The handler runs inside LDAP-Rest: a reverse proxy in front only
forwards, and must keep the `Host` header, which names the virtual host:

```apache
<VirtualHost *:443>
  ServerName api.example.com

  ProxyPreserveHost On
  ProxyPass / http://localhost:8081/
  ProxyPassReverse / http://localhost:8081/
</VirtualHost>
```

Do not also put a Perl handler (`Lemonldap::NG::Handler::ApacheMP2`) in front
of this virtual host: the two handlers read the same rules, in two different
languages.

## Use Cases

- **Enterprise SSO**: Centralized authentication for multiple applications
- **Advanced Authorization**: Fine-grained access control using LLNG rules
- **Session Management**: Centralized session handling
- **Multi-Factor Authentication**: MFA support through LLNG

## Example: LLNG Authorization Rules

The Node.js handler evaluates the rules as **JavaScript**, not Perl: `$name`
becomes `session.name` and the rest is run as is. A Perl rule does not do what
it reads: `$groups =~ /\badmins\b/` assigns `-1` to `$groups` and grants every
user, and `eq`, `and` or `m#…#` stop the server at startup. `$uri` is not
provided either: the path is chosen by the location key, a regular expression
tried in order before `default`.

In the LLNG Manager, under _Virtual Hosts > api.example.com > Access rules_,
or in the configuration file:

```json
{
  "locationRules": {
    "api.example.com": {
      "^/api/v1/ldap/users": "/\\b(?:hr|admins)\\b/.test($groups)",
      "^/api/v1/ldap/groups": "$uid === \"groupmanager\" || /\\badmins\\b/.test($groups)",
      "default": "/\\badmins\\b/.test($groups)"
    }
  }
}
```

The HR group and the admins reach the users, `groupmanager` and the admins
reach the groups, and only the admins reach the rest. A location rule replaces
`default` for the paths it matches: repeat in it whom `default` lets through.

## Troubleshooting

**Problem:** Handler not found

**Solution:** Install optional dependency:

```bash
npm install lemonldap-ng-handler
```

**Problem:** Authentication refused

**Solutions:**

1. Verify LLNG handler is configured correctly
2. Check virtual host configuration
3. Review LLNG access logs

## See Also

- [LemonLDAP::NG Documentation](https://lemonldap-ng.org/documentation)
