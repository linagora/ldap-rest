/**
 * Where the static plugins serve a schema file, for another plugin to
 * announce it
 * @module lib/staticFiles
 */
import type { DM } from '../bin';

/** A static plugin, as another plugin asks it where it serves a file */
export interface StaticFiles {
  schemaUrlOf(file: string): string | undefined;
  servedPath(): string;
}

/** Told by its methods, not its class: another copy of ldap-rest has its own */
export const isStaticFiles = (plugin: unknown): plugin is StaticFiles =>
  typeof (plugin as Partial<StaticFiles>).schemaUrlOf === 'function' &&
  typeof (plugin as Partial<StaticFiles>).servedPath === 'function';

/**
 * The static plugins loaded, whatever their class or name: one loaded under
 * another name, or with a name or a directory of its own, serves files
 * elsewhere or not at all. The one registered as `static` comes first; one
 * whose path an earlier plugin took, or lies under it, is left out, the
 * earlier one's routes answering first.
 *
 * @param server the server whose plugins are asked
 * @returns the plugins, in the order to ask them
 */
export function staticPlugins(
  server: Pick<DM, 'loadedPlugins'>
): StaticFiles[] {
  const taken: string[] = [];
  const statics: StaticFiles[] = [];
  for (const plugin of Object.values(server.loadedPlugins)) {
    if (!isStaticFiles(plugin)) continue;
    // Express matches paths regardless of case
    const path = plugin.servedPath().toLowerCase();
    if (taken.some(other => (path + '/').startsWith(other + '/'))) continue;
    taken.push(path);
    statics.push(plugin);
  }
  return statics.sort(
    (a, b) =>
      Number((b as { name?: string }).name === 'static') -
      Number((a as { name?: string }).name === 'static')
  );
}

/**
 * URL a static plugin serves a schema file at, merged, asked of
 * {@link staticPlugins} in their order
 *
 * @param server the server whose plugins are asked
 * @param file the file, as the plugin announcing it reads it
 * @returns its URL, or undefined when no static plugin serves it merged
 */
export function staticSchemaUrl(
  server: Pick<DM, 'loadedPlugins'>,
  file: string
): string | undefined {
  for (const plugin of staticPlugins(server)) {
    const url = plugin.schemaUrlOf(file);
    if (url) return url;
  }
  return undefined;
}
