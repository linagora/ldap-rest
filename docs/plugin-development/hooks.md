# Core hooks

Set here the documentation of all hooks.

Typescript definitions into [hooks.ts](./src/hooks.ts)

## Demo hooks

- **hello**: called by [helloworld demo plugin](./src/plugins/helloworld.ts)

## [LDAP](./src/lib/ldapActions.ts) hooks

- **ldapopts**: called before any ldapsearch to modify search options
- **ldapsearchresult**: called after any ldapsearch to modify search result
- **ldapaddrequest**: called before any ldapadd
- **ldapadddone**: launched once an ldapadd has written the entry, not awaited
- **ldapaddafter**: awaited once an ldapadd has written the entry, before it
  answers, see [below](#ldapaddafter)
- **ldapmodifyrequest**: called before any ldapmodify
- **ldapdeleterequest**: called before any ldapdelete
- **ldaprenamerequest**: called before any ldap rename/modifyDN operation

### ldapaddafter

For what must follow an add within the same request, such as provisioning
the account the entry describes.

- Subscribers get `[dn, entry]` and the change context, as `ldapadddone`
  does. They run one after the other, and `add()` answers once the last has
  returned.
- An error is logged and goes no further: the add has succeeded, and the
  next subscriber still runs. A subscriber that can fail owns its repair
  path, and should be safe to run again on the same entry.
- It fires for every add, including those made without a request (trash,
  storage, appAccountsConsistency, externalUsersInGroups), whose context is
  empty. Some of these follow an API call all the same, so select entries by
  their DN or attributes rather than by an empty context.
- The entry is the one submitted, after `ldapaddrequest`, not what the
  directory holds: no operational attributes, and the password as given.
- `ldapadddone` and `onLdapEntryChange` fire whatever this hook does, and in
  no set order with it: an add event may or may not include what a
  subscriber here wrote.

## [onChange](../usage/plugins/ldap/on-change.md) hooks

- **onLdapEntryChange**: called after any write, with the entry before and
  after it, and who made it
- **onLdapChange**, **onLdapMailChange**…: derived from it
