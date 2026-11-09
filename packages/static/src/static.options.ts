/** Static files plugin options, see `docs/plugin-development/options.md`. */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

/** The headers `core/static` sends unless told otherwise: no framing by another site */
export const STATIC_CSP = "frame-ancestors 'self'";
export const STATIC_FRAME_OPTIONS = 'SAMEORIGIN';

/** Where this package's own manifest sits: the search stops past it */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `static` directory the umbrella ships: the repository root when this
 * package runs from its sources, the `ldap-rest` package beside the
 * `@ldap-rest` scope once installed. It is never this package's own
 * directory, which holds the plugin and no assets, and it does not depend on
 * the tree being composed already: the Dockerfile is generated from it before
 * a build.
 */
const shippedStaticPath = (): string => {
  for (let here = packageRoot; ; here = dirname(here)) {
    const manifest = join(here, 'package.json');
    if (existsSync(manifest)) {
      try {
        const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string;
        };
        if (name === 'ldap-rest') return join(here, 'static');
      } catch {
        // An unreadable manifest is not the umbrella: keep looking upwards
      }
    }
    if (dirname(here) === here) break;
  }
  // Installed: <modules>/@ldap-rest/static → <modules>/ldap-rest/static
  return join(packageRoot, '..', '..', 'ldap-rest', 'static');
};

const staticPath = shippedStaticPath();

export const staticOptions = defineOptions({
  static_path: opt.string({
    env: 'DM_STATIC_PATH',
    default: staticPath,
  }),
  static_name: opt.string({
    env: 'DM_STATIC_NAME',
    default: 'static',
  }),
  static_csp: opt.stringOrFalse({
    env: 'DM_STATIC_CSP',
    default: STATIC_CSP,
  }),
  static_frame_options: opt.stringOrFalse({
    env: 'DM_STATIC_FRAME_OPTIONS',
    default: STATIC_FRAME_OPTIONS,
  }),
});
export type StaticOptions = OptionsOf<typeof staticOptions>;

export function staticOptionsOf(config: Config): StaticOptions {
  return readOptions(staticOptions, config);
}
