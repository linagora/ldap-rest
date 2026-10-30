/**
 * Cloudery provisioning options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const clouderyOptions = defineOptions({
  cloudery_manager_url: opt.string({
    env: 'DM_CLOUDERY_MANAGER_URL',
    default: '',
  }),
  cloudery_manager_token: opt.string({
    env: 'DM_CLOUDERY_MANAGER_TOKEN',
    default: '',
  }),
  cloudery_offer: opt.string({
    env: 'DM_CLOUDERY_OFFER',
    default: 'b2b_twake_default',
  }),
  cloudery_domain: opt.string({ env: 'DM_CLOUDERY_DOMAIN', default: '' }),
  cloudery_user_branch: opt.string({
    env: 'DM_CLOUDERY_USER_BRANCH',
    default: '',
  }),
  cloudery_org_id_header: opt.string({
    env: 'DM_CLOUDERY_ORG_ID_HEADER',
    default: 'x-cloudery-org-id',
  }),
  cloudery_org_role_header: opt.string({
    env: 'DM_CLOUDERY_ORG_ROLE_HEADER',
    default: 'x-cloudery-org-role',
  }),
  cloudery_default_org_role: opt.string({
    env: 'DM_CLOUDERY_DEFAULT_ORG_ROLE',
    default: 'member',
  }),
  cloudery_fqdn_attribute: opt.string({
    env: 'DM_CLOUDERY_FQDN_ATTRIBUTE',
    default: 'twakeWorkspaceUrl',
  }),
  cloudery_org_id_attribute: opt.string({
    env: 'DM_CLOUDERY_ORG_ID_ATTRIBUTE',
    default: 'twakeOrganizationId',
  }),
  cloudery_org_role_attribute: opt.string({
    env: 'DM_CLOUDERY_ORG_ROLE_ATTRIBUTE',
    default: 'twakeOrganizationRole',
  }),
  cloudery_phones_attribute: opt.string({
    env: 'DM_CLOUDERY_PHONES_ATTRIBUTE',
    default: 'twakePhones',
  }),
  cloudery_invited_attribute: opt.string({
    env: 'DM_CLOUDERY_INVITED_ATTRIBUTE',
    default: 'twakeInvited',
  }),
  cloudery_default_locale: opt.string({
    env: 'DM_CLOUDERY_DEFAULT_LOCALE',
    default: 'en',
  }),
  cloudery_workflow_poll_interval_ms: opt.number({
    env: 'DM_CLOUDERY_WORKFLOW_POLL_INTERVAL_MS',
    default: 2000,
    min: 1,
  }),
  cloudery_workflow_max_attempts: opt.number({
    env: 'DM_CLOUDERY_WORKFLOW_MAX_ATTEMPTS',
    default: 60,
    min: 1,
  }),
});

export type ClouderyOptions = OptionsOf<typeof clouderyOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function clouderyOptionsOf(config: Config): ClouderyOptions {
  return readOptions(clouderyOptions, config);
}
