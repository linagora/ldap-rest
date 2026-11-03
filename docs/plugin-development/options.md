# Plugin options

A core plugin declares its configuration options next to its code, in a
`<plugin>.options.ts` file. A family that shares imports and lifecycle keeps
one set per plugin in a single `<family>.options.ts` file, named after the
family. The server reads them in two phases: the core options and the
`--plugin` entries first, then the declarations of the named plugins, so a
plugin package the configuration does not name is never imported. The plugin
then reads typed values instead of casting `this.config`.

## Declaring options

```typescript
// src/plugins/example/example.options.ts
import { defineOptions, opt, type OptionsOf } from '../../config/options';

export const exampleOptions = defineOptions({
  example_url: opt.string({
    env: 'DM_EXAMPLE_URL',
    required: true,
  }),
  example_timeout: opt.number({
    env: 'DM_EXAMPLE_TIMEOUT',
    default: 5000,
    min: 1,
  }),
  example_retry: opt.boolean({
    env: 'DM_EXAMPLE_RETRY',
    default: false,
  }),
  example_domains: opt.array({
    env: 'DM_EXAMPLE_DOMAINS',
    default: [],
    plural: 'example-domains',
    kind: 'identifiers',
  }),
});

export type ExampleOptions = OptionsOf<typeof exampleOptions>;
```

The key is the `Config` name: `example_timeout` is `--example-timeout`,
`DM_EXAMPLE_TIMEOUT` when the descriptor names that variable.

### Deprecating an option

Rename an option by giving the old name as an alias: the parser still reads
it, and the server warns once at startup. Keep the alias for two minor
releases, as [CONTRIBUTING.md](../../CONTRIBUTING.md#deprecating-a-published-contract)
requires.

```typescript
export const exampleOptions = defineOptions({
  example_url: opt.string({
    env: 'DM_EXAMPLE_URL',
    aliases: ['example-uri'],
    envAliases: ['DM_EXAMPLE_URI'],
  }),
});
```

A CLI alias takes one value per occurrence, as the singular form does, and an
array option's plural form has no alias: renaming it is a breaking change. An
environment alias is read when `env` is unset, or empty for a type where an
empty value means nothing, and only for a non-array option when its canonical
CLI name is absent; an array option combines the environment value with the
CLI one, so its alias is still read.

Each declaration takes:

| Field        | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `env`        | Environment variable read when the CLI does not set the option        |
| `default`    | Value kept when neither the CLI nor the environment sets the option   |
| `required`   | Refuse an empty value instead of reading it as unset                  |
| `plural`     | Array only: CLI name of the plural form, without the leading `--`     |
| `kind`       | Array only: how a value splits, see `ArrayKind` in `parseConfig.ts`   |
| `min/max`    | Number only: bounds checked when the option is read                   |
| `choices`    | String only: the values the option accepts                            |
| `aliases`    | Former CLI names still accepted, without the leading `--`             |
| `envAliases` | Former environment variables still accepted, read when `env` is unset |

### Reading another plugin's options

Name in `optionDependencies` every module in `dependencies` that declares
options, so phase 1 reads its declarations before the instance loads it. The
loader refuses to start when a dependency declares an option the template does
not carry, and names the module to add:

```typescript
export default class LifecycleEvents extends DmPlugin {
  static optionDefinitions = lifecycleOptions;
  static optionDependencies = ['core/rabbitmq'];
  dependencies = { rabbitmq: 'core/rabbitmq' };
}
```

An option the core or several families read is declared in the core options
(`packages/core/src/config/args.ts`) instead, so it keeps its default, type
and environment variable whether or not the plugin serving it is named.

## Reading options

The plugin names the declaration as a static field, and asks for the values in
its constructor:

```typescript
export default class Example extends DmPlugin {
  static optionDefinitions = exampleOptions;
  name = 'example';

  private readonly settings: ExampleOptions;

  constructor(server: DM) {
    super(server);
    this.settings = this.options(exampleOptions);
  }
}
```

`options(exampleOptions)` applies the defaults, copies array defaults and
checks `required`, `min`, `max` and `choices`. The base constructor asks once,
so a bad value stops the plugin from loading rather than failing at the first
request. Each later call reads the configuration again rather than keeping
the first values. `--plugin example:name:{...}` overrides still work: the view the
plugin receives carries the merged configuration, and `options()` reads that
view. Give it the same declaration object the class names in
`optionDefinitions`: any other one is refused, so the generic type parameter
cannot describe the wrong view.

## Wiring it in

Name the declaration as the plugin class's `optionDefinitions`, as above.
`composeOptions` in `src/options.ts` imports each plugin the `--plugin` entries
name and adds its declarations to the core options; there is no list to edit.
`bin/index.mjs` passes the result to `DM`. A command that needs its feature's
options without starting the server names its own plugin entries:

```javascript
import { DM } from 'ldap-rest';
import { composeOptions } from 'ldap-rest/options';

const dm = new DM(await composeOptions(['core/twake/james']));
```

The `Config` interface in `packages/core/src/config/args.ts` keeps the hand-written fields
until every plugin has moved. A migrated plugin no longer reads them: it uses
`options()`.

A plugin outside the repository declares options the same way: the startup
report subtracts its keys and aliases, and `options()` reads a declared `env`
variable or a deprecated CLI alias the parser did not carry, warning at startup
for the alias as it does for a core option. An option without a declaration
still reaches `this.config` from an unknown `--key value` pair, and the startup
report names it.
