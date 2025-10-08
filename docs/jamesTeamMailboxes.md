# James Team Mailboxes

This feature adds support for James/TMail team mailboxes in addition to existing mailing lists. Team mailboxes are shared mailboxes with IMAP access, as opposed to mailing lists which only distribute emails to members.

## Overview

Groups in LDAP can now have three different mailbox types:
- **group**: Simple group without mail functionality (default if no mail attribute)
- **mailingList**: Traditional mailing list (email redistribution via James `/address/groups/` API)
- **teamMailbox**: Shared team mailbox (shared IMAP mailbox via James `/domains/{domain}/team-mailboxes/` API)

## Configuration

### LDAP Schema Amendment

First, apply the schema amendment to add the `twakeMailboxType` attribute:

```bash
ldapmodify -Y EXTERNAL -H ldapi:/// -f docs/examples/twake-mailbox-type-schema-amendment.ldif
```

This adds:
- New attribute type: `twakeMailboxType`
- Updates `twakeStaticGroup` and `twakeDynamicGroup` to include the new attribute

### Nomenclature Setup

Create the nomenclature entries in your LDAP directory:

```bash
# Replace {ldap_base} with your actual LDAP base (e.g., o=gov,c=mu)
sed 's/{ldap_base}/o=gov,c=mu/g' docs/examples/twake-mailbox-type-nomenclature.ldif > /tmp/nomenclature.ldif
ldapadd -x -D "cn=admin,o=gov,c=mu" -W -f /tmp/nomenclature.ldif
```

This creates three nomenclature entries:
- `cn=group,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=mailingList,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`

### Mini-DM Configuration

Add to your mini-dm configuration:

```bash
# Optional: Restrict mailing lists to specific branches
--james-mailing-list-branches "ou=lists,o=gov,c=mu"
```

Or via environment variable:
```bash
DM_JAMES_MAILING_LIST_BRANCHES="ou=lists,o=gov,c=mu"
```

If empty (default), mailing lists can be created anywhere.

## Usage

### Creating a Team Mailbox

```javascript
await dm.ldap.add('cn=sales-team,ou=groups,o=gov,c=mu', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'sales-team',
  mail: 'sales@example.com',
  twakeMailboxType: 'cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,o=gov,c=mu',
  member: [
    'uid=alice,ou=users,o=gov,c=mu',
    'uid=bob,ou=users,o=gov,c=mu'
  ],
  twakeDepartmentLink: 'ou=groups,o=gov,c=mu',
  twakeDepartmentPath: 'Sales'
});
```

This will:
1. Create the team mailbox via `PUT /domains/example.com/team-mailboxes/sales@example.com`
2. Add each member via `PUT /domains/example.com/team-mailboxes/sales@example.com/members/{member-email}`

### Creating a Mailing List

```javascript
await dm.ldap.add('cn=announce,ou=lists,o=gov,c=mu', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'announce',
  mail: 'announce@example.com',
  twakeMailboxType: 'cn=mailingList,ou=twakeMailboxType,ou=nomenclature,o=gov,c=mu',
  member: [
    'uid=alice,ou=users,o=gov,c=mu',
    'uid=bob,ou=users,o=gov,c=mu'
  ],
  twakeDepartmentLink: 'ou=lists,o=gov,c=mu',
  twakeDepartmentPath: 'Lists'
});
```

This will:
1. Validate the group is in an allowed branch (if `--james-mailing-list-branches` is configured)
2. Create the mailing list via `PUT /address/groups/announce@example.com/{member-email}` for each member

### Creating a Simple Group (no mailbox)

```javascript
await dm.ldap.add('cn=developers,ou=groups,o=gov,c=mu', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'developers',
  twakeMailboxType: 'cn=group,ou=twakeMailboxType,ou=nomenclature,o=gov,c=mu',
  member: ['uid=alice,ou=users,o=gov,c=mu'],
  twakeDepartmentLink: 'ou=groups,o=gov,c=mu',
  twakeDepartmentPath: 'Engineering'
});
```

This creates a simple group without any James integration (no mail attribute, no mailbox).

## API Endpoints Used

### Team Mailboxes

- **Create**: `PUT /domains/{domain}/team-mailboxes/{teamMailbox}`
- **Add member**: `PUT /domains/{domain}/team-mailboxes/{teamMailbox}/members/{memberEmail}`
- **Delete member**: `DELETE /domains/{domain}/team-mailboxes/{teamMailbox}/members/{memberEmail}`
- **Delete**: `DELETE /domains/{domain}/team-mailboxes/{teamMailbox}`

### Mailing Lists

- **Add member**: `PUT /address/groups/{groupMail}/{memberEmail}`
- **Delete member**: `DELETE /address/groups/{groupMail}/{memberEmail}`
- **Delete**: `DELETE /address/groups/{groupMail}`

## Validation Rules

1. **Mailing Lists**: If `--james-mailing-list-branches` is configured, mailing lists MUST be located within one of the specified branches. If empty, no location restriction applies.

2. **Team Mailboxes**: No branch restriction. Can be created anywhere in the LDAP tree.

3. **Mailbox Type**:
   - If `twakeMailboxType` is not set and the group has a `mail` attribute, it defaults to `mailingList`
   - If `twakeMailboxType` is not set and the group has no `mail` attribute, it's a simple group (no James integration)

## Backward Compatibility

Existing groups with `mail` attribute but no `twakeMailboxType` will continue to work as mailing lists (backward compatible behavior).

## Testing

Tests require the LDAP schema amendment to be applied first:

```bash
# Apply schema amendment to your test LDAP server
ldapmodify -Y EXTERNAL -H ldapi:/// -f docs/examples/twake-mailbox-type-schema-amendment.ldif

# Run tests
npm run test:one test/plugins/twake/jamesTeamMailboxes.test.ts
```

## References

- [TMail Team Mailboxes Documentation](https://github.com/linagora/tmail-backend/blob/master/docs/modules/ROOT/pages/tmail-backend/webadmin.adoc#team-mailboxes)
- [GitHub Issue #5](https://github.com/linagora/mini-dm/issues/5)
