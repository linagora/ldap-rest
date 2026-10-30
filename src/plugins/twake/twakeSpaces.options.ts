/**
 * Twake spaces options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const twakeSpacesOptions = defineOptions({
  twake_space_base: opt.string({ env: 'DM_TWAKE_SPACE_BASE', default: '' }),
  twake_space_class: opt.array({
    env: 'DM_TWAKE_SPACE_CLASS',
    default: ['top', 'twakeSpace'],
    kind: 'identifiers',
  }),
  twake_space_display_name_attribute: opt.string({
    env: 'DM_TWAKE_SPACE_DISPLAY_NAME_ATTRIBUTE',
    default: 'twakeDisplayName',
  }),
  twake_space_admin_attribute: opt.string({
    env: 'DM_TWAKE_SPACE_ADMIN_ATTRIBUTE',
    default: 'twakeSpaceAdmin',
  }),
  twake_space_editor_attribute: opt.string({
    env: 'DM_TWAKE_SPACE_EDITOR_ATTRIBUTE',
    default: 'twakeSpaceEditor',
  }),
  twake_space_viewer_attribute: opt.string({
    env: 'DM_TWAKE_SPACE_VIEWER_ATTRIBUTE',
    default: 'twakeSpaceViewer',
  }),
  twake_space_user_role_attribute: opt.string({
    env: 'DM_TWAKE_SPACE_USER_ROLE_ATTRIBUTE',
    default: '',
  }),
  twake_space_exchange: opt.string({
    env: 'DM_TWAKE_SPACE_EXCHANGE',
    default: 'space',
  }),
  twake_space_sync_queue: opt.string({
    env: 'DM_TWAKE_SPACE_SYNC_QUEUE',
    default: 'twake.space.sync.requested.ldap-rest',
  }),
});

export type TwakeSpacesOptions = OptionsOf<typeof twakeSpacesOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function twakeSpacesOptionsOf(config: Config): TwakeSpacesOptions {
  return readOptions(twakeSpacesOptions, config);
}
