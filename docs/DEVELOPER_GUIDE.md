# Developer Guide - Mini-DM

Welcome to the Mini-DM Developer Guide! This guide helps you build web applications using Mini-DM's APIs and libraries.

## Quick Links

### 🚀 Getting Started

- [Introduction & Architecture](#introduction)
- [Quick Start Guide](#quick-start)

### 📚 Core Documentation

- **[REST API Documentation](./api/REST_API.md)** - Complete API reference (Config, Users, Groups, Organizations)
- **[Browser Libraries](./browser/LIBRARIES.md)** - LdapTreeViewer and LdapUserEditor
- **[JSON Schemas](./schemas/SCHEMAS.md)** - Schema structure and validation
- **[Integration Examples](./examples/EXAMPLES.md)** - React, Vue.js, Vanilla JavaScript examples
- **[Plugin Development](./plugins/DEVELOPMENT.md)** - Create your own plugins

### 🔧 Reference

- **[API Reference](./api/REFERENCE.md)** - Complete API reference with all endpoints
- [Authentication](./api/REST_API.md#authentication) - OpenID, Token, LemonLDAP::NG
- [Troubleshooting](./api/REFERENCE.md#troubleshooting) - Common issues and solutions

---

## Introduction

Mini-DM is a lightweight LDAP directory manager that provides:

- **Complete REST API** for managing LDAP users, groups, and organizations
- **Ready-to-use browser libraries** in JavaScript/TypeScript
- **Schema-driven architecture** to adapt to different directory types (Twake, Active Directory, standard LDAP)
- **Dynamic configuration** exposed via API
- **Plugin-based extensibility** for custom functionality

### Architecture Overview

```
┌─────────────────────────────────────┐
│   Your Web Application              │
│                                     │
│  ┌───────────────────────────────┐ │
│  │  Browser Libraries            │ │
│  │  - LdapTreeViewer             │ │
│  │  - LdapUserEditor             │ │
│  └───────────────────────────────┘ │
│              ↓ HTTP                 │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│   Mini-DM Server                    │
│                                     │
│  ┌───────────────────────────────┐ │
│  │  REST API                     │ │
│  │  - /api/v1/config             │ │
│  │  - /api/v1/ldap/users         │ │
│  │  - /api/v1/ldap/groups        │ │
│  │  - /api/v1/ldap/organizations │ │
│  └───────────────────────────────┘ │
│              ↓                      │
│  ┌───────────────────────────────┐ │
│  │  Plugins                      │ │
│  │  - configApi                  │ │
│  │  - ldapFlatGeneric            │ │
│  │  - ldapGroups                 │ │
│  │  - ldapOrganizations          │ │
│  └───────────────────────────────┘ │
│              ↓                      │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│   LDAP Directory Server             │
│   (OpenLDAP, AD, 389 Directory...)  │
└─────────────────────────────────────┘
```

---

## Quick Start

### 1. Start Mini-DM Server

```bash
npx mini-dm \
  --ldap-base 'dc=example,dc=com' \
  --ldap-url 'ldap://localhost:389' \
  --ldap-dn 'cn=admin,dc=example,dc=com' \
  --ldap-pwd 'admin' \
  --plugin core/configApi \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./static/schemas/standard/users.json \
  --plugin core/static \
  --static-path ./static
```

### 2. Access the Configuration API

```javascript
const config = await fetch('http://localhost:8081/api/v1/config')
  .then(r => r.json());

console.log(config);
// {
//   "apiPrefix": "/api",
//   "ldapBase": "dc=example,dc=com",
//   "features": { ... }
// }
```

### 3. Use the Browser Libraries

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/static/browser/ldap-user-editor.css" />
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet" />
</head>
<body>
  <div id="editor"></div>

  <script src="/static/browser/ldap-user-editor.js"></script>
  <script>
    const { LdapUserEditor } = window.LdapUserEditor;

    const editor = new LdapUserEditor({
      containerId: 'editor',
      apiBaseUrl: window.location.origin,
      onUserSaved: (dn) => console.log('Saved:', dn),
    });

    editor.init();
  </script>
</body>
</html>
```

---

## Documentation Structure

### API Documentation

- **[REST API Guide](./api/REST_API.md)**
  - Configuration API
  - Organizations API
  - Users API
  - Groups API
  - Authentication

- **[Complete API Reference](./api/REFERENCE.md)**
  - All endpoints with examples
  - Request/response formats
  - Error codes
  - LDAP modify format

### Browser Libraries

- **[Browser Libraries Guide](./browser/LIBRARIES.md)**
  - LdapTreeViewer - Interactive LDAP tree
  - LdapUserEditor - Complete user editor
  - Configuration options
  - API methods
  - Customization

### Schemas

- **[JSON Schemas Guide](./schemas/SCHEMAS.md)**
  - Schema structure
  - Entity metadata
  - Attribute types
  - Semantic roles
  - Validation rules
  - Predefined schemas

### Integration

- **[Integration Examples](./examples/EXAMPLES.md)**
  - React application
  - Vue.js application
  - Vanilla JavaScript
  - Group management
  - Custom components

### Plugin Development

- **[Plugin Development Guide](./plugins/DEVELOPMENT.md)**
  - Creating plugins
  - Custom configuration
  - Hooks system
  - LDAP operations
  - API endpoints
  - Testing

---

## Key Concepts

### Schema-Driven Architecture

Mini-DM uses JSON schemas to define LDAP entity structure:

```json
{
  "entity": {
    "name": "users",
    "mainAttribute": "uid",
    "objectClass": ["top", "person", "inetOrgPerson"],
    "base": "ou=users,{ldap_base}"
  },
  "attributes": {
    "uid": {
      "type": "string",
      "required": true,
      "role": "identifier"
    },
    "cn": {
      "type": "string",
      "required": true,
      "role": "displayName"
    }
  }
}
```

See [JSON Schemas Guide](./schemas/SCHEMAS.md) for details.

### Dynamic Configuration

The `/api/v1/config` endpoint exposes all available features, endpoints, and schemas. Your application discovers capabilities at runtime:

```javascript
const config = await fetch('/api/v1/config').then(r => r.json());

// Find users endpoint
const usersEndpoint = config.features.flatResources
  .find(r => r.pluralName === 'users')
  ?.endpoints.list;

// Use it
const users = await fetch(usersEndpoint).then(r => r.json());
```

See [REST API Guide](./api/REST_API.md) for details.

### Plugin-Based Extensibility

Extend Mini-DM with custom plugins that:
- Add REST API endpoints
- Hook into LDAP operations
- Integrate external systems
- Implement custom logic

See [Plugin Development Guide](./plugins/DEVELOPMENT.md) for details.

---

## Next Steps

1. **Learn the API** - Read the [REST API Guide](./api/REST_API.md)
2. **Try the Libraries** - Check the [Browser Libraries Guide](./browser/LIBRARIES.md)
3. **See Examples** - Explore [Integration Examples](./examples/EXAMPLES.md)
4. **Build a Plugin** - Follow the [Plugin Development Guide](./plugins/DEVELOPMENT.md)

---

## Resources

- [GitHub Repository](https://github.com/linagora/mini-dm)
- [Contributing Guide](../CONTRIBUTING.md)
- [Plugin Development](../src/plugins/README.md)
- [Hooks Reference](../HOOKS.md)

---

## Support

- **Issues**: https://github.com/linagora/mini-dm/issues
- **Documentation**: https://github.com/linagora/mini-dm/tree/master/docs

---

## License

AGPL-3.0 - Copyright 2025-present Linagora
