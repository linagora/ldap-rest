# Twake Calendar Resources Plugin

Plugin to automatically synchronize LDAP resources (meeting rooms, equipment, etc.) with Twake Calendar via its WebAdmin API.

## Features

- **Automatic Creation**: When a resource is added to the configured LDAP branch, it's automatically created in Twake Calendar
- **Automatic Updates**: When a resource is modified in LDAP, changes are synced to Twake Calendar
- **Automatic Deletion**: When a resource is removed from LDAP, it's deleted from Twake Calendar
- **Flexible Configuration**: Configure which LDAP branch and objectClass to monitor

## Configuration

### Environment Variables

- `DM_CALENDAR_WEBADMIN_URL`: URL of the Twake Calendar WebAdmin API (default: `http://localhost:8080`)
- `DM_CALENDAR_WEBADMIN_TOKEN`: Bearer token for WebAdmin API authentication
- `DM_CALENDAR_RESOURCE_BASE`: LDAP branch to monitor for resources (e.g., `ou=resources,dc=example,dc=com`)
- `DM_CALENDAR_RESOURCE_OBJECTCLASS`: Optional objectClass filter (only process entries with this objectClass)
- `DM_CALENDAR_RESOURCE_CREATOR`: Default creator email for resources (default: `admin@example.com`)
- `DM_CALENDAR_RESOURCE_DOMAIN`: Default domain for resources (extracted from DN if not specified)

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
   DM_PLUGINS="core/ldap/onChange,core/ldap/flatGeneric,twake/calendarResources"
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
  "plugin": "calendarResources",
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

### Authentication errors

Ensure `DM_CALENDAR_WEBADMIN_TOKEN` is set and valid. The token is sent as a Bearer token in the Authorization header.

### Wrong resources being synced

Use `DM_CALENDAR_RESOURCE_BASE` and `DM_CALENDAR_RESOURCE_OBJECTCLASS` to filter which LDAP entries are considered resources.

## Public Methods

Public methods available on the CalendarResources plugin instance.

### Usage

```typescript
import type { DM } from 'ldap-rest';
import type CalendarResources from 'ldap-rest/plugin-twake-calendarresources';

// Get the plugin instance from another plugin
const calendar = this.server.getPlugin(
  'calendarResources'
) as CalendarResources;
```

### deleteUserData(username)

Delete all user data from Twake Calendar via WebAdmin API. Useful for GDPR "right to be forgotten" compliance.

**Signature:**

```typescript
async deleteUserData(username: string): Promise<{ taskId: string } | null>
```

**Parameters:**

- `username` (string): Username to delete data for

**Returns:** Task information with `taskId`, or `null` on error.

**Example:**

```typescript
const result = await calendar.deleteUserData('jdoe');
if (result) {
  console.log(`Deletion task started: ${result.taskId}`);
}
```

**Reference:** [Twake Calendar deleteData API](https://github.com/linagora/twake-calendar-side-service/blob/main/docs/apis/webadmin.md#deleting-user-data)
