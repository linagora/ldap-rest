# Plugin Development Guide

This guide will help you create powerful, production-ready plugins for LDAP-Rest.

## Table of Contents

- [Why Create a Plugin](#why-create-a-plugin)
- [Plugin Structure](#plugin-structure)
- [Creating Your Plugin](#creating-your-plugin)
- [Plugin services](./services.md)
- [Custom Configuration Options](#custom-configuration-options)
  - [Plugin options](./options.md)
- [Loading Your Plugin](#loading-your-plugin)
- [Plugin Features](#plugin-features)
- [Configuration Best Practices](#configuration-best-practices)
- [Complete Plugin Example](#complete-plugin-example)
- [Testing Your Plugin](#testing-your-plugin)
- [Documenting REST endpoints (OpenAPI)](./openapi.md)

---

## Why Create a Plugin

Plugins extend LDAP-Rest with custom functionality for your specific needs:

### Common Use Cases

- **Business Logic** - Enforce organization-specific validation rules, data transformation, or custom workflows
- **External Integration** - Connect to external systems like email servers, webhooks, notification services, or third-party APIs
- **Authentication & Authorization** - Implement custom authentication methods, rate limiting, or fine-grained access control
- **API Endpoints** - Expose custom REST endpoints for specialized operations or reporting
- **Data Transformation** - Modify LDAP entries before/after operations, compute derived attributes, or maintain consistency

Plugins can combine multiple features: hook into LDAP operations, expose API endpoints, and integrate external services all in one module.

---

## Plugin Structure

Every plugin extends the `DmPlugin` base class and defines a unique name:

```typescript
import DmPlugin from '../../abstract/plugin';
import type { Role } from '../../abstract/plugin';

export default class MyPlugin extends DmPlugin {
  name = 'myPlugin'; // Unique identifier for your plugin
  roles: Role[] = ['api'] as const; // Optional: categorize your plugin
}
```

### Core Properties

- **name** (required): Unique identifier for your plugin
- **roles** (optional): Array categorizing plugin purpose
- **dependencies** (optional): Required plugins that must load first
- **hooks** (optional): Callbacks for LDAP operations
- **provides** (optional): Typed services this plugin offers, see
  [plugin services](services.md)
- **api()** (optional): Method to register REST endpoints

### Available from Base Class

- **this.server**: DM server instance
- **this.config**: Complete configuration object
- **this.options(declarations)**: Values of the options the plugin declares,
  typed and checked, see [plugin options](options.md)
- **this.logger**: Winston logger instance
- **this.hookBus**: The server's hooks: chain, notify and wait on them, see
  [hooks](hooks.md#the-bus)
- **this.service(token)**: The instance another plugin provides under a
  service token, or `null`, see [plugin services](services.md)
- **this.fetch**: `fetch` timed into the
  [outbound metrics](../usage/operations.md#metrics) under the plugin's
  name; the lint refuses a bare `fetch` or `node-fetch` under `src`, and a
  plugin with a `fetch` member of its own has to rename it

### Error Handling and Server Resilience

An error a route handler or a hook throws is logged with its stack; the
request is answered with a 5xx when the hook ran before the operation, and
the server keeps serving. An exception nothing catches, in a timer or an
event handler, is not: the binary shuts down and exits with 1, and a
promise rejection nothing handles is logged and counted, see
[shutdown](../usage/operations.md#shutdown); a host assembling the server
chooses with `exitOnCrash()`. A plugin holding a connection, a timer or a
queue implements `close()`, see
[for plugin authors](../usage/operations.md#for-plugin-authors).

#### Using asyncHandler

For async route handlers, **always use the `asyncHandler` wrapper**:

```typescript
import DmPlugin, { asyncHandler } from '../../abstract/plugin';

export default class MyPlugin extends DmPlugin {
  api(app: Express): void {
    // ✅ Correct: Errors are automatically caught
    app.get(
      '/api/data',
      asyncHandler(async (req, res) => {
        const data = await someAsyncOperation();
        res.json(data);
      })
    );

    // ❌ Wrong: Errors can crash the server
    app.get('/api/data', async (req, res) => {
      const data = await someAsyncOperation();
      res.json(data);
    });
  }
}
```

The `asyncHandler` is exported from:

- `ldap-rest/abstract/plugin` (recommended for plugins)
- `ldap-rest` (for external use)

See [Exposing API Endpoints](#exposing-api-endpoints) for detailed examples.

---

## Creating Your Plugin

### Option 1: Core Plugin (Inside ldap-rest Repository)

Create a file in `src/plugins/<category>/<pluginName>.ts`:

```typescript
/**
 * @module plugins/notification/webhook
 * @author Your Name <your.email@example.com>
 *
 * Webhook notification plugin that sends HTTP requests on LDAP changes
 */
import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role, asyncHandler } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';

export default class WebhookNotifier extends DmPlugin {
  name = 'webhookNotifier';
  roles: Role[] = ['api'] as const;

  // Declare dependencies (optional)
  dependencies = {
    ldapGroups: 'core/ldap/groups',
  };

  constructor(server: DM) {
    super(server);

    // Validate configuration
    if (!this.config.webhook_url) {
      throw new Error('--webhook-url is required');
    }

    this.logger.info('WebhookNotifier initialized');
  }

  // Register API endpoints
  api(app: Express): void {
    app.get(
      `${this.config.api_prefix}/v1/webhook/status`,
      asyncHandler(async (req, res) => {
        res.json({
          status: 'active',
          url: this.config.webhook_url,
        });
      })
    );
  }

  // Register hooks
  hooks: Hooks = {
    ldapadddone: async ([dn, entry]) => {
      this.logger.info(`User added: ${dn}`);
      await this.sendWebhook('user.added', { dn, entry });
    },
  };

  // Private methods
  private async sendWebhook(event: string, data: unknown): Promise<void> {
    try {
      await this.fetch(this.config.webhook_url as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data }),
      });
    } catch (error) {
      this.logger.error('Webhook failed:', error);
    }
  }
}
```

Load with:

```bash
npx ldap-rest \
  --plugin core/notification/webhook \
  --webhook-url https://example.com/webhook
```

### Option 2: External Plugin (Outside Repository)

Create a standalone file anywhere on your system, e.g., `/opt/custom-plugins/my-plugin.ts`:

```typescript
/**
 * External plugin example
 * This plugin can be loaded from anywhere
 */
import type { Express, Request, Response } from 'express';

// Import from ldap-rest
import DmPlugin, { asyncHandler } from 'ldap-rest/plugin';
import type { DM } from 'ldap-rest';
import type { Hooks } from 'ldap-rest/hooks';

export default class ExternalAuditPlugin extends DmPlugin {
  name = 'externalAudit';

  constructor(server: DM) {
    super(server);

    // Access custom configuration options
    const auditPath = this.config.audit_path || '/var/log/ldap-audit.log';
    this.logger.info(`Audit log path: ${auditPath}`);
  }

  api(app: Express): void {
    app.get(
      `${this.config.api_prefix}/v1/audit/stats`,
      asyncHandler(async (req: Request, res: Response) => {
        res.json({
          message: 'External plugin API',
          auditEnabled: true,
        });
      })
    );
  }

  hooks: Hooks = {
    ldapaddrequest: async ([dn, entry, req]) => {
      this.logger.debug(`[AUDIT] Adding: ${dn}`);
      // Your audit logic here
      return [dn, entry, req];
    },

    ldapmodifyrequest: async ([dn, changes, op]) => {
      this.logger.debug(`[AUDIT] Modifying: ${dn}`);
      // Your audit logic here
      return [dn, changes, op];
    },
  };
}
```

Load with:

```bash
npx ldap-rest \
  --plugin /opt/custom-plugins/my-plugin.ts \
  --audit-path /var/log/ldap-audit.log
```

Or via environment variable:

```bash
export DM_PLUGINS=/opt/custom-plugins/my-plugin.ts
export DM_AUDIT_PATH=/var/log/ldap-audit.log
npx ldap-rest
```

---

## Custom Configuration Options

A core plugin declares its options next to its code, in a
`<plugin>.options.ts` file, and reads them through `this.options()` with their
types, defaults and checks. See [plugin options](options.md).

A plugin outside the repository cannot add to `src/config/args.ts` yet. It keeps
reading `this.config.<name>`: LDAP-Rest accepts and stores unknown
`--option-name value` pairs under `option_name`, with `--option-name` and
`DM_OPTION_NAME` overriding in that order. See
[configuration](../usage/configuration.md#environment-variables).

---

## Loading Your Plugin

### Core Plugin

```bash
# Load by path within src/plugins/
npx ldap-rest --plugin core/notification/webhook

# Load multiple plugins
npx ldap-rest \
  --plugin core/ldap/groups \
  --plugin core/notification/webhook \
  --plugin core/static
```

### External Plugin

```bash
# Load by absolute file path
npx ldap-rest --plugin /path/to/my-plugin.ts

# Load multiple external plugins
npx ldap-rest \
  --plugin /opt/plugins/audit.ts \
  --plugin /opt/plugins/validation.ts
```

### Via Environment Variable

```bash
# Single plugin
export DM_PLUGINS=core/notification/webhook
npx ldap-rest

# Multiple plugins (comma-separated)
export DM_PLUGINS=core/ldap/groups,core/static,/opt/plugins/custom.ts
npx ldap-rest
```

### Plugin Loading Order

Some plugins must load before others (e.g., authentication plugins). Edit `src/plugins/priority.json`:

```json
[
  "core/auth/token",
  "core/auth/llng",
  "core/auth/openidconnect",
  "core/auth/authzPerBranch",
  "core/myNewAuthPlugin"
]
```

Plugins in this list load first, in order. All other plugins load after.

---

## Plugin Features

### Declaring Dependencies

Ensure required plugins load before yours:

```typescript
export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';

  dependencies = {
    // Key is how you reference it, value is the plugin path
    groups: 'core/ldap/groups',
    users: 'core/ldap/flatGeneric',
  };

  constructor(server: DM) {
    super(server);

    // Access dependent plugin
    const groupsPlugin = this.server.loadedPlugins['ldapGroups'];
    if (groupsPlugin) {
      this.logger.info('Groups plugin is available');
    }
  }
}
```

### Using LDAP Operations

The `this.server.ldap` object provides access to all LDAP operations:

> **Say whose each operation is.**
>
> The authorization plugins (`core/auth/authzPerBranch`,
> `core/auth/authzDynamic`, …) hook `ldapsearchrequest`, `ldapaddrequest`,
> `ldapmodifyrequest`, `ldaprenamerequest` and `ldapdeleterequest`, and judge
> an operation by the request it carries. The methods below take it as a
> trailing optional argument.
>
> In a request handler, bind once and use the result:
>
> ```typescript
> const directory = this.server.ldap.forRequest(req);
> await directory.search({ scope: 'base' }, dn);
> await directory.modify(dn, changes);
> ```
>
> An operation that names no request while an authenticated request is being
> served is made for that request all the same, and judged as its caller: a
> forgotten argument fails closed. Work that is the server's — a uniqueness
> check has to see a whole branch, and a reference to an entry the caller
> cannot read is still a valid reference — goes through `ldap.system`, which
> steps out of the request, with a comment saying why:
>
> ```typescript
> // As the server: a name is taken whoever may read the entry holding it
> await this.server.ldap.system.search({ scope: 'base' }, dn);
> ```
>
> A lint rule refuses an operation that names neither a request nor
> `ldap.system`. Hooks run outside the request: what a hook reads or writes
> to validate, complete or follow an operation is the server's, and a hook
> acting as the caller passes the request it is handed. Startup and
> scheduled tasks run outside any request.

> **Read as the server? Judge the caller first.**
>
> A read the server makes for a request answers the caller with what it
> found: a 404 for an entry that is not there, a 400 for a pointer leading
> nowhere, a 409 for a name taken. Made before the write it prepares is
> judged, it tells a caller who may not make that write what the directory
> holds where they cannot read. Have the authorization plugins judge the
> write first, without making it:
>
> ```typescript
> await this.server.ldap.authorize('ldaprenamerequest', [dn, newDn, req]);
> // only now: does dn exist, is newDn free, …
> ```
>
> It runs the hooks of the plugins with the `authz` role only, and refuses
> with their 403 whether the entry is there or not. The write, when made,
> is judged again with every other hook.
>
> A route that finds an entry as the server, across branches, and then
> answers about it, checks that the caller can read what it found, and
> answers as for an entry that is not there otherwise:
>
> ```typescript
> if (!(await this.server.ldap.readableBy(dn, req)))
>   throw new NotFoundError(`User ${id} not found`);
> ```

#### Search

```typescript
// Basic search
const results = await this.server.ldap.search(
  {
    paged: false,
    scope: 'sub', // 'base', 'one', or 'sub'
    filter: '(objectClass=inetOrgPerson)',
    attributes: ['cn', 'mail', 'uid'],
  },
  'ou=users,dc=example,dc=com'
);

// Search with pagination (returns AsyncGenerator; the connection is taken
// when the first page is read)
const pagedResults = await this.server.ldap.search(
  {
    paged: true,
    filter: '(uid=*)',
    attributes: ['cn', 'mail'],
  },
  'dc=example,dc=com'
);

for await (const page of pagedResults) {
  page.searchEntries.forEach(entry => {
    console.log(entry.dn, entry.cn);
  });
}
```

#### Add

```typescript
await this.server.ldap.add('uid=john,ou=users,dc=example,dc=com', {
  objectClass: ['inetOrgPerson', 'person', 'top'],
  uid: 'john',
  cn: 'John Doe',
  sn: 'Doe',
  mail: 'john@example.com',
  userPassword: 'secret123',
});
```

#### Modify

```typescript
await this.server.ldap.modify('uid=john,ou=users,dc=example,dc=com', {
  replace: {
    mail: 'john.doe@example.com',
    telephoneNumber: '+1234567890',
  },
  add: {
    description: 'Senior Developer',
  },
  delete: {
    oldAttribute: 'valueToRemove',
  },
});
```

#### Attribute names

An add or a modify names its attributes as the server does before the
authorization plugins and the hooks see them: `MAIL`, `rfc822Mailbox` or
the OID of `mail` reach a hook as `mail`, spelled as the configuration or a
loaded schema spells it. A hook may therefore look an attribute up by that
name. An option other than `;binary` is refused, as is one attribute named
twice in one part of a write.

A route that checks a body before handing it to `add` or `modify` names
its attributes the same way first, and a plugin loading a schema of its
own says how it spells them:

```typescript
await this.server.ldap.canonicalChanges(changes); // or canonicalAttributes(entry)
this.server.ldap.knowAttributeNames(Object.keys(schema.attributes));
```

#### Delete

```typescript
// Delete single entry
await this.server.ldap.delete('uid=john,ou=users,dc=example,dc=com');

// Delete multiple entries
await this.server.ldap.delete([
  'uid=user1,ou=users,dc=example,dc=com',
  'uid=user2,ou=users,dc=example,dc=com',
]);
```

### Registering Hooks

Hooks let you intercept and modify LDAP operations:

```typescript
hooks: Hooks = {
  // LDAP ADD HOOKS
  ldapaddrequest: async ([dn, entry, req]) => {
    // Called BEFORE adding an entry
    // Validate, modify entry, or prevent operation
    this.logger.debug(`Adding entry: ${dn}`);

    // Add computed field
    entry.createdAt = new Date().toISOString();

    // Validation
    if (!entry.mail) {
      throw new Error('Email is required');
    }

    return [dn, entry, req];
  },

  ldapadddone: async ([dn, entry]) => {
    // Called AFTER successful add
    this.logger.info(`Entry added: ${dn}`);
    // Trigger side effects, notifications, etc.
  },

  // LDAP MODIFY HOOKS
  ldapmodifyrequest: async ([dn, changes, opNumber]) => {
    // Called BEFORE modifying an entry
    this.logger.debug(`Modifying entry: ${dn}`);

    // Add audit trail
    if (!changes.add) changes.add = {};
    changes.add.modifiedAt = new Date().toISOString();

    return [dn, changes, opNumber];
  },

  ldapmodifydone: async ([dn, changes, opNumber]) => {
    // Called AFTER successful modify
    this.logger.info(`Entry modified: ${dn}`);
  },

  // LDAP DELETE HOOKS
  ldapdeleterequest: async dn => {
    // Called BEFORE deleting entry
    this.logger.debug(`Deleting entry: ${dn}`);

    // Prevent deletion of admin
    if (dn.includes('cn=admin')) {
      throw new Error('Cannot delete admin user');
    }

    return dn;
  },

  ldapdeletedone: async dn => {
    // Called AFTER successful delete
    this.logger.info(`Entry deleted: ${dn}`);
  },

  // CUSTOM HOOKS (from other plugins)
  onLdapChange: async (dn, changes) => {
    // React to any LDAP change
    this.logger.info(`Change detected on ${dn}`);
  },
};
```

### Exposing API Endpoints

Declare routes with [`defineRoute`](routes.md): it types and validates the
request (`params`, `query`, `body`), answers a failing request with a 400
naming the paths at fault, and records the route for the OpenAPI document.
The `asyncHandler` form below remains for routes that have not been migrated
yet.

Create REST API endpoints for your plugin. Always use the `asyncHandler`
wrapper for async routes, so that errors are properly handled and do not
crash the server.

```typescript
import DmPlugin, { asyncHandler } from '../../abstract/plugin';

api(app: Express): void {
  // GET endpoint with asyncHandler
  app.get(
    `${this.config.api_prefix}/v1/myplugin/status`,
    asyncHandler(async (req: Request, res: Response) => {
      const status = await this.getStatus();
      res.json({ success: true, data: status });
    })
  );

  // POST endpoint with body validation
  app.post(
    `${this.config.api_prefix}/v1/myplugin/process`,
    asyncHandler(async (req: Request, res: Response) => {
      // Validate request body
      if (!req.body || !req.body.data) {
        return res.status(400).json({
          success: false,
          error: 'data is required'
        });
      }

      const result = await this.processData(req.body.data);
      res.json({ success: true, data: result });
    })
  );

  // PUT endpoint
  app.put(
    `${this.config.api_prefix}/v1/myplugin/config`,
    asyncHandler(async (req: Request, res: Response) => {
      await this.updateConfig(req.body);
      res.json({ success: true });
    })
  );

  // DELETE endpoint
  app.delete(
    `${this.config.api_prefix}/v1/myplugin/cache`,
    asyncHandler(async (req: Request, res: Response) => {
      await this.clearCache();
      res.json({ success: true, message: 'Cache cleared' });
    })
  );

  this.logger.info('MyPlugin API endpoints registered');
}
```

#### Parsing request bodies

The server parses `application/json` (up to 100 kB) and
`application/x-www-form-urlencoded` bodies before authentication runs, so
that `core/auth/hmac` can check them. A plugin that needs another media type
or limit under its prefix registers its own parser, which runs ahead of
those:

```typescript
import { jsonBodyParser } from '../../lib/rawBody';

api(app: Express): void {
  this.server.registerBodyParser('/myplugin', jsonBodyParser({ limit: '1mb' }));
}
```

`jsonBodyParser` keeps the bytes it reads, which `core/auth/hmac` hashes. Any
other parser must pass `keepRawBody` as `verify`, or `core/auth/hmac` refuses
its bodies with `401`. A parser mounted with `app.use()` in `api()` runs
after authentication, too late for that check.

#### Error Handling Best Practices

The `asyncHandler` wrapper automatically catches errors and passes them to the global error middleware. This ensures:

- **Server stability**: Exceptions in routes won't crash the server
- **Consistent error responses**: All errors return proper HTTP 500 responses
- **Automatic logging**: Errors are logged with full stack traces
- **Clean code**: No need for try/catch blocks in every route

**Without asyncHandler (DON'T DO THIS):**

```typescript
// ❌ BAD: Unhandled async errors can crash the server
app.get('/api/data', async (req, res) => {
  const data = await fetchData(); // If this throws, server crashes
  res.json(data);
});
```

**With asyncHandler (RECOMMENDED):**

```typescript
// ✅ GOOD: Errors are caught and handled gracefully
app.get(
  '/api/data',
  asyncHandler(async (req, res) => {
    const data = await fetchData(); // If this throws, error is logged and 500 returned
    res.json(data);
  })
);
```

**Wrapping an error keeps its answer:**

Wrap with `cause` rather than in the message alone. The status and the class
of what was thrown are read through the chain, so a refusal stays a 403 and
a timeout a 504 wherever it surfaces:

```typescript
// ✅ GOOD: the refusal keeps its 403 when it reaches the client
throw new Error(`Failed to add group ${dn}: ${String(err)}`, { cause: err });

// ❌ BAD: a 403 becomes a 500, and its message is all that is left
throw new Error(`Failed to add group ${dn}: ${String(err)}`);
```

**Refusing a caller:**

An authorization plugin throws `AuthzRefusedError`, whose message is for the
operator: it names the model and the branch it judged. The client is told
`AUTHZ_REFUSED` with `code: "forbidden"` instead, whatever a plugin wrapped
it in on the way. A refusal that is not an authorization plugin's is any
`ForbiddenError`, answered with its own message; `isAuthzRefusal(err)` tells
the two apart.

**Custom error handling:**

```typescript
// You can still handle specific errors manually
app.post(
  '/api/process',
  asyncHandler(async (req, res) => {
    try {
      const result = await processData(req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof ValidationError) {
        // Handle specific error types
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.details,
        });
      }
      // Re-throw to let asyncHandler handle it
      throw error;
    }
  })
);
```

### Logging

Use the provided logger with appropriate levels:

```typescript
// Debug - detailed diagnostic information
this.logger.debug('Processing entry:', entry);

// Info - general informational messages
this.logger.info('Plugin initialized successfully');

// Warn - warning messages for potentially harmful situations
this.logger.warn('Configuration not found, using defaults');

// Error - error events that might still allow the application to continue
this.logger.error('Failed to process webhook:', error);
```

### Plugin Roles

Categorize your plugin using roles:

```typescript
export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  roles: Role[] = ['auth', 'api'] as const;
}
```

Available roles:

- **auth** - Authentication plugins
- **authz** - Authorization/access control plugins
- **protect** - Security/rate limiting plugins
- **api** - Plugins exposing API endpoints
- **logging** - Logging and audit plugins
- **demo** - Example/demonstration plugins
- **consistency** - Data consistency enforcement plugins

---

## Configuration Best Practices

### Validation in Constructor

```typescript
constructor(server: DM) {
  super(server);

  // Validate required configuration
  if (!this.config.webhook_url) {
    throw new Error('Missing required configuration: --webhook-url');
  }

  // Validate format
  const url = this.config.webhook_url as string;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('--webhook-url must start with http:// or https://');
  }

  // Validate numeric ranges
  const timeout = parseInt(this.config.webhook_timeout as string || '3000');
  if (timeout < 100 || timeout > 30000) {
    throw new Error('--webhook-timeout must be between 100 and 30000');
  }

  this.logger.info('Configuration validated successfully');
}
```

### Provide Defaults

```typescript
constructor(server: DM) {
  super(server);

  // Set defaults for optional configuration
  this.webhookUrl = this.config.webhook_url as string;
  this.webhookTimeout = parseInt(
    this.config.webhook_timeout as string || '3000'
  );
  this.maxRetries = parseInt(
    this.config.webhook_max_retries as string || '3'
  );
  this.retryDelay = parseInt(
    this.config.webhook_retry_delay as string || '1000'
  );
}
```

### Document Configuration Options

Add clear documentation in your plugin file:

```typescript
/**
 * @module plugins/notification/webhook
 * @author Your Name <your.email@example.com>
 *
 * Webhook notification plugin
 *
 * Configuration options:
 *
 * Required:
 * - --webhook-url <url>          Webhook endpoint URL (required)
 * - --webhook-secret <string>    Secret for webhook authentication (required)
 *
 * Optional:
 * - --webhook-timeout <ms>       Request timeout in milliseconds (default: 3000)
 * - --webhook-max-retries <n>    Maximum retry attempts (default: 3)
 * - --webhook-retry-delay <ms>   Delay between retries (default: 1000)
 * - --webhook-event <event>      Events to send (multiple, default: all)
 *
 * Environment variables:
 * - DM_WEBHOOK_URL
 * - DM_WEBHOOK_SECRET
 * - DM_WEBHOOK_TIMEOUT
 * - DM_WEBHOOK_MAX_RETRIES
 * - DM_WEBHOOK_RETRY_DELAY
 * - DM_WEBHOOK_EVENTS (comma-separated)
 *
 * Example usage:
 *
 *   npx ldap-rest \
 *     --plugin core/notification/webhook \
 *     --webhook-url https://example.com/webhook \
 *     --webhook-secret mysecret123 \
 *     --webhook-event user.added \
 *     --webhook-event user.modified
 */
```

---

## Complete Plugin Example

Here's a complete, production-ready plugin that sends webhook notifications on LDAP changes:

```typescript
/**
 * @module plugins/notification/webhook
 * @author Example Developer <dev@example.com>
 *
 * Sends webhook notifications when LDAP entries are modified
 *
 * Configuration:
 * - --webhook-url <url>          Target webhook URL (required)
 * - --webhook-secret <string>    Authentication secret (required)
 * - --webhook-timeout <ms>       Request timeout (default: 5000)
 * - --webhook-retry-count <n>    Retry attempts (default: 3)
 * - --webhook-event <event>      Events to monitor (multiple allowed)
 */
import type { Express, Request, Response } from 'express';
import crypto from 'crypto';

import DmPlugin, { type Role, asyncHandler } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type { AttributesList, ModifyRequest } from '../../lib/ldapActions';

interface WebhookPayload {
  event: string;
  timestamp: string;
  dn: string;
  data: AttributesList | ModifyRequest;
}

interface WebhookStats {
  sent: number;
  failed: number;
  lastSent: string | null;
  lastError: string | null;
}

export default class NotificationPlugin extends DmPlugin {
  name = 'notification';
  roles: Role[] = ['api', 'logging'] as const;

  private webhookUrl: string;
  private webhookSecret: string;
  private webhookTimeout: number;
  private retryCount: number;
  private enabledEvents: Set<string>;
  private stats: WebhookStats;

  constructor(server: DM) {
    super(server);

    // Validate required configuration
    if (!this.config.webhook_url) {
      throw new Error('NotificationPlugin requires --webhook-url');
    }
    if (!this.config.webhook_secret) {
      throw new Error('NotificationPlugin requires --webhook-secret');
    }

    // Load configuration with defaults
    this.webhookUrl = this.config.webhook_url as string;
    this.webhookSecret = this.config.webhook_secret as string;
    this.webhookTimeout = parseInt(
      (this.config.webhook_timeout as string) || '5000'
    );
    this.retryCount = parseInt(
      (this.config.webhook_retry_count as string) || '3'
    );

    // Parse enabled events
    const events = (this.config.webhook_event as string[]) || ['*'];
    this.enabledEvents = new Set(events);

    // Initialize stats
    this.stats = {
      sent: 0,
      failed: 0,
      lastSent: null,
      lastError: null,
    };

    this.logger.info(
      `NotificationPlugin initialized: ${this.webhookUrl} ` +
        `(events: ${Array.from(this.enabledEvents).join(', ')})`
    );
  }

  api(app: Express): void {
    // Get webhook stats
    app.get(
      `${this.config.api_prefix}/v1/notifications/stats`,
      asyncHandler(async (req: Request, res: Response) => {
        res.json({
          success: true,
          data: {
            ...this.stats,
            webhookUrl: this.webhookUrl,
            enabledEvents: Array.from(this.enabledEvents),
          },
        });
      })
    );

    // Test webhook
    app.post(
      `${this.config.api_prefix}/v1/notifications/test`,
      asyncHandler(async (req: Request, res: Response) => {
        await this.sendWebhook('test', 'test', { message: 'Test webhook' });
        res.json({ success: true, message: 'Test webhook sent' });
      })
    );

    this.logger.info('NotificationPlugin API registered');
  }

  hooks: Hooks = {
    ldapadddone: async ([dn, entry]) => {
      if (this.shouldSendEvent('ldap.add')) {
        void this.sendWebhook('ldap.add', dn, entry);
      }
    },

    ldapmodifydone: async ([dn, changes, _op]) => {
      if (this.shouldSendEvent('ldap.modify')) {
        void this.sendWebhook('ldap.modify', dn, changes);
      }
    },

    ldapdeletedone: async dn => {
      if (this.shouldSendEvent('ldap.delete')) {
        const dnStr = Array.isArray(dn) ? dn.join(', ') : dn;
        void this.sendWebhook('ldap.delete', dnStr, {});
      }
    },
  };

  /**
   * Check if an event should trigger webhook
   */
  private shouldSendEvent(event: string): boolean {
    return this.enabledEvents.has('*') || this.enabledEvents.has(event);
  }

  /**
   * Send webhook notification with retry logic
   */
  private async sendWebhook(
    event: string,
    dn: string,
    data: AttributesList | ModifyRequest
  ): Promise<void> {
    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      dn,
      data,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        await this.sendWebhookRequest(payload);

        // Success
        this.stats.sent++;
        this.stats.lastSent = payload.timestamp;
        this.logger.info(`Webhook sent: ${event} ${dn}`);
        return;
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.retryCount) {
          this.logger.warn(
            `Webhook attempt ${attempt + 1} failed, retrying...`
          );
          await this.delay(1000 * (attempt + 1));
        }
      }
    }

    // All attempts failed
    this.stats.failed++;
    this.stats.lastError = lastError?.message || 'Unknown error';
    this.logger.error(
      `Webhook failed after ${this.retryCount + 1} attempts:`,
      lastError
    );
  }

  /**
   * Send single webhook HTTP request
   */
  private async sendWebhookRequest(payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = this.generateSignature(body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.webhookTimeout);

    try {
      const response = await this.fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'User-Agent': 'LDAP-Rest-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generate HMAC signature for webhook authentication
   */
  private generateSignature(payload: string): string {
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');
  }

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Usage Example

```bash
# Start LDAP-Rest with notification plugin
npx ldap-rest \
  --ldap-base dc=example,dc=com \
  --ldap-url ldap://localhost:389 \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --plugin core/ldap/flatGeneric \
  --ldap-flat-schema ./static/schemas/standard/users.json \
  --plugin core/notification/webhook \
  --webhook-url https://example.com/webhook \
  --webhook-secret mysecret123 \
  --webhook-timeout 5000 \
  --webhook-retry-count 3 \
  --webhook-event ldap.add \
  --webhook-event ldap.modify

# Check webhook stats
curl http://localhost:8081/api/v1/notifications/stats

# Test webhook
curl -X POST http://localhost:8081/api/v1/notifications/test
```

---

## Testing Your Plugin

### Test File Structure

Create tests in `test/plugins/<category>/<pluginName>.test.ts`:

```typescript
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import request from 'supertest';

import { DM } from '../../../src/bin/index';
import NotificationPlugin from '../../../src/plugins/notification/webhook';

describe('NotificationPlugin', function () {
  let server: DM;
  let plugin: NotificationPlugin;

  // Skip tests if environment not configured
  if (!process.env.DM_LDAP_DN || !process.env.DM_LDAP_PWD) {
    console.warn('Skipping NotificationPlugin tests: LDAP not configured');
    // @ts-ignore
    this.skip?.();
    return;
  }

  before(async () => {
    // Create server instance
    server = new DM();

    // Set up command-line args for plugin
    process.argv = [
      'node',
      'test',
      '--plugin',
      'core/notification/webhook',
      '--webhook-url',
      'http://localhost:9999/webhook',
      '--webhook-secret',
      'test-secret',
      '--webhook-event',
      'ldap.add',
    ];

    await server.ready;
    await server.run();

    // Get plugin instance
    plugin = server.loadedPlugins['notification'] as NotificationPlugin;
  });

  after(async () => {
    if (server.server) {
      await new Promise(resolve => server.server!.close(resolve));
    }
  });

  describe('Initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(plugin).to.exist;
      expect(plugin.name).to.equal('notification');
    });

    it('should throw error without required config', () => {
      expect(() => {
        const badServer = new DM();
        new NotificationPlugin(badServer);
      }).to.throw('requires --webhook-url');
    });
  });

  describe('API Endpoints', () => {
    it('should return webhook stats', async () => {
      const response = await request(server.app)
        .get('/api/v1/notifications/stats')
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body.data).to.have.property('sent');
      expect(response.body.data).to.have.property('failed');
      expect(response.body.data).to.have.property('webhookUrl');
    });

    it('should send test webhook', async () => {
      const response = await request(server.app)
        .post('/api/v1/notifications/test')
        .expect(200);

      expect(response.body).to.have.property('success', true);
    });
  });

  describe('Hooks', () => {
    it('should trigger webhook on LDAP add', async () => {
      const testDn = `uid=testuser,${process.env.DM_LDAP_BASE}`;

      // Add test entry
      await server.ldap.add(testDn, {
        objectClass: ['inetOrgPerson'],
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
      });

      // Wait for webhook
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check stats
      const response = await request(server.app)
        .get('/api/v1/notifications/stats')
        .expect(200);

      expect(response.body.data.sent).to.be.greaterThan(0);

      // Cleanup
      await server.ldap.delete(testDn);
    });
  });

  describe('Private Methods', () => {
    it('should check enabled events correctly', () => {
      // Access private method via type assertion for testing
      const shouldSend = (plugin as any).shouldSendEvent('ldap.add');
      expect(shouldSend).to.be.true;
    });
  });
});
```

### Running Tests

See [Tests and checks](../../CONTRIBUTING.md#tests-and-checks).

### Test Best Practices

1. **Use test helpers** from `test/helpers/` for common operations
2. **Clean up** - Delete test entries in `after()` hooks
3. **Skip gracefully** - Skip tests if environment not configured
4. **Mock external services** - Use mock servers for webhooks, APIs
5. **Test error cases** - Verify error handling and validation
6. **Test configuration** - Verify all config options work correctly

---

## Additional Resources

- [Contributing Guide](../../CONTRIBUTING.md) - Git workflow and PR guidelines
- [Hooks Reference](./hooks.md) - Complete list of available hooks
- [Plugin services](./services.md) - Typed interfaces between plugins
- [Core Plugin Examples](../../src/plugins/) - Browse existing plugins
- [Test Examples](../../test/plugins/) - See how core plugins are tested

---

## Support

- **Issues**: https://github.com/linagora/ldap-rest/issues
- **Discussions**: https://github.com/linagora/ldap-rest/discussions

---

## License

By contributing plugins to LDAP-Rest, you agree that your contributions will be licensed under the AGPL-3.0 License.
