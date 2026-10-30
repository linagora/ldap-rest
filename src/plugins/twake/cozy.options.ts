/**
 * Cozy provisioning options, shared by `cozyProvision` and
 * `clouderyProvision`. See `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const cozyOptions = defineOptions({
  cozy_admin_url: opt.string({ env: 'DM_COZY_ADMIN_URL', default: '' }),
  cozy_admin_user: opt.string({ env: 'DM_COZY_ADMIN_USER', default: 'admin' }),
  cozy_admin_passphrase: opt.string({
    env: 'DM_COZY_ADMIN_PASSPHRASE',
    default: '',
  }),
  cozy_org_id: opt.string({ env: 'DM_COZY_ORG_ID', default: '' }),
  cozy_org_domain: opt.string({ env: 'DM_COZY_ORG_DOMAIN', default: '' }),
  cozy_default_locale: opt.string({
    env: 'DM_COZY_DEFAULT_LOCALE',
    default: 'fr',
  }),
  cozy_context_name: opt.string({
    env: 'DM_COZY_CONTEXT_NAME',
    default: 'default',
  }),
  cozy_apps: opt.string({
    env: 'DM_COZY_APPS',
    default: 'home,drive,settings,notes,dataproxy',
    emptyIsValue: true,
  }),
  cozy_auth_exchange: opt.string({
    env: 'DM_COZY_AUTH_EXCHANGE',
    default: 'auth',
  }),
  cozy_b2b_exchange: opt.string({
    env: 'DM_COZY_B2B_EXCHANGE',
    default: 'b2b',
  }),
  cozy_user_created_routing_key: opt.string({
    env: 'DM_COZY_USER_CREATED_ROUTING_KEY',
    default: 'user.created',
  }),
  cozy_user_deleted_routing_key: opt.string({
    env: 'DM_COZY_USER_DELETED_ROUTING_KEY',
    default: 'domain.user.deleted',
    emptyIsValue: true,
  }),
});

export type CozyOptions = OptionsOf<typeof cozyOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function cozyOptionsOf(config: Config): CozyOptions {
  return readOptions(cozyOptions, config);
}
