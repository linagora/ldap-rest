# Plugin options

A core plugin declares its configuration options next to its code, in a
`<plugin>.options.ts` file. A family that shares imports and lifecycle keeps
one set per plugin in a single `<family>.options.ts` file, named after the
family. `src/config/args.ts` concatenates those declarations,
so the parser, the command line and the environment variables see the same
entries as before. The plugin then reads typed values instead of casting
`this.config`.

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

Import the declaration in `src/config/args.ts` and spread it where the plugin's
options used to be:

```typescript
import { exampleOptions } from '../plugins/example/example.options';
import { toConfigEntries } from './options';

const configArgs: ConfigTemplate = [
  // ...
  ...toConfigEntries(exampleOptions),
];
```

The `Config` interface keeps the hand-written fields until every plugin has
moved. A migrated plugin no longer reads them: it uses `options()`.

Plugins outside the repository cannot add to `args.ts` yet, but they can
declare options the same way and name them in `optionDefinitions`: the startup
report subtracts those keys and their aliases, and `options()` reads a declared
`env` variable or a deprecated CLI alias the parser did not carry, warning at
startup for the alias as it does for a core option. An option without a
declaration still reaches `this.config` from an unknown `--key value` pair, and
the startup report names it.
