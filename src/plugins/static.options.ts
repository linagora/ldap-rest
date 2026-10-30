/** Static files plugin options, see `docs/plugin-development/options.md`. */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Config } from '../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../config/options';

/** The headers `core/static` sends unless told otherwise: no framing by another site */
export const STATIC_CSP = "frame-ancestors 'self'";
export const STATIC_FRAME_OPTIONS = 'SAMEORIGIN';

const staticPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'static'
);

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
