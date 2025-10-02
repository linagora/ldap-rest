[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/linagora/mini-dm)

# Mini-dm

Lite LinID directory manager is a lightweight directory manager that provides LDAP integration through a plugin-based architecture.
This system enables directory management operations with configurable authentication, extensible functionality through events/hooks,
and extensible REST API.

Core plugins also provide plugins that ensure LDAP data consistency.

## How it works

All configuration is done via command-line arguments and/or environment variables.
Example:

```shell
npx mini-dm --ldap-base 'ou=users,o=comp,c=fr' \
    --ldap-dn 'cn-admin,o=comp,c=fr' --ldap-pwd adm \
    --ldap-url ldap://localhost \
    --plugin core/ldap/groups --ldap-group-base 'ou=groups,o=comp,c=fr' \
    --plugin core/ldap/externalUsersInGroups
```

## Command-line options and environment variables

[ToDo]

See also [Typescript declarations](./src/config/args.ts).

## Developers doc

- [Plugins](./src/plugins/README.md)
- [Hooks](./HOOKS.md)

## Copyright and license

Copyright 2025-present [Linagora](https://linagora.com)

Licensed under [GNU AGPL-3.0](./LICENSE])
