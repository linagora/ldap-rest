---
title: LDAP-Rest
sub_title: Lightweight Directory Manager
---

# LDAP-Rest

## Lightweight Directory Manager with Plugin Architecture

![LDAP-Rest Logo](../linagora.png)

<!-- end_slide -->

# What is LDAP-Rest?

A **lightweight** and **extensible** directory manager for LDAP

## Key Features

- 🔌 **Plugin Architecture** - Modular and extensible functionality
- 🔄 **Automatic LDAP Consistency** - Data consistency plugins
- 🌐 **Complete REST API** - LDAP management via HTTP
- 🎨 **Browser Libraries** - Ready-to-use UI components
- 🔐 **Configurable Authentication** - Token, OIDC, LLNG, etc.
- ⚡ **Lightweight and Fast** - Minimal memory footprint
- 📦 **TypeScript** - Strict typing and safety

<!-- end_slide -->

# Architecture

## Technology Stack

```
┌─────────────────────────────────────┐
│         REST API (Express)          │
├─────────────────────────────────────┤
│         Plugin System               │
│  ┌──────────┬──────────┬─────────┐  │
│  │   Auth   │   LDAP   │  Twake  │  │
│  └──────────┴──────────┴─────────┘  │
├─────────────────────────────────────┤
│      LDAP Client (ldapts)           │
└─────────────────────────────────────┘
```

- **Runtime**: Node.js + TypeScript (ES Modules)
- **Build**: Rollup (dual config: server + browser)
- **Test**: Mocha + Chai
- **LDAP**: ldapts (modern client)

<!-- end_slide -->

# Plugin Architecture

## Event System and Hooks

```typescript
export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  dependencies = { onChange: 'core/ldap/onChange' };

  hooks: Hooks = {
    onLdapChange: async (dn, changes) => {
      // React to LDAP changes
    },
    onBeforeResponse: async (req, res, data) => {
      // Modify API responses
    },
  };
}
```

<!-- end_slide -->

# Available Plugins

## Authentication

- **token** - Bearer Token Authentication
- **openidconnect** - OpenID Connect / OAuth2
- **llng** - LemonLDAP::NG SSO
- **crowdsec** - Abuse Protection
- **rateLimit** - Rate Limiting
- **authzPerBranch** - Authorization per LDAP Branch
- **authzLinid1** - LinID v1 Authorization

<!-- end_slide -->

# Available Plugins (continued)

## LDAP Core

- **onChange** - Change Detection and Notification
- **flatGeneric** - Schema-Driven Generic Management
- **groups** - LDAP Group Management
- **organization** - Organizational Hierarchy
- **externalUsersInGroups** - External Users in Groups

## Integrations

- **twake/james** - Apache James Synchronization (mail)
- **twake/calendar** - Twake Calendar resources and users

<!-- end_slide -->

# Apache James Plugin

## LDAP ↔ Mail Consistency Plugin

[Apache James](https://james.apache.org/) is an open source mail server (SMTP, IMAP, POP3)

### Plugin Features

- 📧 **Automatic LDAP → James Sync**
- 🔄 **Mail Address Changes** - Account renaming + data
- 💾 **Quota Management** - Automatic updates
- 👥 **Mailing Lists** - LDAP Groups → Address Groups
- 📨 **Mail Aliases** - mailAlternateAddress → James aliases
- 🎯 **WebAdmin API** - REST Communication

### 🔐 Consistency Guarantee

**All LDAP modifications are automatically propagated to James**

- ✅ No desynchronization
- ✅ No manual intervention
- ✅ Real-time consistency

<!-- end_slide -->

# James Plugin - Consistency Scenarios

## 1. Mail Address Change

```
LDAP: mail = alice@example.com → alice.smith@example.com
  ↓ onChange detects the change
  ↓ Hook onLdapMailChange triggered
  ↓
James WebAdmin: POST /users/alice@.../rename/alice.smith@...
  → Account renamed
  → Mailbox preserved (inbox, sent, folders)
  → Old alias created automatically
  ✅ CONSISTENCY GUARANTEED
```

## 2. Quota Update

```
LDAP: mailQuota = 1000000000 → 5000000000 (1GB → 5GB)
  ↓ onChange detects the change
  ↓ Hook onLdapQuotaChange triggered
  ↓
James WebAdmin: PUT /quota/users/alice@.../size
  → Quota updated immediately
  ✅ CONSISTENCY GUARANTEED
```

<!-- end_slide -->

# James Plugin - List Consistency

## LDAP Groups → James Address Groups

```bash
# Create a group with mail attribute
POST /api/v1/ldap/groups
{
  "cn": "engineering",
  "mail": "engineering@company.com",
  "member": ["uid=alice,...", "uid=bob,..."]
}
```

### Automatic List Consistency

1. ✅ **Creation** → Group created in James + members added
2. ✅ **Add Member** → Member added to James list
3. ✅ **Remove Member** → Member removed from James list
4. ✅ **Delete Group** → List deleted in James

### Guarantee

**LDAP is the source of truth, James stays synchronized**

<!-- end_slide -->

# LDAP Consistency

## Automatic Consistency Plugins

LDAP-Rest automatically maintains **consistency** between LDAP and external systems

### Mechanisms

1. **onChange** detects all LDAP changes
2. Plugins react via hooks
3. Automatic corrective actions
4. **Referential integrity guarantee**

### Examples - LDAP Consistency

- **User Deletion** → Automatic removal from groups
- **DN Change** → Reference updates
- **External Users** → Maintained in groups

### Examples - LDAP ↔ James Consistency

- **Mail Change** → Account renaming + James alias
- **Quota Modification** → Immediate propagation
- **Alias Management** → Bidirectional LDAP/James sync

<!-- end_slide -->

# REST API

## Main Endpoints

```bash
# Organizations
GET    /api/v1/ldap/organizations/:dn
GET    /api/v1/ldap/organizations/:dn/subnodes
GET    /api/v1/ldap/organizations/:dn/subnodes/search

# Users (flatGeneric)
GET    /api/v1/ldap/users
POST   /api/v1/ldap/users
GET    /api/v1/ldap/users/:dn
PUT    /api/v1/ldap/users/:dn
DELETE /api/v1/ldap/users/:dn

# Groups
GET    /api/v1/ldap/groups
POST   /api/v1/ldap/groups
```

<!-- end_slide -->

# JSON Schemas

## Schema-Driven Architecture

Schemas define:

- LDAP object structure
- Data validation
- Auto-generated UI (browser)
- Automatic documentation

```json
{
  "objectClass": "inetOrgPerson",
  "fields": {
    "uid": { "type": "string", "required": true },
    "mail": { "type": "string", "format": "email" },
    "displayName": { "type": "string" }
  }
}
```

<!-- end_slide -->

# Available Schemas

## Standard LDAP

- **users** - Users (inetOrgPerson)
- **groups** - Groups (groupOfNames)
- **organizations** - Organizations (organizationalUnit)

## Active Directory

- **ad/users** - AD Users
- **ad/groups** - AD Groups

## Twake

- **twake/users** - Twake Extensions
- **twake/groups** - Twake Groups
- **twake/positions** - Positions/Functions

<!-- end_slide -->

# Browser Libraries

## Ready-to-Use UI Components

### LdapTreeViewer

Interactive tree for navigating LDAP organizations

### LdapUserEditor

Complete user management interface

- Organizational tree
- User list
- Edit form

<!-- end_slide -->

# LdapTreeViewer

## Usage

```typescript
import LdapTreeViewer from 'ldap-rest/browser-ldap-tree-viewer-index';

const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: node => {
    console.log('Selection:', node.dn);
  },
});

await viewer.init();
```

<!-- end_slide -->

# LdapUserEditor

## Usage

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
  onUserSaved: userDn => {
    console.log('User saved:', userDn);
  },
});

await editor.init();
```

<!-- end_slide -->

# Installation and Quick Start

## Installation

```bash
npm install ldap-rest
```

## Quick Start

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --ldap-dn 'cn=admin,dc=example,dc=com' \
  --ldap-pwd admin \
  --ldap-url ldap://localhost \
  --plugin core/ldap/groups \
  --plugin core/ldap/organization
```

<!-- end_slide -->

# Configuration

## Environment Variables

```bash
# LDAP Connection
DM_LDAP_URL=ldap://localhost:389
DM_LDAP_DN=cn=admin,dc=example,dc=com
DM_LDAP_PWD=adminpassword
DM_LDAP_BASE=ou=users,dc=example,dc=com

# HTTP Server
DM_PORT=8081
DM_HOST=0.0.0.0

# Logging
DM_LOG_LEVEL=info  # debug, info, warn, error
```

<!-- end_slide -->

# Development

## Main Commands

```bash
# Development
npm run build:dev        # Quick dev build
npm run start:dev        # Start dev server
npm run dev              # build + start

# Tests
npm test                 # All tests
npm run test:one <file>  # Single test

# Quality
npm run check            # lint + format check
npm run fix              # lint + format fix
```

<!-- end_slide -->

# Build and Deployment

## Production Build

```bash
npm run build:prod
# → Generates dist/, static/browser/, Dockerfile
```

## Docker

```bash
npm run build:docker     # Build image
docker run -p 8081:8081 ldap-rest
```

## Distribution

- NPM package with TypeScript exports
- CLI binaries: `ldap-rest`, `sync-james`, `cleanup-external-users`
- Static files ready for CDN

<!-- end_slide -->

# Use Cases

## Usage Scenarios

✅ **Enterprise Directory**

- Centralized user management
- **Mail synchronization (Apache James)**
- Web management interface
- **Automatic data consistency**

✅ **Collaborative Platform (Twake)**

- Multi-tenant with authzPerBranch
- **Mail, calendar, mailing lists**
- Reusable UI components
- **Guaranteed referential integrity**

✅ **Provisioning Service**

- **Hooks for external synchronization (James, etc.)**
- **Automatic LDAP consistency**
- Change auditing
- **Automatic inconsistency cleanup**

<!-- end_slide -->

# Extensibility

## Create a Custom Plugin

```typescript
import DmPlugin from 'ldap-rest/plugin-abstract';
import { Hooks } from 'ldap-rest/hooks';

export default class CustomPlugin extends DmPlugin {
  name = 'custom/myPlugin';

  hooks: Hooks = {
    onLdapChange: async (dn, changes) => {
      // Your business logic
      await this.syncToExternalSystem(dn, changes);
    },
  };

  routes() {
    return [
      {
        method: 'get',
        path: '/api/v1/custom/stats',
        handler: async (req, res) => {
          res.json({ stats: await this.getStats() });
        },
      },
    ];
  }
}
```

<!-- end_slide -->

# Security

## Security Mechanisms

- 🔐 **Multi-Method Authentication** (Token, OIDC, LLNG)
- 🛡️ **Granular Authorization** (per branch, per user)
- 🚦 **Rate Limiting** (DoS protection)
- 🔒 **CrowdSec** (intrusion detection)
- 📝 **Change Auditing** (via onChange)
- 🔑 **Secure LDAP Bind** (TLS supported)

<!-- end_slide -->

# Performance

## Optimizations

- ⚡ **Lazy Loading** - On-demand loading
- 🎯 **Smart Cache** - Reduced LDAP queries
- 📦 **Optimized Bundle** - Tree-shaking, minification
- 🔄 **Persistent Connections** - LDAP pool
- 🎨 **Efficient Rendering** - Virtual DOM (browser libs)

## Typical Metrics

- Startup: < 500ms
- API Request: < 50ms
- Memory Footprint: ~50MB

<!-- end_slide -->

# Roadmap

## Upcoming Features

- 🔍 **Advanced Search** - Complex LDAP filters
- 📊 **Admin Dashboard** - Monitoring and statistics
- 🌍 **i18n** - Complete internationalization
- 🔔 **Webhooks** - External notifications
- 📱 **Mobile-First UI** - Improved responsive design
- 🧪 **Interactive Playground** - Online demo

<!-- end_slide -->

# Documentation

## Available Resources

📚 **Guides**

- [Developer Guide](./DEVELOPER_GUIDE.md)
- [Browser Libraries](./browser/LIBRARIES.md)
- [REST API Reference](./api/REST_API.md)

🔌 **Plugins**

- [Plugin Development](./plugins/DEVELOPMENT.md)
- [Hooks Reference](HOOKS.md)

📦 **Schemas**

- [JSON Schemas Guide](./schemas/SCHEMAS.md)

<!-- end_slide -->

# Community

## Contributing

- 🐛 **Issues**: https://github.com/linagora/ldap-rest/issues
- 💡 **Discussions**: GitHub Discussions
- 📖 **Wiki**: https://deepwiki.com/linagora/ldap-rest
- 🤝 **Contributions**: See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

**AGPL-3.0** - Copyright 2025-present LINAGORA

Free and open source software

<!-- end_slide -->

# Concrete Examples

## Twake + Apache James Integration

```bash
# Complete configuration
npx ldap-rest \
  --plugin core/ldap/onChange \
  --plugin core/ldap/groups \
  --plugin twake/james \
  --james-webadmin-url http://james:8000 \
  --james-webadmin-token "admin-token" \
  --mail-attribute mail \
  --quota-attribute mailQuota \
  --alias-attribute mailAlternateAddress
```

### Synchronization Flow

```
LDAP Change → onChange → Hook → James WebAdmin API
                 ↓
              Logging + Audit
```

## Consistency Plugins - Examples

```typescript
// 1. LDAP Group Consistency
import groups from 'ldap-rest/plugin-ldap-groups';
dm.registerPlugin('groups', groups);

// User deletion:
// → Automatic removal from all groups
// → Update member/uniqueMember attributes

// 2. LDAP ↔ James Consistency
import james from 'ldap-rest/plugin-twake-james';
dm.registerPlugin('james', james);

// LDAP mail change:
// → James account renaming
// → Alias update
// → Quota propagation
// → Consistency guaranteed without manual intervention
```

<!-- end_slide -->

# Concrete Examples (continued)

## Custom Web Interface

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

// Integration in your React/Vue/Angular app
const editor = new LdapUserEditor({
  containerId: 'users',
  apiBaseUrl: process.env.API_URL,
  onUserSaved: dn => {
    analytics.track('user_updated', { dn });
    notifications.success('User saved');
  },
  onError: err => {
    errorTracker.capture(err);
  },
});
```

<!-- end_slide -->

# Comparison

## LDAP-Rest vs Alternatives

| Feature             | LDAP-Rest | LDAP Account Manager | phpLDAPadmin |
| ------------------- | --------- | -------------------- | ------------ |
| TypeScript          | ✅        | ❌                   | ❌           |
| Plugin Architecture | ✅        | ⚠️                   | ❌           |
| REST API            | ✅        | ⚠️                   | ❌           |
| Browser Libraries   | ✅        | ❌                   | ❌           |
| Modern Stack        | ✅        | ⚠️                   | ❌           |
| Extensibility       | ✅✅      | ⚠️                   | ⚠️           |
| James Sync          | ✅        | ❌                   | ❌           |
| Auto Consistency    | ✅        | ❌                   | ❌           |

<!-- end_slide -->

# Why LDAP-Rest?

## Key Benefits

🎯 **Modern**

- Modern JavaScript stack
- TypeScript first
- Native ES Modules

🔧 **Flexible**

- Customizable plugins
- Extensible hooks
- Configurable schemas

🚀 **Productive**

- Complete REST API
- Ready-to-use UI components
- Rich documentation

<!-- end_slide -->

# Q&A & Demo

## Contact

- 📧 Email: yadd@debian.org
- 🐙 GitHub: https://github.com/linagora/ldap-rest
- 🏢 LINAGORA: https://linagora.com

## Live Demo

```bash
# Launch demo
git clone https://github.com/linagora/ldap-rest
cd ldap-rest
npm install
npm run dev
```

Open http://localhost:8081

<!-- end_slide -->

# Thank You!

## LDAP-Rest - Lightweight Directory Manager

[![Powered by LINAGORA](../linagora.png)](https://linagora.com)

**GitHub**: https://github.com/linagora/ldap-rest

**License**: AGPL-3.0

---

_Questions?_
