# Writing a Plugin

This guide explains how to create a plugin using the API and hooks.

## Getting Started

- Core-plugins: create a new file in the `plugins` directory.
- Other: create your file where you want

## Plugin Structure

See [abstract class](../abstract/plugin.ts) for more

- A plugin is a class with optional **api** methods and/or **hooks** property.
- It should also have a uniq property "**name**".
- It may inherit from [plugin abstract class](../abstract/plugin.ts)
- Its constructor receives one argument _(the server)_ which exposes
  - hooks: an object `{ [K in keyof Hooks]?: Function[] }` where plugin
    can find functions to launch if it exposes hooks
  - ldap: a [LDAP object](../lib/ldapActions.ts)
  - config: the [config](../config/args.ts) given by command-line arguments and environment variables
- It may have a **dependencies** property: _`Record<uniqname, path>`_ of plugins that needs to be loaded before this one

### Expose an API _(or any [express](https://www.npmjs.com/package/express) hook)_

#### Simple

```typescript
import type { Express, Request, Response } from 'express';

import DmPlugin from '../abstract/plugin';

export default class HelloWorld extends DmPlugin {
  name = 'hello';

  api(app: Express): void {
    app.get('/hello', (req: Request, res: Response) => {
      res.json({ message: 'Hello' });
    });
  }
}
```

#### Launch hooks exported by other plugins

Note that exposed hooks has to be documented into [HOOKS](../../HOOKS.md)

```typescript
import type { Express, Request, Response } from 'express';

import DmPlugin from '../abstract/plugin';

export default class HelloWorld extends DmPlugin {
  name = 'hello';

  api(app: Express): void {
    app.get('/hello', (req: Request, res: Response) => {
      const response = { message: 'Hello', hookResults: [] as unknown[] };
      if (this.server.hooks && this.server.hooks['hello']) {
        for (const hook of this.server.hooks['hello']) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          response.hookResults.push(hook());
        }
      }
      res.json(response);
    });
  }
}
```

### Export hooks

Hooks are JS objects that associate a keyword to a function. This function will
be launched by the plugin which exposes this hook.

In the following example, we know that the [helloworld plugin](../plugins/helloworld.ts)
consumes hooks named 'hello' and want functions that return strings and receive no parameters.

```typescript
import type { Express, Request, Response } from 'express';
import type { SearchOptions } from 'ldapts';
import type { Hooks } from '../hooks.ts'; // also exported by this module, see package.json

import DmPlugin from '../abstract/plugin';

export default class HelloWorld extends DmPlugin {
  name = 'hello';
  hooks: Hooks = {
    ldapsearchopts: opts => {
      // change options
      return opts;
    },
  };
}
```
