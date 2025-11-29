# Integration Plugins

Plugins for connecting LDAP-Rest to external systems.

## Apache James

| Plugin | Description |
|--------|-------------|
| [james-mail](james-mail.md) | User and domain synchronization |
| [james-mailboxes](james-mailboxes.md) | Team mailbox management |

## Twake

| Plugin | Description |
|--------|-------------|
| [calendar-resources](calendar-resources.md) | Calendar resource synchronization |
| [app-accounts](app-accounts.md) | Applicative accounts API (devices, apps) |

## Prerequisites

### Apache James

James plugins require:
- Apache James running
- WebAdmin URL configuration
- James authentication token

```bash
--james-webadmin-url "http://localhost:8000"
--james-token "your-james-token"
```

### Dependencies

```
core/twake/james
  └─ requires: core/ldap/onChange

core/twake/calendarResources
  └─ requires: core/ldap/onChange
```
