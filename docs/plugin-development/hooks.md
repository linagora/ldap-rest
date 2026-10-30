# Core hooks

Hooks are how plugins talk to each other. Each one is declared in
[hooks.ts](../../src/hooks.ts), which is the reference for the arguments it
gets and what it must answer; a plugin subscribing to a hook it does not
name there does not compile.

## The bus

`this.hookBus` (or `server.hookBus`) is how a plugin raises a hook, and how a
test waits for one. It has one method per kind of hook, told apart by what a
subscriber answers:

| Kind     | Method                           | Subscriber                                           |
| -------- | -------------------------------- | ---------------------------------------------------- |
| chained  | `chain(name, value)`             | answers the value, changed or not                    |
| notified | `notify(name, ...args)`          | answers nothing, not awaited                         |
| notified | `notifyAndWait(name, ...args)`   | answered nothing, awaited                            |
| notified | `notifyStrict(name, ...args)`    | as `notifyAndWait`, but a failure goes to the caller |
| any      | `has(name)`, `subscribers(name)` | —                                                    |
| any      | `settled()`                      | resolves once every notification so far has run      |

- **Chained.** The value goes from one subscriber to the next, each getting
  what the one before answered; the last answer is the result. A subscriber
  that throws stops the chain and the error travels up: a refusal is a
  refusal. Several values are passed as one tuple.
- **Notified.** Subscribers run one after the other, outside the request
  that caused the write, and are told what happened and was judged: they
  react as the server — synchronizing, publishing, keeping invariants —
  whoever asked. `notify` does not wait for them and never fails: the write
  they react to is done, and a failing subscriber is logged, with its plugin
  and hook, and counted in the [hook failure
  metrics](../usage/operations.md#metrics), then the next one still runs.
- **`notifyStrict`** is for the rare subscriber whose failure is part of the
  answer: a logout token reaches the provider only once what it closes is
  recorded, so the library answers 400 and the provider retries. Every
  subscriber runs even when one fails, and the first failure is raised once
  they all have.

A test that would otherwise sleep waits instead:

```ts
// One hook's subscribers
await server.hookBus.notifyAndWait('ldapadddone', dn, entry, {});
// or whatever the write under test started
await server.hookBus.settled();
```

## Hooks

<!-- hooks: generated from src/hooks.ts, do not edit by hand -->

- **hello**: raised by the [demo plugin](../../src/plugins/demo/helloworld.ts) for `/hello`, answered by the demo plugins
- **ldapsearchopts**: chained before any search, with its options
- **ldapsearchrequest**: chained before any search, with `[base, options, request]`; an authorization plugin refuses by throwing
- **ldapsearchresult**: chained after any search, with its result, before it is cached
- **ldapsearchfilter**: chained on the result of a search after the cache, once per page, with `[result, request, options]`, to drop what the caller may not see
- **ldapaddrequest**: chained before any add, with `[dn, entry, request]`
- **ldapadddone**: notified once an add has written the entry, with `[dn, entry, context]`; not awaited
- **ldapaddafter**: notified once an add has written the entry, before it answers, with `[dn, entry, context]`, see [below](#ldapaddafter)
- **ldapmodifyrequest**: chained before any modify, with `[dn, changes, op, request]`
- **ldapmodifydone**: notified once a modify is written, with `[dn, changes, op, context]`
- **ldapmodifyend**: notified once a modify is over, whatever became of it, and its done subscribers have returned
- **ldapdeleterequest**: chained before any delete, with `[dn, request]`
- **ldapdeletedone**: notified once a delete is written, with `[dn, context]`
- **ldapdeleteend**: notified once a delete is over, whatever became of it, and its done subscribers have returned
- **ldaprenamerequest**: chained before any rename or move, with `[dn, newDn, request]`
- **ldaprenamedone**: notified once a rename or a move is written, with `[dn, newDn, context]`
- **ldaprenameend**: notified once a rename is over, whatever became of it, and its done subscribers have returned
- **oidcsessionvalid**: chained with the claims of a session and the verdict so far, see [the OpenID Connect page](../usage/plugins/auth/openid-connect.md)
- **oidclogouttoken**: notified with the claims of a session a logout token or `/logout` ends
- **oidclogin**: notified with the claims of a session just established
- **ldapgroupvalidatenew**: chained before a group is created, with `[dn, entry]`
- **ldapgroupadd**: chained before a group is added, with `[dn, entry]`
- **ldapgroupadddone**: notified once a group is added, with `[dn, entry]`
- **ldapgroupvalidatechanges**: chained before a group is modified, with `[dn, changes]`
- **ldapgroupmodify**: chained before a group is modified, with `[dn, changes, op]`
- **ldapgroupmodifydone**: notified once a group is modified, with `[dn, changes, op]`
- **ldapgrouprename**: chained before a group is renamed, with `[dn, newDn]`
- **ldapgrouprenamedone**: notified once a group is renamed, with `[dn, newDn]`
- **ldapgroupdelete**: chained before a group is deleted, with its DN
- **ldapgroupdeletedone**: notified once a group is deleted, with its DN
- **ldapgroupaddmember**: chained before members are added, with `[cn, members]`
- **ldapgroupdeletemember**: chained before a member is removed, with `[cn, members]`
- **ldapgroupvalidatemembers**: chained before members are checked, with `[dn, members]`
- **\_ldapgrouplist**: chained around the list of groups, internal to the groups plugin
- **onLdapEntryChange**: notified with the entry before and after any write, and who made it
- **onLdapChange**: notified with the attributes a write changed
- **onLdapMailChange**: notified with the mail before and after a change, or with no new mail for a delete
- **onLdapAliasChange**: notified with the mail and the aliases before and after a change
- **onLdapQuotaChange**: notified with the mail and the quota before and after a change
- **onLdapForwardChange**: notified with the mail and the forwards before and after a change
- **onLdapDisplayNameChange**: notified with the name before and after a change
- **onLdapDriveQuotaChange**: notified with the drive quota before and after a change
- **externaluserentry**: chained before an external member is created, with `[dn, entry]`
- **externaluseradded**: notified once an external member is created, with `[dn, entry]`
- **beforeAuth**: chained on a request before it is authenticated, with `[request, response]`
- **afterAuth**: chained on a request once it is authenticated, with `[request, response]`
- **getOrganisationTop**: chained before the top organization is answered, with `[request, entry]`
- **scimusercreate**: chained before a SCIM user is created, with `[user, request]`
- **scimusercreatedone**: notified once a SCIM user is created
- **scimuserupdate**: chained before a SCIM user is replaced, with `[id, user, request]`
- **scimuserupdatedone**: notified once a SCIM user is replaced, with `[id, user]`
- **scimuserdelete**: chained before a SCIM user is deleted, with `[id, request]`
- **scimuserdeletedone**: notified once a SCIM user is deleted, with its id
- **scimgroupcreate**: chained before a SCIM group is created, with `[group, request, base]`
- **scimgroupcreatedone**: notified once a SCIM group is created
- **scimgroupupdate**: chained before a SCIM group is replaced, with `[id, group, request]`
- **scimgroupupdatedone**: notified once a SCIM group is replaced, with `[id, group]`
- **scimgroupdelete**: chained before a SCIM group is deleted, with `[id, request]`
- **scimgroupdeletedone**: notified once a SCIM group is deleted, with its id
- **scimbulkdone**: notified once a SCIM bulk request is answered
- **twakedeletionreplay**: notified with `[dn, entry, context]` when a delete asks of an entry that is already a tombstone
<!-- /hooks -->

## Flat entities

A plugin built on `LdapFlat` (`--ldap-flat-schema`) raises one set of hooks
per entity: `ldap${entity.name}` followed by the suffix of the shared hook of
the same kind — `add` and `adddone`, `modify` and `modifydone`, `rename` and
`renamedone`, `delete` and `deletedone`, with the same arguments — plus
`{prefix}move` before an entry is moved, followed by `onLdapChange` as a
modify is. A plugin watching one declares it beside its other hooks.

## LDAP write hooks

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

### ldapmodifyend, ldapdeleteend, ldaprenameend

For a plugin that keeps something from a request hook to the matching "done"
one, as core/ldap/onChange keeps the entry it read. A write that is refused
by a request hook, that one of them takes out of the request (core/ldap/trash
and core/twake/tombstone do with a delete), or that the directory refuses,
never reaches its "done" hook; its "end" hook fires all the same.

- Each gets the number of its operation. A modify's request and "done" hooks
  are given it in their arguments; for every modify, delete and rename,
  `currentOperation()` (`lib/operation`) returns it inside the request and
  "done" hooks. Key what you keep by it rather than by DN: two writes of one
  DN may be under way, and only the operation tells them apart.
  Outside those hooks it is whatever encloses the call (an add made from a
  delete's request hook sees the delete's number): in an end hook, use the
  number it is given.
- It is launched once the "done" subscribers of the operation have returned,
  and is not awaited by the write.
- A move (`ldapActions.move`) launches no request hook and no end hook, and
  its `ldaprenamedone` runs outside any operation, even when a request hook
  made it.

## onLdapChange

- **onLdapEntryChange**: called after any write, with the entry before and
  after it, and who made it.
- **onLdapChange**, **onLdapMailChange**…: derived from it, and the
  attribute ones fire only while the entry has the attribute configured for
  them. A delete fires `onLdapEntryChange`, `onLdapChange` and
  `onLdapMailChange` only.

## Ordering

Hooks run in the order their plugins loaded, but for the request hooks of
authorization plugins, which run before every other plugin's, see
[dependencies](dependencies.md#hook-execution-order).
