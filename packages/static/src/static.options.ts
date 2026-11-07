/** Static files plugin options, see `docs/plugin-development/options.md`. */
import { existsSync } from 'fs';
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
 * The `static` directory the umbrella ships, recognised by its `schemas`
 * sub-directory. It belongs to the deployment, not to this package, so it is
 * searched upwards: it is found whether this module runs from its sources,
 * from its own build, or from the copy the umbrella bundles in its tarball.
 * The search stops at the first `package.json` that is not this package's,
 * and answers empty when the directory is not there.
 */
const shippedStaticPath = (): string => {
  let here = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(here, 'static');
    if (existsSync(join(candidate, 'schemas'))) return candidate;
    if (existsSync(join(here, 'package.json')) && here !== packageRoot)
      return '';
    const parent = dirname(here);
    if (parent === here) return '';
    here = parent;
  }
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
