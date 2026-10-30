/**
 * Twake groups options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const twakeGroupsOptions = defineOptions({
  twake_group_base: opt.string({ env: 'DM_TWAKE_GROUP_BASE', default: '' }),
  twake_group_user_base: opt.string({
    env: 'DM_TWAKE_GROUP_USER_BASE',
    default: '',
  }),
  twake_group_organization_dn: opt.string({
    env: 'DM_TWAKE_GROUP_ORGANIZATION_DN',
    default: '',
  }),
  twake_group_organization_status_attribute: opt.string({
    env: 'DM_TWAKE_GROUP_ORGANIZATION_STATUS_ATTRIBUTE',
    default: 'twakeOrgStatus',
  }),
  twake_group_organization_deleted_value: opt.string({
    env: 'DM_TWAKE_GROUP_ORGANIZATION_DELETED_VALUE',
    default: 'deleted',
  }),
  twake_group_display_name_attribute: opt.string({
    env: 'DM_TWAKE_GROUP_DISPLAY_NAME_ATTRIBUTE',
    default: 'twakeDisplayName',
  }),
  twake_group_color_attribute: opt.string({
    env: 'DM_TWAKE_GROUP_COLOR_ATTRIBUTE',
    default: 'twakeGroupColor',
  }),
  twake_group_created_at_attribute: opt.string({
    env: 'DM_TWAKE_GROUP_CREATED_AT_ATTRIBUTE',
    default: 'twakeCreatedAt',
  }),
  twake_group_max_page_limit: opt.number({
    env: 'DM_TWAKE_GROUP_MAX_PAGE_LIMIT',
    default: 1000,
    min: 1,
  }),
  twake_group_member_fields: opt.json({
    env: 'DM_TWAKE_GROUP_MEMBER_FIELDS',
    default: {},
  }),
});

export type TwakeGroupsOptions = OptionsOf<typeof twakeGroupsOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function twakeGroupsOptionsOf(config: Config): TwakeGroupsOptions {
  return readOptions(twakeGroupsOptions, config);
}
