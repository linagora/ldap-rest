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
# Replace {ldap_base} with your actual LDAP base (e.g., dc=example,dc=com)
sed 's/{ldap_base}/dc=example,dc=com/g' docs/examples/twake-mailbox-type-nomenclature.ldif > /tmp/nomenclature.ldif
ldapadd -x -D "cn=admin,dc=example,dc=com" -W -f /tmp/nomenclature.ldif
```

This creates three nomenclature entries:

- `cn=group,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=mailingList,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`
- `cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,{ldap_base}`

### Mini-DM Configuration

Add to your mini-dm configuration:

```bash
# Optional: Restrict mailing lists to specific branches
--james-mailing-list-branches "ou=lists,dc=example,dc=com"
```

Or via environment variable:

```bash
DM_JAMES_MAILING_LIST_BRANCHES="ou=lists,dc=example,dc=com"
```

If empty (default), mailing lists can be created anywhere.

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

1. Create the team mailbox via `PUT /domains/example.com/team-mailboxes/sales@example.com`
2. Add each member via `PUT /domains/example.com/team-mailboxes/sales@example.com/members/{member-email}`

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

This will:

1. Validate the group is in an allowed branch (if `--james-mailing-list-branches` is configured)
2. Create the mailing list via `PUT /address/groups/announce@example.com/{member-email}` for each member

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

### Branch Restrictions

When `--james-mailing-list-branches` is configured, strict branch separation is enforced:

1. **Mailing Lists**:
   - ✅ **MUST** be located within one of the specified branches
   - ❌ **CANNOT** be created outside these branches
   - If `--james-mailing-list-branches` is empty, no location restriction applies

2. **Team Mailboxes**:
   - ✅ **MUST NOT** be located within mailing list branches
   - ❌ **CANNOT** be created in branches reserved for mailing lists
   - ✅ **CAN** be created anywhere else in the LDAP tree

**Example Configuration:**

```bash
--james-mailing-list-branches "ou=lists,dc=example,dc=com"
```

**Allowed:**

- `cn=sales-list,ou=lists,dc=example,dc=com` with `twakeMailboxType=mailingList` ✅
- `cn=sales-team,ou=teams,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ✅
- `cn=sales-team,ou=groups,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ✅

**Rejected:**

- `cn=sales-list,ou=teams,dc=example,dc=com` with `twakeMailboxType=mailingList` ❌ (wrong branch)
- `cn=sales-team,ou=lists,dc=example,dc=com` with `twakeMailboxType=teamMailbox` ❌ (reserved for lists)

**Validation Points:**

- Group creation (`ldapgroupadddone`)
- Mailbox type transitions (`handleMailboxTypeTransition`)

**Error Handling:**

- Validation failures are logged as errors
- Group is created in LDAP but James mailbox is NOT created
- No exception thrown (silent failure with error log)

### Mailbox Type Defaults

3. **Mailbox Type**:
   - If `twakeMailboxType` is not set and the group has a `mail` attribute, it defaults to `mailingList`
   - If `twakeMailboxType` is not set and the group has no `mail` attribute, it's a simple group (no James integration)
   - Default behavior is subject to branch validation rules

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

1. Deletes the mailing list from James (`DELETE /address/groups/{mail}`)
2. Creates the team mailbox (`PUT /domains/{domain}/team-mailboxes/{mail}`)
3. Adds all current members to the team mailbox

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

1. Removes all members from the team mailbox (`DELETE /domains/{domain}/team-mailboxes/{mail}/members/{member}`)
2. **Preserves the team mailbox** (does NOT delete it - can be recovered later)
3. Creates the mailing list (`PUT /address/groups/{mail}/{member}`)
4. Adds all current members to the mailing list

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
2. Creates the specified mailbox type (mailing list or team mailbox)
3. Adds all current members

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

1. If mailing list: deletes it from James
2. If team mailbox: removes all members (preserves mailbox)
3. Group becomes a simple group without mail functionality

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

## Backward Compatibility

Existing groups with `mail` attribute but no `twakeMailboxType` will continue to work as mailing lists (backward compatible behavior).

## Testing

Tests require the LDAP schema amendment to be applied first:

```bash
# Apply schema amendment to your test LDAP server
ldapmodify -Y EXTERNAL -H ldapi:/// -f docs/examples/twake-mailbox-type-schema-amendment.ldif

# Load nomenclature
sed 's/{ldap_base}/dc=example,dc=com/g' docs/examples/twake-mailbox-type-nomenclature.ldif | \
  ldapadd -x -D "cn=admin,dc=example,dc=com" -W

# Run team mailbox tests
npm run test:one test/plugins/twake/jamesTeamMailboxes.test.ts

# Run mailbox type transition tests
npm run test:one test/plugins/twake/jamesMailboxTypeTransitions.test.ts
```

### Test Coverage

- **jamesTeamMailboxes.test.ts** (4 tests):
  - Create team mailbox
  - Add member to team mailbox
  - Remove member from team mailbox
  - Delete team mailbox group (removes members, preserves mailbox)

- **jamesMailboxTypeTransitions.test.ts** (7 tests):
  - Transition from mailingList to teamMailbox
  - Transition from teamMailbox to mailingList
  - Transition from group to teamMailbox
  - Transition from teamMailbox to group
  - Transition from group to mailingList
  - Transition from mailingList to group
  - Delete group with teamMailbox (removes members only)

- **jamesBranchValidation.test.ts** (6 tests):
  - Allow mailing list in allowed branch
  - Reject mailing list outside allowed branch
  - Allow team mailbox outside mailing list branch
  - Reject team mailbox inside mailing list branch
  - Reject transition to mailing list outside allowed branch
  - Reject transition to team mailbox inside mailing list branch

## References

- [TMail Team Mailboxes Documentation](https://github.com/linagora/tmail-backend/blob/master/docs/modules/ROOT/pages/tmail-backend/webadmin.adoc#team-mailboxes)
- [GitHub Issue #5](https://github.com/linagora/mini-dm/issues/5)
