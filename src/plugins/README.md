# Writing a Plugin

This guide explains how to create a plugin using the API and hooks.

## Getting Started

- Core-plugins: create a new file in the `plugins` directory.
- Other: create your file where you want

## Plugin Structure

A plugin typically exports an object with optional `api` methods and/or `hooks`.

### Export an API _(or any [express](https://www.npmjs.com/package/express) hook)_

#### Simple

```typescript
const api = (app: Express, caller: DM): void => {
  // Register an API into express object
  app.get('/hello', (req: Request, res: Response) => {
    res.json(response);
  });
};

export { api };
```

#### Launch hooks exported by other plugins

Note that exposed hooks has to be documented into [HOOKS](../../HOOKS.md)

```typescript
const api = (app: Express, caller: DM): void => {
  // Store caller object if you expose hooks
  server = caller;

  // Register an API
  app.get('/hello', (req: Request, res: Response) => {
    const params = []; //<your parameters for hooks>;
    // You can call other plugins hooks if the hook name matches
    if (server.hooks && server.hooks['myHook']) {
      for (const hook of server.hooks['myHook']) {
        const result = hook(...params);
        // Then do what you want
      }
    }
    res.json(response);
  });
};

export { api };
```

### Export hooks

Hooks are JS objects that associate a keyword to a function. This function will
be launched by the plugin which exposes this hook.

In the following example, we know that the [helloworld plugin](../plugins/helloworld.ts)
consumes hooks named 'hello' and want functions that return strings and receive no parameters.

```typescript
const hooks = {
  hello: (): string => {
    return 'This my hello kook result';
  },
};
```
