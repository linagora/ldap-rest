# Contributing to Mini-DM

Thank you for your interest in contributing to Mini-DM! This document provides guidelines and information for developers who want to contribute to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Project Architecture](#project-architecture)
- [Development Workflow](#development-workflow)
- [Plugin Development](#plugin-development)
- [Testing](#testing)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)

---

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- An LDAP server for testing (OpenLDAP, 389 Directory Server, or Active Directory)
- Git

### Initial Setup

1. **Clone the repository:**

```bash
git clone https://github.com/linagora/mini-dm.git
cd mini-dm
```

2. **Install dependencies:**

```bash
npm install
```

3. **Set up test environment:**

Create a `~/.test-env` file with your test LDAP configuration:

```bash
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="admin"
export DM_LDAP_BASE="dc=example,dc=com"
export DM_LDAP_TOP_ORGANIZATION="ou=organization,dc=example,dc=com"
```

4. **Build the project:**

```bash
npm run build:dev
```

5. **Run in development mode:**

```bash
source ~/.test-env && npm run start:dev
```

---

## Project Architecture

Mini-DM follows a **plugin-based architecture** where functionality is organized into modular, reusable plugins.

### Directory Structure

```
mini-dm/
├── src/
│   ├── abstract/          # Abstract base classes
│   │   ├── plugin.ts      # Base plugin class
│   │   └── ldapFlat.ts    # Base class for flat LDAP resources
│   ├── bin/               # Main server entry point
│   │   └── index.ts       # DM class definition
│   ├── browser/           # Browser libraries (TypeScript source)
│   │   ├── ldap-tree-viewer/
│   │   └── ldap-user-editor/
│   ├── config/            # Configuration management
│   │   ├── args.ts        # CLI arguments and Config interface
│   │   └── schema.ts      # Schema TypeScript types
│   ├── hooks.ts           # Hook definitions and types
│   ├── lib/               # Utility libraries
│   │   ├── ldapActions.ts # LDAP operations wrapper
│   │   ├── parseConfig.ts # Configuration parser
│   │   └── utils.ts       # Utility functions
│   ├── logger/            # Logging configuration
│   └── plugins/           # Core plugins
│       ├── priority.json  # Plugin loading order
│       ├── auth/          # Authentication plugins
│       ├── ldap/          # LDAP management plugins
│       ├── twake/         # Twake integration plugins
│       ├── configApi.ts   # Configuration API
│       ├── static.ts      # Static file server
│       └── weblogs.ts     # Request logging
├── static/
│   ├── browser/           # Built browser libraries (JS/CSS)
│   └── schemas/           # JSON schemas
│       ├── standard/      # Standard LDAP schemas
│       ├── twake/         # Twake-specific schemas
│       └── ad/            # Active Directory schemas
├── test/                  # Test files
├── docs/                  # Documentation
└── examples/              # Example applications
```

### Core Concepts

#### 1. Plugins

Plugins are the building blocks of Mini-DM. Each plugin:
- Extends `DmPlugin` abstract class
- Has a unique `name` property
- Can expose REST API endpoints via `api()` method
- Can register hooks via `hooks` property
- Can depend on other plugins via `dependencies` property
- Can define roles for categorization (`auth`, `api`, `consistency`, etc.)

#### 2. Hooks

Hooks enable plugins to intercept and modify LDAP operations. Common hooks:
- `ldapaddrequest` / `ldapadddone` - Before/after adding entries
- `ldapmodifyrequest` / `ldapmodifydone` - Before/after modifying entries
- `ldapdeleterequest` / `ldapdeletedone` - Before/after deleting entries
- `ldapsearchrequest` - Before searching
- `onLdapChange` - Any LDAP change detected

See [HOOKS.md](./HOOKS.md) for complete documentation.

#### 3. Configuration

Configuration follows a priority order:
1. **Default values** - Defined in `src/config/args.ts`
2. **Environment variables** - Prefixed with `DM_`
3. **Command-line arguments** - Use `--option-name` format

The parser accepts unknown options and stores them in config for custom plugins.

#### 4. Schemas

JSON schemas define the structure and validation rules for LDAP entities. They include:
- Entity metadata (objectClass, mainAttribute, base DN)
- Attribute definitions with types and validation
- Semantic roles (identifier, displayName, primaryEmail)
- UI hints for browser libraries

---

## Development Workflow

### Running the Development Server

Load all available plugins automatically:

```bash
source ~/.test-env && npm run start:dev
```

This runs the server with hot-reload enabled via the `.dev.mk` script.

### Building

```bash
# Development build
npm run build:dev

# Production build (includes browser libraries)
npm run build

# Watch mode for development
npm run build:watch

# Browser libraries only
npm run build:browser
```

### Code Quality

```bash
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Check formatting
npm run format:check

# Fix formatting
npm run format:fix

# Run both lint and format checks
npm run check

# Fix all issues
npm run fix
```

---

## Plugin Development

### Creating a New Plugin

#### 1. Core Plugin (inside the repository)

Create a file in `src/plugins/<category>/<pluginName>.ts`:

```typescript
/**
 * @module plugins/<category>/<pluginName>
 * @author Your Name <your.email@example.com>
 *
 * Brief description of what this plugin does
 */
import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { Hooks } from '../../hooks';

export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  roles: Role[] = ['api'] as const;

  // Optional: declare dependencies
  dependencies = {
    requiredPlugin: 'core/ldap/groups',
  };

  // Constructor - initialize your plugin
  constructor(server: DM) {
    super(server);

    // Access configuration
    if (!this.config.my_plugin_option) {
      throw new Error('Missing --my-plugin-option');
    }

    this.logger.info('MyPlugin initialized');
  }

  // Optional: expose REST API endpoints
  api(app: Express): void {
    app.get(`${this.config.api_prefix}/v1/my-endpoint`, async (req, res) => {
      try {
        const result = await this.doSomething();
        res.json(result);
      } catch (error) {
        res.status(500).send(error.message);
      }
    });
  }

  // Optional: register hooks
  hooks: Hooks = {
    ldapaddrequest: async ([dn, entry, req]) => {
      // Validate or modify entry before adding
      this.logger.debug(`Adding entry: ${dn}`);
      return [dn, entry, req];
    },

    ldapadddone: async ([dn, success]) => {
      // React to successful addition
      if (success) {
        this.logger.info(`Entry added: ${dn}`);
      }
      return [dn, success];
    },
  };

  // Your plugin methods
  private async doSomething() {
    // Use LDAP operations
    const entries = await this.server.ldap.search(
      { paged: false, filter: '(objectClass=person)' },
      this.config.ldap_base
    );

    return entries;
  }
}
```

#### 2. External Plugin (outside the repository)

Create a file anywhere on your system, e.g., `/path/to/my-plugin.ts`:

```typescript
import type { Express } from 'express';
import DmPlugin from 'mini-dm/plugin'; // If published to npm
// Or: import DmPlugin from './node_modules/mini-dm/dist/abstract/plugin.js';

export default class ExternalPlugin extends DmPlugin {
  name = 'externalPlugin';

  api(app: Express): void {
    app.get('/external', (req, res) => {
      res.json({ message: 'External plugin loaded!' });
    });
  }
}
```

Load it with:

```bash
npx mini-dm --plugin /path/to/my-plugin.ts
```

#### 3. Adding Custom Configuration Options

Your plugin can accept custom command-line options:

```typescript
export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';

  constructor(server: DM) {
    super(server);

    // Access custom options
    // --my-custom-option becomes config.my_custom_option
    const customValue = this.config.my_custom_option;
    const customArray = this.config.my_custom_values; // From --my-custom-value (multiple)

    this.logger.info(`Custom option: ${customValue}`);
  }
}
```

Load with:

```bash
npx mini-dm \
  --plugin ./my-plugin.ts \
  --my-custom-option "value" \
  --my-custom-value "value1" \
  --my-custom-value "value2"
```

**Note:** Unknown options are automatically parsed and stored in `config`:
- `--option-name value` becomes `config.option_name = "value"`
- Multiple `--option value` become `config.option = ["value1", "value2"]`
- Environment variable format: `DM_OPTION_NAME`

### Plugin Best Practices

1. **Use `api_prefix`**: Always prefix API endpoints with `this.config.api_prefix`
2. **Error handling**: Wrap operations in try-catch and provide meaningful errors
3. **Logging**: Use `this.logger` with appropriate levels (debug, info, warn, error)
4. **Validation**: Validate configuration in constructor
5. **Dependencies**: Declare plugin dependencies explicitly
6. **Hooks**: Document hooks in HOOKS.md
7. **Testing**: Write tests for your plugin (see Testing section)
8. **TypeScript**: Use proper types, avoid `any`

### Using LDAP Operations

The `this.server.ldap` object provides LDAP operations:

```typescript
// Search
const results = await this.server.ldap.search(
  {
    paged: false,
    scope: 'sub', // 'base', 'one', 'sub'
    filter: '(uid=john)',
    attributes: ['cn', 'mail'],
  },
  'ou=users,dc=example,dc=com'
);

// Add
await this.server.ldap.add(
  'uid=john,ou=users,dc=example,dc=com',
  {
    objectClass: ['inetOrgPerson'],
    uid: 'john',
    cn: 'John Doe',
    sn: 'Doe',
  }
);

// Modify
await this.server.ldap.modify('uid=john,ou=users,dc=example,dc=com', {
  replace: { mail: 'john@example.com' },
  add: { telephoneNumber: '+1234567890' },
});

// Delete
await this.server.ldap.delete('uid=john,ou=users,dc=example,dc=com');
```

### Plugin Loading Order

Some plugins must load before others. Edit `src/plugins/priority.json`:

```json
[
  "core/auth/token",
  "core/auth/llng",
  "core/auth/openidconnect",
  "core/auth/authzPerBranch",
  "core/myNewAuthPlugin"
]
```

Plugins in this list load first, in order. Authentication plugins should load before others.

---

## Testing

### Running Tests

```bash
# All tests
source ~/.test-env && npm test

# Development mode (with watch)
source ~/.test-env && npm run test:dev

# Single test file
source ~/.test-env && npm run test:one test/plugins/ldap/groups.test.ts
```

### Writing Tests

Create test files in `test/` directory:

```typescript
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import request from 'supertest';

import { DM } from '../src/bin/index';
import { resetLdap } from './helpers/ldap';

describe('MyPlugin', () => {
  let server: DM;

  before(async () => {
    // Reset LDAP to known state
    await resetLdap();

    // Create server with your plugin
    server = new DM();
    process.argv = [
      'node',
      'test',
      '--plugin',
      'core/myPlugin',
      '--my-plugin-option',
      'value',
    ];

    await server.ready;
    await server.run();
  });

  after(async () => {
    if (server.server) {
      await new Promise((resolve) => server.server!.close(resolve));
    }
  });

  it('should respond to /api/v1/my-endpoint', async () => {
    const response = await request(server.app)
      .get('/api/v1/my-endpoint')
      .expect(200);

    expect(response.body).to.have.property('data');
  });
});
```

### Test Helpers

Use helpers from `test/helpers/`:
- `ldap.ts` - LDAP setup/reset functions
- `server.ts` - Server creation utilities

---

## Code Style

### TypeScript Guidelines

- **Strict typing**: Enable all strict TypeScript checks
- **No `any`**: Use proper types or `unknown`
- **Interfaces**: Define clear interfaces for data structures
- **Async/await**: Prefer over promises and callbacks
- **Error handling**: Always handle errors explicitly

### ESLint & Prettier

Configuration is already set up. Run:

```bash
npm run fix
```

This runs both ESLint and Prettier fixes.

### Naming Conventions

- **Files**: camelCase for modules, PascalCase for classes
- **Classes**: PascalCase (e.g., `MyPlugin`)
- **Methods**: camelCase (e.g., `doSomething()`)
- **Constants**: UPPER_SNAKE_CASE
- **Interfaces**: PascalCase (e.g., `Config`)
- **Types**: PascalCase (e.g., `Role`)

### Documentation

- Add JSDoc comments to public methods
- Include `@param` and `@returns` tags
- Document module purpose at file top
- Update HOOKS.md when adding new hooks

Example:

```typescript
/**
 * Validates user entry before LDAP addition
 * @param dn - Distinguished Name of the entry
 * @param entry - LDAP entry attributes
 * @returns Modified entry or throws error if invalid
 */
private validateUser(dn: string, entry: AttributesList): AttributesList {
  // ...
}
```

---

## Submitting Changes

### Git Workflow

1. **Fork the repository** (if external contributor)

2. **Create a feature branch:**

```bash
git checkout -b feature/my-new-feature
```

or

```bash
git checkout -b fix/bug-description
```

3. **Make your changes:**
   - Write code
   - Add tests
   - Update documentation

4. **Run quality checks:**

```bash
npm run check
npm test
```

5. **Commit your changes:**

```bash
git add .
git commit -m "feat: add new feature"
```

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

6. **Push to your fork:**

```bash
git push origin feature/my-new-feature
```

7. **Create a Pull Request** on GitHub

### Pull Request Guidelines

- **Title**: Clear, descriptive title following Conventional Commits
- **Description**: Explain what and why, not how
- **Tests**: Include tests for new features
- **Documentation**: Update relevant docs
- **Changelog**: Note breaking changes
- **Review**: Be responsive to feedback

### Code Review Process

1. Automated checks run (lint, test, build)
2. Maintainers review code
3. Feedback addressed
4. Approved and merged

---

## Additional Resources

### Documentation

- [Developer Guide](./docs/DEVELOPER_GUIDE.md) - For application developers using Mini-DM APIs
- [Plugin README](./src/plugins/README.md) - Plugin development guide
- [Hooks Documentation](./HOOKS.md) - Available hooks and their usage
- [Schema Guide](./docs/schemas/) - JSON schema documentation

### Examples

- [Example Plugins](./src/plugins/demo/) - Demo plugins
- [Example Applications](./examples/) - Web applications using Mini-DM
- [Test Files](./test/) - Test examples

### Communication

- **Issues**: [GitHub Issues](https://github.com/linagora/mini-dm/issues)
- **Discussions**: [GitHub Discussions](https://github.com/linagora/mini-dm/discussions)

---

## License

By contributing to Mini-DM, you agree that your contributions will be licensed under the [AGPL-3.0 License](./LICENSE).

---

Thank you for contributing to Mini-DM! 🎉
