# LDAP Trash Plugin

Plugin to intercept LDAP delete operations and move entries to a trash branch instead of permanently deleting them.

## Features

- **Soft Delete**: Moves entries to trash instead of permanent deletion
- **Configurable Branches**: Watch specific LDAP branches or all branches
- **Metadata Tracking**: Automatically adds deletion timestamp and original DN
- **Auto-create Trash**: Creates trash branch automatically if it doesn't exist
- **Atomic Move**: Uses LDAP modifyDN for safe, atomic operations
- **Overwrite Protection**: Automatically removes old trash entries when moving new ones

## Configuration

### Environment Variables

- `DM_TRASH_BASE`: LDAP base DN for trash (default: `ou=trash,dc=example,dc=com`)
- `DM_TRASH_WATCHED_BASES`: Comma-separated list of branches to watch (default: all branches except trash)
- `DM_TRASH_ADD_METADATA`: Add metadata to trashed entries (default: `true`)
- `DM_TRASH_AUTO_CREATE`: Auto-create trash branch if missing (default: `true`)

### Command Line

```bash
--plugin core/ldap/trash \
--trash-base "ou=trash,dc=example,dc=com" \
--trash-watched-bases "ou=users,dc=example,dc=com,ou=groups,dc=example,dc=com" \
--trash-add-metadata true \
--trash-auto-create true
```

## How It Works

When a delete operation occurs:

1. **Check if DN is watched**: Plugin checks if the DN is in a configured watched branch
2. **Ensure trash exists**: Creates trash branch if needed (when `auto-create` is enabled)
3. **Remove old trash entry**: If an entry with the same RDN exists in trash, it's deleted first
4. **Atomic move**: Uses LDAP `modifyDN` to move the entry to trash
5. **Add metadata**: Adds deletion timestamp and original DN as `description` attribute
6. **Cancel native delete**: The original delete operation is cancelled

### DN Transformation

Original DN is transformed to trash DN by replacing the parent branch:

```
Before: uid=john,ou=users,dc=example,dc=com
After:  uid=john,ou=trash,dc=example,dc=com
```

## Usage Examples

### Watch All Branches (Default)

```bash
mini-dm \
  --plugin core/ldap/trash \
  --trash-base "ou=trash,dc=example,dc=com"
```

This watches all LDAP branches except the trash branch itself.

### Watch Specific Branches Only

```bash
mini-dm \
  --plugin core/ldap/trash \
  --trash-base "ou=trash,dc=example,dc=com" \
  --trash-watched-bases "ou=users,dc=example,dc=com,ou=groups,dc=example,dc=com"
```

This only intercepts deletes from `ou=users` and `ou=groups`. Deletes from other branches proceed normally.

### Disable Metadata

```bash
mini-dm \
  --plugin core/ldap/trash \
  --trash-base "ou=trash,dc=example,dc=com" \
  --trash-add-metadata false
```

Entries are moved to trash without adding deletion metadata.

### Manual Trash Branch

If you want to create the trash branch manually:

```bash
# Create trash branch manually
ldapadd -x -D "cn=admin,dc=example,dc=com" -W <<EOF
dn: ou=trash,dc=example,dc=com
objectClass: top
objectClass: organizationalUnit
ou: trash
description: LDAP Trash - Deleted entries are moved here
EOF

# Configure plugin to not auto-create
mini-dm \
  --plugin core/ldap/trash \
  --trash-base "ou=trash,dc=example,dc=com" \
  --trash-auto-create false
```

## Metadata Format

When `trash-add-metadata` is enabled, the plugin adds a `description` attribute to trashed entries:

```
description: Deleted on 2025-10-15T10:30:45.123Z from uid=john,ou=users,dc=example,dc=com
```

This helps track:
- When the entry was deleted
- Where it originally existed

## Recovering from Trash

To restore an entry from trash, manually move it back using LDAP tools:

```bash
# List entries in trash
ldapsearch -x -b "ou=trash,dc=example,dc=com" "(objectClass=*)"

# Restore user (move back)
ldapmodrdn -x -D "cn=admin,dc=example,dc=com" -W \
  "uid=john,ou=trash,dc=example,dc=com" \
  "uid=john" \
  -s "ou=users,dc=example,dc=com"
```

Or use a script:

```javascript
// Restore from trash
await dm.ldap.move(
  'uid=john,ou=trash,dc=example,dc=com',
  'uid=john,ou=users,dc=example,dc=com'
);

// Clean up metadata (optional)
await dm.ldap.modify('uid=john,ou=users,dc=example,dc=com', {
  delete: { description: [] }
});
```

## Emptying Trash

To permanently delete entries from trash:

```bash
# Delete specific entry from trash
ldapdelete -x -D "cn=admin,dc=example,dc=com" -W \
  "uid=john,ou=trash,dc=example,dc=com"

# Empty entire trash (careful!)
ldapsearch -x -b "ou=trash,dc=example,dc=com" -LLL dn | \
  grep '^dn:' | cut -d' ' -f2 | \
  while read dn; do
    if [ "$dn" != "ou=trash,dc=example,dc=com" ]; then
      ldapdelete -x -D "cn=admin,dc=example,dc=com" -W "$dn"
    fi
  done
```

Note: Deleting from trash itself is NOT intercepted by the plugin (prevents infinite loops).

## LDAP Permissions

The plugin requires `modifyDN` permission to move entries. Ensure your LDAP bind DN has sufficient permissions:

```ldif
# Example ACL for OpenLDAP
olcAccess: to dn.subtree="dc=example,dc=com"
  by dn="cn=admin,dc=example,dc=com" write
  by * read
```

If you get permission errors, check your LDAP ACLs and ensure the bind DN can:
- Read entries from watched branches
- Move entries to trash branch (modifyDN)
- Modify entries in trash (to add metadata)

## Hooks

This plugin uses the `ldapdeleterequest` hook to intercept delete operations before they occur.

## Limitations

- Only works with flat entries (RDN is preserved, parent DN is changed)
- Entries with the same RDN will overwrite previous trash entries
- Tree structures (entries with children) must be deleted leaf-first
- Does not track history (only keeps the latest deleted version)

## Troubleshooting

### Trash not being created

1. Check `auto-create` is enabled (default)
2. Verify bind DN has permission to create `ou=trash`
3. Check logs for error messages

### Entries not moving to trash

1. Check if DN matches `watched-bases` configuration
2. Verify bind DN has `modifyDN` permission
3. Check that trash branch exists
4. Review logs for specific error messages

### Permission errors

```
Error: Trash plugin: Insufficient LDAP permissions to move uid=john,ou=users,dc=example,dc=com to trash
```

Solution: Grant `modifyDN` permission to the bind DN in LDAP ACLs.

### Overwrite warnings

If you see messages about removing old trash entries, this is normal behavior. The plugin ensures only one version of each entry exists in trash.

## Best Practices

1. **Regular cleanup**: Schedule periodic trash cleanup to prevent unlimited growth
2. **Backup first**: Always backup LDAP before emptying trash
3. **Monitor trash size**: Track the number of entries in trash
4. **Document recovery**: Document the recovery process for your team
5. **Test permissions**: Verify LDAP permissions before deploying to production
6. **Watch selectively**: Only watch branches that need trash protection

## Example Configuration

Full production setup:

```bash
mini-dm \
  --plugin core/auth/token \
  --plugin core/ldap/trash \
  --plugin core/ldap/flatGeneric \
  --plugin core/ldap/groups \
  --ldap-url "ldap://localhost:389" \
  --ldap-dn "cn=admin,dc=example,dc=com" \
  --ldap-pwd "admin" \
  --ldap-base "dc=example,dc=com" \
  --trash-base "ou=trash,dc=example,dc=com" \
  --trash-watched-bases "ou=users,dc=example,dc=com,ou=groups,dc=example,dc=com" \
  --trash-add-metadata true \
  --auth-token "secret-token"
```

## License

[![Powered by LINAGORA](./linagora.png)](https://linagora.com)

License: [AGPL-3.0](../LICENSE), copyright 2025-present LINAGORA.
