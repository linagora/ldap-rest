# Browser Examples

This directory contains interactive HTML examples demonstrating the use of LDAP-Rest browser libraries.

## Available Examples

### 🔐 TOTP Client (`totp-client.html`)

Interactive demonstration of the TOTP authentication client library.

**Features:**

- Real-time TOTP code generation
- Countdown timer with visual indicator
- Copy to clipboard functionality
- API client testing
- Configuration options (digits, time step)
- Code examples for npm usage

**Usage:**

```bash
# Start the LDAP-Rest server
npm start

# Open in browser
http://localhost:8081/static/examples/web/totp-client.html
```

**NPM Module:**

```typescript
import {
  generateTotp,
  TotpAuthClient,
  getRemainingSeconds,
  isValidBase32,
} from 'ldap-rest/browser-shared-utils-totp';
```

### 📁 LDAP Tree Viewer (`ldap-tree-viewer.html`)

Visualize and navigate LDAP directory structure.

**Features:**

- Interactive tree navigation
- Node details display
- Expand/collapse controls
- Refresh functionality

### 👥 LDAP User Editor (`ldap-user-editor.html`)

Browse and edit LDAP user entries.

**Features:**

- User list and tree view
- Edit user properties
- Move users between branches
- Add/delete users

### 👔 LDAP Group Editor (`ldap-group-editor.html`)

Manage LDAP groups and memberships.

**Features:**

- Group tree navigation
- Edit group properties
- Manage members
- Create/move/delete groups

### 🏢 LDAP Unit Editor (`ldap-unit-editor.html`)

Manage organizational units.

**Features:**

- Unit tree structure
- Edit unit properties
- Move units
- Create/delete units

## Running Examples

1. **Start the server:**

   ```bash
   npm start
   # or
   npm run dev
   ```

2. **Configure authentication:**

   For TOTP example:

   ```bash
   npm start -- \
     --plugin core/auth/totp \
     --auth-totp "JBSWY3DPEHPK3PXP:admin:6"
   ```

3. **Open examples in browser:**
   ```
   http://localhost:8081/static/examples/web/totp-client.html
   http://localhost:8081/static/examples/web/ldap-tree-viewer.html
   http://localhost:8081/static/examples/web/ldap-user-editor.html
   http://localhost:8081/static/examples/web/ldap-group-editor.html
   http://localhost:8081/static/examples/web/ldap-unit-editor.html
   ```

## Using Browser Libraries in Your Application

All browser libraries are available as npm module exports:

```typescript
// TOTP Client
import { TotpAuthClient } from 'ldap-rest/browser-shared-utils-totp';

// Shared utilities
import { escapeHtml, createElement } from 'ldap-rest/browser-shared-utils-dom';
import { Modal } from 'ldap-rest/browser-shared-components-modal';
import { showStatus } from 'ldap-rest/browser-shared-components-statusmessage';

// LDAP Tree Viewer
import { LdapTreeViewer } from 'ldap-rest/browser-ldap-tree-viewer-ldaptreeviewer';

// User Editor
import { LdapUserEditor } from 'ldap-rest/browser-ldap-user-editor-ldapusereditor';

// Group Editor
import { LdapGroupEditor } from 'ldap-rest/browser-ldap-group-editor-ldapgroupeditor';
```

See [package.json exports](../../package.json) for complete list of available modules.

## Development

### Building Examples

Examples are automatically built when you run:

```bash
npm run build
# or
npm run build:browser
```

### Modifying Examples

1. Edit the source in `src/browser/`
2. Rebuild: `npm run build:browser`
3. Refresh browser to see changes

### Live Development

Use watch mode for automatic rebuilds:

```bash
npm run build:watch
```

## Documentation

- [Authentication Guide](../../docs/authentication.md) - TOTP, Token, SSO authentication
- [Developer Guide](../../docs/DEVELOPER_GUIDE.md) - Building applications with LDAP-Rest
- [Browser API Documentation](../../docs/) - Detailed API documentation

## License

Copyright 2025-present [LINAGORA](https://linagora.com)

Licensed under [GNU AGPL-3.0](../../LICENSE)
