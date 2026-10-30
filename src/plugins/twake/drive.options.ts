/**
 * Twake Drive plugin options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const driveOptions = defineOptions({
  twake_drive_webadmin_url: opt.string({
    env: 'DM_TWAKE_DRIVE_WEBADMIN_URL',
    default: '',
  }),
  twake_drive_webadmin_token: opt.string({
    env: 'DM_TWAKE_DRIVE_WEBADMIN_TOKEN',
    default: '',
  }),
  twake_drive_concurrency: opt.number({
    env: 'DM_TWAKE_DRIVE_CONCURRENCY',
    default: 10,
    min: 1,
  }),
  twake_drive_domain_attribute: opt.string({
    env: 'DM_TWAKE_DRIVE_DOMAIN_ATTRIBUTE',
    default: 'twakeCozyDomain',
  }),
  twake_drive_default_domain_template: opt.string({
    env: 'DM_TWAKE_DRIVE_DEFAULT_DOMAIN_TEMPLATE',
    default: '',
  }),
});

export type DriveOptions = OptionsOf<typeof driveOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function driveOptionsOf(config: Config): DriveOptions {
  return readOptions(driveOptions, config);
}
