# Twake Calendar Plugin

Plugin to keep Twake Calendar in sync with LDAP via its WebAdmin API:

- resources (meeting rooms, equipment, etc.) stored in an LDAP branch
- registered users, whose email, first name and last name follow LDAP

> Formerly `core/twake/calendarResources`. That name still loads the plugin,
> registered as `calendarResources`, but logs a deprecation warning and will
> be removed in a future major release.

## Features

- **Automatic Creation**: When a resource is added to the configured LDAP branch, it's automatically created in Twake Calendar
- **Automatic Updates**: When a resource is modified in LDAP, changes are synced to Twake Calendar
- **Automatic Deletion**: When a resource is removed from LDAP, it's deleted from Twake Calendar
- **Flexible Configuration**: Configure which LDAP branch and objectClass to monitor
- **User Identity Propagation**: When a user's email, first name or last name changes in LDAP, the matching Calendar registered user is updated

## Configuration

### Environment Variables

- `DM_CALENDAR_WEBADMIN_URL`: URL of the Twake Calendar WebAdmin API (default: `http://localhost:8080`)
- `DM_CALENDAR_WEBADMIN_TOKEN`: Bearer token for WebAdmin API authentication
- `DM_CALENDAR_RESOURCE_BASE`: LDAP branch to monitor for resources, as a full DN (e.g., `ou=resources,dc=example,dc=com`). It is compared to an entry's DN part by part, so a partial value such as `ou=resources` names no branch and matches nothing (the plugin warns at startup when the value is not a DN of the directory).
- `DM_CALENDAR_RESOURCE_OBJECTCLASS`: Optional objectClass filter, applied when a resource is **created** (see [Resource identity](#resource-identity))
- `DM_CALENDAR_RESOURCE_CREATOR`: Default creator email for resources (default: `admin@example.com`)
- `DM_CALENDAR_RESOURCE_DOMAIN`: Default domain for resources (extracted from DN if not specified)
- `DM_CALENDAR_FIRSTNAME_ATTRIBUTE`: LDAP attribute holding a user's first name (default: `givenName`)
- `DM_CALENDAR_LASTNAME_ATTRIBUTE`: LDAP attribute holding a user's last name (default: `sn`)

The resource variables are only needed for resource synchronization; user
identity propagation only needs the WebAdmin URL and token.

### Required Dependencies

This plugin requires:

- `ldapFlat` plugin with a schema configured for calendar resources
- `onLdapChange` plugin to detect LDAP modifications

## LDAP Schema

The plugin works with any ldapFlat schema that has `entity.name` set to `calendarResource`. Example schema:

```json
{
  "entity": {
    "name": "calendarResource",
    "mainAttribute": "cn",
    "objectClass": ["top", "device"],
    "singularName": "resource",
    "pluralName": "resources",
    "base": "ou=resources,__ldap_base__"
  },
  "attributes": {
    "objectClass": {
      "type": "array",
      "default": ["top", "device"],
      "required": true,
      "fixed": true
    },
    "cn": {
      "type": "string",
      "required": true
    },
    "description": {
      "type": "string"
    }
  }
}
```

## Twake Calendar API

The plugin uses the following WebAdmin API endpoints:

- `POST /resources` - Create a new resource
- `PATCH /resources/{id}` - Update an existing resource
- `DELETE /resources/{id}` - Delete a resource
- `GET /registeredUsers?email={mail}` - Find the registered user to update
- `PATCH /registeredUsers?id={id}` - Update a registered user's email, first and last name
- `POST /users/{mail}?action=deleteData` - Delete a user's data (see `deleteUserData`)

The resource id goes into the path percent-encoded, so a `/` or a `#` in it
cannot build a path naming something else. The user's address is left as it is
written — `user@example.com`, `@` being legal in a path segment — which is what
`plugins/twake/james` does with the same WebAdmin; whether the two should
encode it is issue #175.

### Registered Users

A change of the configured mail attribute updates the registered user found by
its **previous** address; a change of the first or last name attribute updates
the one found by its current address. In both cases the email, first name and
last name are re-read from LDAP and sent together. Adding or removing the mail
attribute, and users not registered in Calendar, are skipped.

Calendar lower-cases the address before looking it up, which is also how it
stores addresses, so a case difference between LDAP and Calendar does not
matter. The exception is a legacy record whose stored address kept upper case
(written without Calendar's normalisation, e.g. migrated data): it is not
found, and its user is logged as not registered. Calendar releases before
1.0.0.1 ignore the `email` parameter and answer the full list of registered
users; the plugin then picks the user from it, which works but costs a full
listing per change.

### Resource identity

A resource is known to Calendar by an `id`, which is the value of its LDAP
entry's own RDN with the escapes removed: `cn=Meeting Room 1,ou=resources,…`
gives `Meeting Room 1`, and `o=Room 12,ou=resources,…` gives `Room 12`. The
creation, the update and the deletion hooks all read it that way, so the three
name the same resource; an entry whose DN yields no value is not synchronised.

Only entries in `DM_CALENDAR_RESOURCE_BASE` are synchronised, on all three
hooks. `DM_CALENDAR_RESOURCE_OBJECTCLASS` filters creations only: a
modification carries the attributes that changed, so an untouched objectClass
is not there to compare, and a deleted entry cannot be read any more. The
branch is the guard that remains on those two paths.

Renaming an entry changes its RDN, hence its id: Calendar is not told, and the
resource keeps its former id there.

### Resource Data Format

```json
{
  "id": "resource-id",
  "name": "Resource Name",
  "description": "Optional description",
  "creator": "admin@example.com",
  "domain": "example.com"
}
```

## Example Configuration

```bash
# Twake Calendar WebAdmin API
DM_CALENDAR_WEBADMIN_URL="https://calendar.example.com/webadmin"
DM_CALENDAR_WEBADMIN_TOKEN="your-api-token"

# LDAP Resources Configuration
DM_CALENDAR_RESOURCE_BASE="ou=resources,dc=example,dc=com"
DM_CALENDAR_RESOURCE_OBJECTCLASS="device"
DM_CALENDAR_RESOURCE_CREATOR="calendar-admin@example.com"
DM_CALENDAR_RESOURCE_DOMAIN="example.com"

# ldapFlat schema
DM_LDAP_FLAT_SCHEMA="/path/to/calendar-resources-schema.json"
```

## Usage

1. Configure the environment variables
2. Create an ldapFlat schema for calendar resources (see example above)
3. Add the plugin to `DM_PLUGINS`:

   ```bash
   DM_PLUGINS="core/ldap/onChange,core/ldap/flatGeneric,twake/calendar"
   ```

4. Start ldap-rest - resources will be automatically synced

## Logging

The plugin logs all API calls with the following information:

- Success/failure status
- HTTP status code
- Resource DN
- Resource name/ID

Example log:

```json
{
  "plugin": "calendar",
  "event": "ldapcalendarResourceadddone",
  "result": "success",
  "http_status": 201,
  "dn": "cn=Meeting Room 1,ou=resources,dc=example,dc=com",
  "resourceName": "Meeting Room 1"
}
```

## Troubleshooting

### Resources not syncing

1. Check that `DM_CALENDAR_WEBADMIN_URL` is correctly configured and accessible
2. Verify that `DM_CALENDAR_WEBADMIN_TOKEN` is valid
3. Check logs for API errors
4. Ensure the ldapFlat schema has `entity.name` set to `calendarResource`
5. Ensure `DM_CALENDAR_RESOURCE_BASE` is the full DN of the branch the entries are in: a partial value matches no entry, and the plugin says so at startup

### Authentication errors

Ensure `DM_CALENDAR_WEBADMIN_TOKEN` is set and valid. The token is sent as a Bearer token in the Authorization header.

### Wrong resources being synced

Use `DM_CALENDAR_RESOURCE_BASE` and `DM_CALENDAR_RESOURCE_OBJECTCLASS` to filter which LDAP entries are considered resources. Note that the objectClass filter only applies to creations, so an entry of the resource entity that must never reach Calendar has to sit outside the branch.

## Public Methods

Public methods available on the Calendar plugin instance.

### Usage

```typescript
import type { DM } from 'ldap-rest';
import type Calendar from 'ldap-rest/plugin-twake-calendar';

// Get the plugin instance from another plugin
// (declare `dependencies = { calendar: 'core/twake/calendar' }` so it loads first)
const calendar = this.requirePlugin<Calendar>('calendar');
```

### deleteUserData(mail)

Delete all user data from Twake Calendar via WebAdmin API. Useful for GDPR "right to be forgotten" compliance.

**Signature:**

```typescript
async deleteUserData(mail: string): Promise<{ taskId: string } | null>
```

**Parameters:**

- `mail` (string): User's email address

**Returns:** Task information with `taskId`, or `null` on error.

**Example:**

```typescript
// requirePlugin() returns null when the plugin is not loaded
const result = await calendar?.deleteUserData('user@example.com');
if (result) {
  console.log(`Deletion task started: ${result.taskId}`);
}
```

**Reference:** [Twake Calendar deleteData API](https://github.com/linagora/twake-calendar-side-service/blob/main/docs/apis/webadmin.md#deleting-user-data)
