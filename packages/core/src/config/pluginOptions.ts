/**
 * The option declarations of the plugins a configuration names.
 *
 * The template is read in two phases: the core options and the `--plugin`
 * entries first, then the declarations of those plugins. A plugin package the
 * configuration does not name is never imported. See
 * `docs/development/modularization-plan.md`.
 */
import { join, resolve } from 'path';

import type { ConfigEntry } from '../lib/parseConfig';
import { splitValue } from '../lib/parseConfig';

import { toConfigEntries, type OptionSet } from './options';

/** A plugin class, or the module that exports it */
interface PluginClass {
  optionDefinitions?: OptionSet;
  /** Modules whose options this plugin reads, besides its own */
  optionDependencies?: readonly string[];
}

interface PluginModule extends PluginClass {
  default?: PluginClass;
}

/** A class and its bases, base first */
function optionChain(plugin: PluginClass): PluginClass[] {
  const chain: PluginClass[] = [];
  let current: unknown = plugin;
  while (current && current !== Function.prototype) {
    chain.unshift(current as PluginClass);
    current = Object.getPrototypeOf(current) as unknown;
  }
  return chain;
}

/**
 * The declarations a plugin class carries, its parents' included: a subclass
 * that overrides `optionDefinitions` still reads what its base declared.
 */
export function optionDefinitionsOf(plugin: PluginClass): OptionSet {
  const merged: OptionSet = {};
  for (const entry of optionChain(plugin))
    Object.assign(merged, entry.optionDefinitions ?? {});
  return merged;
}

/** Every module a plugin class and its bases read options from */
export function optionDependenciesOf(plugin: PluginClass): string[] {
  return [
    ...new Set(
      optionChain(plugin).flatMap(entry => entry.optionDependencies ?? [])
    ),
  ];
}

/** The module part of a `--plugin` entry: `module:name:{json}` keeps `module` */
export function entryModule(entry: string): string {
  const separator = entry.indexOf(':');
  return separator === -1 ? entry : entry.slice(0, separator);
}

/** Where the core and the umbrella look for `core/x` and relative entries */
export interface PluginRoots {
  /** Directory `core/x` names, without the trailing slash */
  pluginRoot?: string;
  /** Directory a relative entry resolves from */
  resolveBase: string;
}

/**
 * Where a module name resolves, as `import()` would resolve it: an absolute
 * path for `core/x` and a relative entry, the package name otherwise.
 */
export function resolvePluginModule(
  module: string,
  { pluginRoot, resolveBase }: PluginRoots
): string {
  if (module.startsWith('core/')) {
    if (!pluginRoot)
      throw new Error(
        `Cannot resolve ${module}: no plugin root was given to the server`
      );
    return join(pluginRoot, `${module.slice('core/'.length)}.js`);
  }
  if (module.startsWith('.')) return resolve(resolveBase, module);
  return module;
}

/**
 * The `--plugin` and `--plugins` values of a command line, then `DM_PLUGINS`.
 * Read before the full template exists, so it repeats the core entry's
 * separator rules instead of going through the parser.
 */
export function pluginEntriesFrom(
  argv: string[] = process.argv,
  env: typeof process.env = process.env
): string[] {
  // The parser reads an array option's environment value before appending the
  // command-line ones, so a plugin's place in the list follows the same order.
  // `--plugins` is the plural form: it splits on whitespace too.
  const entries: string[] = [];
  const envValue = env.DM_PLUGINS;
  if (envValue !== undefined && envValue.trim() !== '')
    entries.push(...splitValue(envValue, 'identifiers', 'plural'));
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] !== '--plugin' && argv[i] !== '--plugins') continue;
    const value = argv[i + 1];
    if (value === undefined || value.trim() === '')
      throw new Error(
        `Error in command line: ${argv[i]} has an empty value. Leave it out ` +
          'to keep the default'
      );
    entries.push(
      ...splitValue(
        value,
        'identifiers',
        argv[i] === '--plugins' ? 'plural' : 'singular'
      )
    );
    i++;
  }
  return entries;
}

/**
 * The declarations a named plugin exports next to its class.
 *
 * `load` defaults to the dynamic import the server uses; a test that runs the
 * sources under `tsx/cjs` supplies its own, as the ESM loader cannot read a
 * `.ts` file there.
 */
export async function pluginOptionEntries(
  entries: readonly string[],
  roots: PluginRoots,
  load: (specifier: string) => Promise<PluginModule> = specifier =>
    import(specifier)
): Promise<ConfigEntry[]> {
  const seenModules = new Set<string>();
  const seenOptions = new Set<string>();
  const config: ConfigEntry[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const module = entryModule(queue.shift() as string);
    if (seenModules.has(module)) continue;
    seenModules.add(module);
    // The loader resolves an absolute path as `DM.loadPlugin` does; a package
    // name stays a bare specifier for node.
    const imported = await load(resolvePluginModule(module, roots));
    const plugin = imported.default ?? imported;
    for (const option of toConfigEntries(optionDefinitionsOf(plugin)))
      if (!seenOptions.has(option[0])) {
        seenOptions.add(option[0]);
        config.push(option);
      }
    // A plugin reads the options of what it depends on before registering it,
    // so phase 1 reads those declarations too.
    queue.push(...optionDependenciesOf(plugin));
  }
  return config;
}
