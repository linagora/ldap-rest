/**
 * Twake tombstone options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const twakeTombstoneOptions = defineOptions({
  twake_tombstone_dn: opt.array({
    env: 'DM_TWAKE_TOMBSTONE_DN',
    default: [],
    kind: 'dns',
  }),
  twake_tombstone_default_reason: opt.string({
    env: 'DM_TWAKE_TOMBSTONE_DEFAULT_REASON',
    default: 'deleted',
  }),
  twake_tombstone_reason_header: opt.string({
    env: 'DM_TWAKE_TOMBSTONE_REASON_HEADER',
    default: 'x-deletion-reason',
  }),
  twake_tombstone_reasons: opt.array({
    env: 'DM_TWAKE_TOMBSTONE_REASONS',
    default: [],
    kind: 'identifiers',
  }),
  twake_tombstone_clear_attributes: opt.array({
    env: 'DM_TWAKE_TOMBSTONE_CLEAR_ATTRIBUTES',
    default: [],
    kind: 'identifiers',
  }),
  twake_tombstone_erase_min_age: opt.number({
    env: 'DM_TWAKE_TOMBSTONE_ERASE_MIN_AGE',
    default: 2592000,
  }),
  twake_tombstone_group_bases: opt.array({
    env: 'DM_TWAKE_TOMBSTONE_GROUP_BASES',
    default: [],
    kind: 'dns',
  }),
});

export type TwakeTombstoneOptions = OptionsOf<typeof twakeTombstoneOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function twakeTombstoneOptionsOf(config: Config): TwakeTombstoneOptions {
  return readOptions(twakeTombstoneOptions, config);
}
