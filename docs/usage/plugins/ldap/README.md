# LDAP Plugins

Plugins for LDAP entity management.

## Overview

| Plugin | Entity | Features |
|--------|--------|----------|
| [flat-generic](flat-generic.md) | Users, Positions, Custom | Schema-driven, Validation, Pointers |
| [groups](groups.md) | Groups | Member validation, Nested groups |
| [organizations](organizations.md) | Organizational Units | Tree navigation, Search |
| [bulk-import](bulk-import.md) | All (bulk operations) | CSV import, Template generation |
| [trash](trash.md) | All (soft delete) | Trash system, Recovery |
| [external-users](external-users.md) | Contacts | Automatic creation |
| [on-change](on-change.md) | All | Change detection |

## API Endpoints

### Entity Management (ldapFlatGeneric)

```
GET    /api/v1/ldap/{pluralName}           # List entries
GET    /api/v1/ldap/{pluralName}/{id}      # Get entry
POST   /api/v1/ldap/{pluralName}           # Create entry
PUT    /api/v1/ldap/{pluralName}/{id}      # Modify entry
DELETE /api/v1/ldap/{pluralName}/{id}      # Delete entry
```

### Groups (ldapGroups)

```
GET    /api/v1/ldap/groups                 # List groups
GET    /api/v1/ldap/groups/{cn}            # Get group
POST   /api/v1/ldap/groups                 # Create group
PUT    /api/v1/ldap/groups/{cn}            # Modify group
POST   /api/v1/ldap/groups/{cn}/rename     # Rename group
POST   /api/v1/ldap/groups/{cn}/move       # Move group
DELETE /api/v1/ldap/groups/{cn}            # Delete group
```

### Organizations (ldapOrganizations)

```
GET    /api/v1/ldap/organizations/top                    # Root organization
GET    /api/v1/ldap/organizations/{dn}/subnodes         # Sub-organizations
GET    /api/v1/ldap/organizations/{dn}/subnodes/search  # Search
POST   /api/v1/ldap/organizations                       # Create
PUT    /api/v1/ldap/organizations/{dn}                  # Modify
POST   /api/v1/ldap/organizations/{dn}/move             # Move
DELETE /api/v1/ldap/organizations/{dn}                  # Delete
```

### Bulk Import (ldapBulkImport)

```
GET    /api/v1/ldap/bulk-import/{resource}/template.csv  # CSV template
POST   /api/v1/ldap/bulk-import/{resource}               # Import from CSV
```

## Schemas

JSON schemas define the structure of LDAP entities.

### Standard Schemas

- `./static/schemas/standard/users.json` - inetOrgPerson users
- `./static/schemas/standard/groups.json` - groupOfNames groups
- `./static/schemas/standard/organizations.json` - Organizational units

### Twake Schemas

- `./static/schemas/twake/users.json` - Twake users
- `./static/schemas/twake/groups.json` - Twake groups
- `./static/schemas/twake/positions.json` - Positions/roles

### Active Directory Schemas

- `./static/schemas/ad/users.json` - AD accounts
- `./static/schemas/ad/groups.json` - AD security groups
