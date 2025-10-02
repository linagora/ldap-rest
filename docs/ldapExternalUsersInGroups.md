# LDAP External Users in Groups Plugin

The `externalUsersInGroups` plugin automatically creates external user entries on-the-fly when they are added to groups. This is particularly useful for mailing lists that include external contacts.

## Overview

This plugin intercepts group member validation and automatically creates missing user entries in a dedicated external branch. This allows you to:

- Add external email addresses to groups/mailing lists without pre-creating users
- Keep external contacts separate from internal users
- Prevent creation of external users with managed domains
- Automatically manage external user lifecycle

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/externalUsersInGroups \
--external-members-branch "ou=contacts,dc=example,dc=com" \
--external-branch-class top,inetOrgPerson \
--mail-domain example.com,company.org
```

### Configuration Options

| Argument                                                | Environment Variable         | Default                         | Description                                              |
| ------------------------------------------------------- | ---------------------------- | ------------------------------- | -------------------------------------------------------- |
| `--external-members-branch`                             | `DM_EXTERNAL_MEMBERS_BRANCH` | `ou=contacts,dc=example,dc=com` | Branch for external user entries                         |
| `--external-branch-class` / `--external-branch-classes` | `DM_EXTERNAL_BRANCH_CLASSES` | `["top", "inetOrgPerson"]`      | Object classes for external users                        |
| `--mail-domain` / `--mail-domains`                      | `DM_MAIL_DOMAIN`             | `[]`                            | Managed mail domains (cannot be used for external users) |

### Important Notes

- **Dependencies**: This plugin requires the `core/ldap/groups` plugin
- **DN Format**: External members are in the format `mail={email},{external_members_branch}`
- **Domain Protection**: External users cannot be created if their mail are in managed domains (configured via `--mail-domain`)
- **Automatic Creation**: Users are created automatically when added to a group if they don't exist

## How It Works

### Member Validation Hook

The plugin hooks into the `ldapgroupvalidatemembers` event:

1. **Check DN Format**: Validates member DN matches `mail={email},{external_members_branch}`
2. **Search Existing**: Checks if the user already exists in LDAP
3. **Domain Validation**: Ensures email domain is not in managed domains list
4. **Auto-Create**: If user doesn't exist, creates it with minimal attributes
5. **Custom Hooks**: Allows modification via `externaluserentry` and `externaluseradded` hooks

### Created Entry Structure

When an external user is created, the following attributes are set:

```javascript
{
  objectClass: ["top", "inetOrgPerson"],  // From config
  mail: "external@example.org",
  cn: "external@example.org",             // Using ldap_groups_main_attribute
  sn: "external@example.org"
}
```

## Usage Examples

### Example 1: Add External User to Mailing List

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups \
  -H "Content-Type: application/json" \
  -d '{
    "cn": "newsletter",
    "description": "Company Newsletter",
    "member": [
      "uid=john.doe,ou=users,dc=example,dc=com",
      "mail=external@partner.com,ou=contacts,dc=example,dc=com"
    ]
  }'
```

**What happens:**

1. Group "newsletter" is created
2. Internal user `john.doe` is validated (must exist)
3. External user `external@partner.com` is checked:
   - Not found in LDAP
   - Domain `partner.com` is not in managed domains
   - User entry is automatically created in `ou=contacts,dc=example,dc=com`
4. Both members are added to the group

### Example 2: Add Multiple External Members

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups/newsletter/members \
  -H "Content-Type: application/json" \
  -d '{
    "member": [
      "mail=contact1@external.org,ou=contacts,dc=example,dc=com",
      "mail=contact2@external.org,ou=contacts,dc=example,dc=com"
    ]
  }'
```

Both external users will be created automatically if they don't exist.

### Example 3: Domain Protection

```bash
# Assuming --mail-domain example.com,company.org

curl -X POST http://localhost:8081/api/v1/ldap/groups/newsletter/members \
  -H "Content-Type: application/json" \
  -d '{
    "member": "mail=someone@example.com,ou=contacts,dc=example,dc=com"
  }'
```

**Result:** Error - `Cannot create external user with managed domain: someone@example.com`

This prevents accidentally creating external entries for internal users.

## Hooks

The plugin emits custom hooks for integration:

### externaluserentry

Called before creating an external user entry. Allows modification of DN and attributes.

```javascript
hooks: {
  externaluserentry: async ([dn, entry]) => {
    // Add custom attributes
    entry.displayName = entry.mail;
    entry.description = 'External contact';

    // Modify DN if needed
    const newDn = dn; // or modify

    return [newDn, entry];
  };
}
```

### externaluseradded

Called after an external user is successfully created.

```javascript
hooks: {
  externaluseradded: async (dn, entry) => {
    console.log('External user created:', dn);
    console.log('Attributes:', entry);

    // Send notification, update external system, etc.
  };
}
```

## Integration with Groups Plugin

The plugin works seamlessly with the groups plugin:

### Normal Group Operations

```bash
# Create group with mix of internal and external users
POST /api/v1/ldap/groups
{
  "cn": "project-team",
  "member": [
    "uid=internal1,ou=users,dc=example,dc=com",
    "mail=external@partner.com,ou=contacts,dc=example,dc=com"
  ]
}

# Add external member to existing group
POST /api/v1/ldap/groups/project-team/members
{
  "member": "mail=another@partner.com,ou=contacts,dc=example,dc=com"
}
```

### Member Cleanup

When an external user is deleted, the groups plugin automatically removes them from all groups (via the `ldapdeleterequest` hook).

## Advanced Configuration

### Custom Object Classes

Use different object classes for external users:

```bash
--external-branch-class top,person,organizationalPerson,inetOrgPerson
```

### Multiple Managed Domains

Protect multiple domains from external user creation:

```bash
--mail-domain example.com,company.org,subsidiary.net
```

### Custom Attributes via Hooks

Add organization-specific attributes to external users:

```javascript
// In your plugin configuration
hooks: {
  externaluserentry: async ([dn, entry]) => {
    entry.o = 'External Partners';
    entry.userType = 'external';
    entry.employeeType = 'contact';
    return [dn, entry];
  };
}
```

## Troubleshooting

### External User Not Created

**Problem:** Member addition fails but external user is not created

**Solutions:**

1. Verify DN format: `mail={email},{external_members_branch}`
2. Check external branch exists in LDAP
3. Ensure plugin is registered after groups plugin
4. Check LDAP permissions for creating entries in external branch

### Managed Domain Error

**Problem:** `Cannot create external user with managed domain: user@example.com`

**Solutions:**

1. Use the correct branch for internal users: `ou=users,dc=example,dc=com`
2. Remove domain from `--mail-domain` if it should allow external users
3. This is expected behavior for internal domains - create user in users branch instead

### Malformed Member DN

**Problem:** `Malformed member mail=user,ou=contacts,dc=example,dc=com`

**Solution:** Use correct format with email address:

```
mail=user@domain.com,ou=contacts,dc=example,dc=com
```

### Missing Attributes

**Problem:** External users are created but lack required attributes

**Solution:** Use `externaluserentry` hook to add custom attributes:

```javascript
hooks: {
  externaluserentry: async ([dn, entry]) => {
    // Extract name from email
    const [localPart] = entry.mail.split('@');
    entry.givenName = localPart;
    entry.displayName = localPart;

    return [dn, entry];
  };
}
```

## Use Cases

### Mailing Lists

Create mailing lists that mix internal employees and external partners:

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups \
  -d '{
    "cn": "partners-list",
    "description": "Partner Communications",
    "member": [
      "uid=employee1,ou=users,dc=example,dc=com",
      "mail=partner1@acme.com,ou=contacts,dc=example,dc=com",
      "mail=partner2@vendor.org,ou=contacts,dc=example,dc=com"
    ]
  }'
```

### Project Collaboration

Add external consultants to project groups:

```bash
curl -X POST http://localhost:8081/api/v1/ldap/groups/project-alpha/members \
  -d '{
    "member": [
      "mail=consultant@consulting.com,ou=contacts,dc=example,dc=com"
    ]
  }'
```

### Newsletter Management

Manage newsletter subscriptions with automatic contact creation:

```bash
# Add new subscriber (auto-creates contact)
curl -X POST http://localhost:8081/api/v1/ldap/groups/newsletter/members \
  -d '{"member": "mail=subscriber@gmail.com,ou=contacts,dc=example,dc=com"}'

# Unsubscribe (removes from group)
curl -X DELETE \
  "http://localhost:8081/api/v1/ldap/groups/newsletter/members/mail%3Dsubscriber%40gmail.com%2Cou%3Dcontacts%2Cdc%3Dexample%2Cdc%3Dcom"
```

## See Also

- [LDAP Groups Plugin](./ldapGroups.md) - Core groups management (required dependency)
- [LDAP Flat Plugin](./ldapFlat.md) - For managing internal users
- [Schema Examples](../static/schemas/) - Schema examples for groups and users
