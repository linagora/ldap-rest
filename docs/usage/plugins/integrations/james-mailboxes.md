# James Team Mailboxes

`twake/james` creates James/TMail team mailboxes from LDAP groups. Team mailboxes are shared mailboxes with IMAP access, as opposed to mailing lists which only distribute emails to members, and which `twake/james` leaves to Twake Mail: see [Mailing lists](#mailing-lists).

## Overview

Groups in LDAP can now have three different mailbox types:

- **group**: Simple group without mail functionality (default if no mail attribute)
- **mailingList**: Mailing list, read from LDAP by Twake Mail; nothing is created in James
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
# Replace {ldap_base} with your actual LDAP base (e.g., dc=example,dc=com)
sed 's/{ldap_base}/dc=example,dc=com/g' docs/examples/twake-mailbox-type-nomenclature.ldif > /tmp/nomenclature.ldif
ldapadd -x -D "cn=admin,dc=example,dc=com" -W -f /tmp/nomenclature.ldif
```

This creates three nomenclature entries:

- `cn=group,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=mailingList,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`

### LDAP-Rest Configuration

Add to your ldap-rest configuration:

```bash
# Optional: branches holding mailing lists, where team mailboxes are refused
--james-mailing-list-branches "ou=lists,dc=example,dc=com"

# Optional: Custom mailbox type attribute (default: twakeMailboxType)
--james-mailbox-type-attribute "mailboxType"
```

Or via environment variables:

```bash
DM_JAMES_MAILING_LIST_BRANCHES="ou=lists,dc=example,dc=com"
DM_JAMES_MAILBOX_TYPE_ATTRIBUTE="mailboxType"
```

If `james-mailing-list-branches` is empty (default), team mailboxes can be created anywhere.

## Mailing lists

`twake/james` creates nothing in James for a mailing list: a group with a
`mail` whose `twakeMailboxType` is `mailingList`, or is not set. Twake Mail
reads the list from LDAP when a mail reaches it, with its `LDAPMailingList`
mailet: a member change applies at once, and the list type held in
`businessCategory` (open, members only, owners only…) decides who may write
to it.

James address groups (`/address/groups`) are not used: they cannot restrict
senders, so anyone, external senders included, could write through one to a
members-only list.

## Usage

### Creating a Team Mailbox

```javascript
await dm.ldap.add('cn=sales-team,ou=groups,dc=example,dc=com', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'sales-team',
  mail: 'sales@example.com',
  twakeMailboxType:
    'cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  member: [
    'uid=alice,ou=users,dc=example,dc=com',
    'uid=bob,ou=users,dc=example,dc=com',
  ],
  twakeDepartmentLink: 'ou=groups,dc=example,dc=com',
  twakeDepartmentPath: 'Sales',
});
```

This will:

1. Create the team mailbox via `PUT /domains/example.com/team-mailboxes/sales`
2. Add each member via `PUT /domains/example.com/team-mailboxes/sales/members/{member-email}`

### Creating a Mailing List

```javascript
await dm.ldap.add('cn=announce,ou=lists,dc=example,dc=com', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'announce',
  mail: 'announce@example.com',
  twakeMailboxType:
    'cn=mailingList,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  member: [
    'uid=alice,ou=users,dc=example,dc=com',
    'uid=bob,ou=users,dc=example,dc=com',
  ],
  twakeDepartmentLink: 'ou=lists,dc=example,dc=com',
  twakeDepartmentPath: 'Lists',
});
```

Nothing is sent to James: Twake Mail reads the list from LDAP.

### Creating a Simple Group (no mailbox)

```javascript
await dm.ldap.add('cn=developers,ou=groups,dc=example,dc=com', {
  objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
  cn: 'developers',
  twakeMailboxType:
    'cn=group,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  member: ['uid=alice,ou=users,dc=example,dc=com'],
  twakeDepartmentLink: 'ou=groups,dc=example,dc=com',
  twakeDepartmentPath: 'Engineering',
});
```

This creates a simple group without any James integration (no mail attribute, no mailbox).

## Following the group

`twake/james` compares a team mailbox group before and after each write made
through LDAP-Rest, whatever made it: the groups API, its `/members` routes,
or any other write to the entry.

- A member added or removed is added to or removed from the mailbox.
- A group created as a team mailbox, or that becomes one, gets the mailbox
  created with all its members.
- A group that stops being one (another type, no `mail`, moved into a mailing
  list branch, or deleted) leaves its mailbox in James with no member. The
  mailbox is never deleted: it may hold mail.
- A new `mail` empties the mailbox of the old address and creates the one of
  the new address.

The writes to one group reach James one after the other. A deleted
user stays in the team mailboxes it belonged to: once its entry is gone, its
address cannot be read.

## API Endpoints Used

### Team Mailboxes

- **Create**: `PUT /domains/{domain}/team-mailboxes/{name}`
- **Add member**: `PUT /domains/{domain}/team-mailboxes/{name}/members/{memberEmail}`
- **Delete member**: `DELETE /domains/{domain}/team-mailboxes/{name}/members/{memberEmail}`

TMail names a team mailbox by the local part of its address, `{name}@{domain}`,
and accepts only letters, digits, `#`, `-` and `_` in it, up to 255 characters.
A group whose address has any other character, such as a dot, gets no team
mailbox: the plugin logs an error once, when the group comes to have such an
address, and does not call TMail. The name is lower-cased, so a change of case
of the address keeps the same team mailbox.

## Validation Rules

### Branch Restrictions

When `--james-mailing-list-branches` is configured, a team mailbox is not
created in James when the group is within one of these branches. It can be
created anywhere else in the LDAP tree.

**Example Configuration:**

```bash
--james-mailing-list-branches "ou=lists,dc=example,dc=com"
```

**Allowed:**

- `cn=sales-team,ou=teams,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ✅
- `cn=sales-team,ou=groups,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ✅

**Rejected:**

- `cn=sales-team,ou=lists,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ❌ (reserved for lists)

**Validation Points:** every write to the group. A team mailbox in these
branches gets no member either.

**Error Handling:**

- Validation failures are logged as errors
- Group is created in LDAP but the team mailbox is NOT created in James
- No exception thrown (silent failure with error log)

### Mailbox Type Defaults

3. **Mailbox Type**:
   - If `twakeMailboxType` is not set and the group has a `mail` attribute, it is a mailing list
   - If `twakeMailboxType` is not set and the group has no `mail` attribute, it's a simple group (no James integration)

## Mailbox Type Transitions

You can transition groups between different mailbox types by modifying the `twakeMailboxType` attribute. The system automatically handles the cleanup of the old type and setup of the new type.

### Supported Transitions

#### mailingList → teamMailbox

```javascript
await dm.ldap.modify('cn=sales,ou=groups,dc=example,dc=com', {
  replace: {
    twakeMailboxType:
      'cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  },
});
```

**What happens:**

1. Creates the team mailbox (`PUT /domains/{domain}/team-mailboxes/{name}`)
2. Adds all current members to the team mailbox

#### teamMailbox → mailingList

```javascript
await dm.ldap.modify('cn=sales,ou=groups,dc=example,dc=com', {
  replace: {
    twakeMailboxType:
      'cn=mailingList,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  },
});
```

**What happens:**

1. Removes all members from the team mailbox (`DELETE /domains/{domain}/team-mailboxes/{name}/members/{member}`)
2. **Preserves the team mailbox** (does NOT delete it - can be recovered later)

#### group → mailingList or teamMailbox

```javascript
// Add mail attribute and mailbox type
await dm.ldap.modify('cn=developers,ou=groups,dc=example,dc=com', {
  add: {
    mail: 'developers@example.com',
  },
  replace: {
    twakeMailboxType:
      'cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  },
});
```

**What happens:**

1. No cleanup needed (was a simple group)
2. For a team mailbox: creates it and adds all current members; nothing is sent to James for a mailing list

#### mailingList or teamMailbox → group

```javascript
await dm.ldap.modify('cn=sales,ou=groups,dc=example,dc=com', {
  replace: {
    twakeMailboxType:
      'cn=group,ou=twakeMailboxType,ou=nomenclature,dc=example,dc=com',
  },
});
```

**What happens:**

1. If team mailbox: removes all members (preserves mailbox)
2. Group becomes a simple group without mail functionality

### Deleting Groups with Team Mailboxes

When you delete a group that has `twakeMailboxType=teamMailbox`:

```javascript
await dm.ldap.delete('cn=sales,ou=groups,dc=example,dc=com');
```

**What happens:**

1. Removes all members from the team mailbox
2. **Preserves the team mailbox** (does NOT delete it)
3. The mailbox can be recovered later if needed

**Rationale:** Team mailboxes may contain important emails and should not be automatically deleted. Administrators can manually delete them through James WebAdmin if needed.

## Testing

Tests require the LDAP schema amendment to be applied first:

```bash
# Apply schema amendment to your test LDAP server
ldapmodify -Y EXTERNAL -H ldapi:/// -f docs/examples/twake-mailbox-type-schema-amendment.ldif

# Load nomenclature
sed 's/{ldap_base}/dc=example,dc=com/g' docs/examples/twake-mailbox-type-nomenclature.ldif | \
  ldapadd -x -D "cn=admin,dc=example,dc=com" -W

# Run the group tests
npm run test:one test/plugins/twake/jamesGroups.test.ts
```

### Test Coverage

**jamesGroups.test.ts** drives the groups API and records every call made to
James:

- Mailing lists, typed or not: no address group, from creation to deletion
- A group without mail: no call
- Team mailboxes: creation, the `/members` routes, a `replace` of the
  members, deletion, type changes, a new address, a mailing list branch

## References

- [TMail Team Mailboxes Documentation](https://github.com/linagora/tmail-backend/blob/master/docs/modules/ROOT/pages/tmail-backend/webadmin.adoc#team-mailboxes)
- [GitHub Issue #5](https://github.com/linagora/ldap-rest/issues/5)
