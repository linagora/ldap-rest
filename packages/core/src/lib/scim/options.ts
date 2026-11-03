/**
 * SCIM 2.0 plugin options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const scimOptions = defineOptions({
  scim_prefix: opt.string({
    env: 'DM_SCIM_PREFIX',
    default: '/scim/v2',
  }),
  scim_user_base: opt.string({
    env: 'DM_SCIM_USER_BASE',
    default: '',
  }),
  scim_group_base: opt.string({
    env: 'DM_SCIM_GROUP_BASE',
    default: '',
  }),
  scim_user_base_template: opt.string({
    env: 'DM_SCIM_USER_BASE_TEMPLATE',
    default: '',
  }),
  scim_group_base_template: opt.string({
    env: 'DM_SCIM_GROUP_BASE_TEMPLATE',
    default: '',
  }),
  scim_base_map: opt.string({
    env: 'DM_SCIM_BASE_MAP',
    default: '',
  }),
  scim_user_base_header: opt.string({
    env: 'DM_SCIM_USER_BASE_HEADER',
    default: '',
  }),
  scim_group_base_header: opt.string({
    env: 'DM_SCIM_GROUP_BASE_HEADER',
    default: '',
  }),
  scim_base_header_root: opt.string({
    env: 'DM_SCIM_BASE_HEADER_ROOT',
    default: '',
  }),
  scim_user_object_class: opt.array({
    env: 'DM_SCIM_USER_OBJECT_CLASSES',
    default: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
    plural: 'scim-user-object-classes',
    kind: 'identifiers',
  }),
  scim_user_rdn_attribute: opt.string({
    env: 'DM_SCIM_USER_RDN_ATTRIBUTE',
    default: 'uid',
  }),
  scim_user_lock_attribute: opt.string({
    env: 'DM_SCIM_USER_LOCK_ATTRIBUTE',
    default: 'pwdAccountLockedTime',
  }),
  scim_user_lock_value: opt.string({
    env: 'DM_SCIM_USER_LOCK_VALUE',
    default: '',
  }),
  scim_group_object_class: opt.array({
    env: 'DM_SCIM_GROUP_OBJECT_CLASSES',
    default: ['top', 'groupOfNames'],
    plural: 'scim-group-object-classes',
    kind: 'identifiers',
  }),
  scim_group_rdn_attribute: opt.string({
    env: 'DM_SCIM_GROUP_RDN_ATTRIBUTE',
    default: 'cn',
  }),
  scim_group_external_id_attribute: opt.string({
    env: 'DM_SCIM_GROUP_EXTERNAL_ID_ATTRIBUTE',
    default: '',
  }),
  scim_id_attribute: opt.string({
    env: 'DM_SCIM_ID_ATTRIBUTE',
    default: 'rdn',
  }),
  scim_user_mapping: opt.string({
    env: 'DM_SCIM_USER_MAPPING',
    default: '',
  }),
  scim_group_mapping: opt.string({
    env: 'DM_SCIM_GROUP_MAPPING',
    default: '',
  }),
  scim_max_results: opt.number({
    env: 'DM_SCIM_MAX_RESULTS',
    default: 200,
    min: 1,
  }),
  scim_max_scanned: opt.number({
    env: 'DM_SCIM_MAX_SCANNED',
    default: 10000,
    min: 1,
  }),
  scim_bulk_max_operations: opt.number({
    env: 'DM_SCIM_BULK_MAX_OPERATIONS',
    default: 100,
    min: 1,
  }),
  scim_bulk_max_payload_size: opt.number({
    env: 'DM_SCIM_BULK_MAX_PAYLOAD_SIZE',
    default: 1048576,
    min: 1,
  }),
  scim_etag: opt.boolean({
    env: 'DM_SCIM_ETAG',
    default: false,
  }),
  scim_base_url: opt.string({
    env: 'DM_SCIM_BASE_URL',
    default: '',
  }),
});

export type ScimOptions = OptionsOf<typeof scimOptions>;

/** The checked values for a caller outside the plugin that holds a Config */
export function scimOptionsOf(config: Config): ScimOptions {
  return readOptions(scimOptions, config);
}
