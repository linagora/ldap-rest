/** Back-Channel Logout plugin options. */
import type { Config } from '../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../config/options';

export const bclOptions = defineOptions({
  bcl_retention: opt.number({
    env: 'DM_BCL_RETENTION',
    default: 604800,
    min: 1,
  }),
});
export type BclOptions = OptionsOf<typeof bclOptions>;

export function bclOptionsOf(config: Config): BclOptions {
  return readOptions(bclOptions, config);
}
