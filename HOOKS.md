# Core hooks

Set here the documentation of all hooks.

Typescript definitions into [hooks.ts](./src/hooks.ts)

## Demo hooks

- **hello**: called by [helloworld demo plugin](./src/plugins/helloworld.ts)

## [LDAP](./src/lib/ldapActions.ts) hooks

- **ldapopts**: called before any ldapsearch to modify search options
- **ldapsearchresult**: called after any ldapsearch to modify search result
