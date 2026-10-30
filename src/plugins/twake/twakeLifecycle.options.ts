/**
 * Account lifecycle options, shared by the Twake lifecycle plugins. See
 * `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const twakeLifecycleOptions = defineOptions({
  twake_lifecycle_role_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_ROLE_ATTRIBUTE',
    default: '',
  }),
  twake_lifecycle_lock_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_LOCK_ATTRIBUTE',
    default: '',
  }),
  twake_lifecycle_lock_value: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_LOCK_VALUE',
    default: '',
  }),
  twake_lifecycle_deleted_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_DELETED_ATTRIBUTE',
    default: '',
  }),
  twake_lifecycle_deleted_value: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_DELETED_VALUE',
    default: 'TRUE',
  }),
  twake_lifecycle_deleted_at_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_DELETED_AT_ATTRIBUTE',
    default: '',
  }),
  twake_lifecycle_deleted_at_format: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_DELETED_AT_FORMAT',
    default: 'iso8601',
  }),
  twake_lifecycle_reason_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_REASON_ATTRIBUTE',
    default: '',
  }),
  twake_lifecycle_rules: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_RULES',
    default: '',
  }),
  twake_lifecycle_member_attribute: opt.string({
    env: 'DM_TWAKE_LIFECYCLE_MEMBER_ATTRIBUTE',
    default: 'member',
  }),
});

export type TwakeLifecycleOptions = OptionsOf<typeof twakeLifecycleOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function twakeLifecycleOptionsOf(config: Config): TwakeLifecycleOptions {
  return readOptions(twakeLifecycleOptions, config);
}
