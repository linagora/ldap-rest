# Core hooks

Set here the documentation of all hooks.

## Demo hooks

- **hello**, `() => string`: called by [helloworld demo plugin](./src/plugins/helloworld.ts)

## [LDAP](./src/lib/ldapActions.ts) hooks

- **ldapopts**, `(opts: ldapts.SearchOptions) => same`:
  called before any ldapsearch to modify search options
- **ldapsearchresult**, `(res: ldapts.SearchResult | AsyncGenerator<ldapts.SearchResult>) => same`:
  called after any ldapsearch to modify search result
