# Browser Libraries

Web components for integrating LDAP-Rest into your applications.

## Overview

LDAP-Rest provides reusable web components for LDAP management.

## Documentation

- **[libraries.md](libraries.md)** - Complete component documentation

## Available Components

| Component | Description |
|-----------|-------------|
| `LdapTreeViewer` | LDAP tree navigation |
| `LdapUserEditor` | User editing |
| `LdapGroupEditor` | Group management |
| `LdapUnitEditor` | Organizational unit management |
| `LdapResourceEditor` | Resource management |

## Utilities

| Module | Description |
|--------|-------------|
| `browser-shared-utils-totp` | TOTP client for authentication |
| `browser-shared-utils-hmac` | HMAC client for authentication |
| `browser-shared-utils-dom` | DOM utilities |
| `browser-shared-utils-form` | Form utilities |
| `browser-shared-utils-schema` | JSON schema utilities |

## Installation

```bash
npm install ldap-rest
```

## Import

```typescript
// Components
import { LdapTreeViewer, LdapUserEditor } from 'ldap-rest/browser';

// Utilities
import { TotpAuthClient } from 'ldap-rest/browser-shared-utils-totp';
import { HmacAuthClient } from 'ldap-rest/browser-shared-utils-hmac';
```

## Quick Example

```typescript
import { LdapTreeViewer } from 'ldap-rest/browser';

const viewer = new LdapTreeViewer({
  apiUrl: 'http://localhost:8081/api/v1',
  container: document.getElementById('tree'),
});

viewer.render();
```

## Demos

Interactive examples are available in the [examples](../examples/README.md) folder.
