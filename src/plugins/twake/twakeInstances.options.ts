/**
 * Twake instances options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const twakeInstancesOptions = defineOptions({
  twake_instance_dn: opt.array({
    env: 'DM_TWAKE_INSTANCE_DN',
    default: [],
    kind: 'dns',
  }),
  twake_instance_skip_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_SKIP_ATTRIBUTE',
    default: '',
  }),
  twake_instance_skip_value: opt.string({
    env: 'DM_TWAKE_INSTANCE_SKIP_VALUE',
    default: '',
  }),
  twake_instance_provider: opt.string({
    env: 'DM_TWAKE_INSTANCE_PROVIDER',
    default: 'cloudery',
  }),
  twake_instance_id: opt.string({
    env: 'DM_TWAKE_INSTANCE_ID',
    default: '{uid}',
  }),
  twake_instance_fqdn_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_FQDN_ATTRIBUTE',
    default: 'twakeWorkspaceUrl',
  }),
  twake_instance_sent_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_SENT_ATTRIBUTE',
    default: 'twakeCreatedEventAt',
  }),
  twake_instance_locale: opt.string({
    env: 'DM_TWAKE_INSTANCE_LOCALE',
    default: '',
  }),
  twake_instance_timeout: opt.number({
    env: 'DM_TWAKE_INSTANCE_TIMEOUT',
    default: 30000,
    min: 1,
  }),
  twake_instance_cloudery_url: opt.string({
    env: 'DM_TWAKE_INSTANCE_CLOUDERY_URL',
    default: '',
  }),
  twake_instance_cloudery_token: opt.string({
    env: 'DM_TWAKE_INSTANCE_CLOUDERY_TOKEN',
    default: '',
  }),
  twake_instance_cloudery_offer: opt.string({
    env: 'DM_TWAKE_INSTANCE_CLOUDERY_OFFER',
    default: 'b2b_twake_default',
    emptyIsValue: true,
  }),
  twake_instance_cloudery_domain: opt.string({
    env: 'DM_TWAKE_INSTANCE_CLOUDERY_DOMAIN',
    default: '',
  }),
  twake_instance_cloudery_organization_offer: opt.string({
    env: 'DM_TWAKE_INSTANCE_CLOUDERY_ORGANIZATION_OFFER',
    default: '',
  }),
  twake_instance_cozy_url: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_URL',
    default: '',
  }),
  twake_instance_cozy_user: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_USER',
    default: 'admin',
  }),
  twake_instance_cozy_passphrase: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_PASSPHRASE',
    default: '',
  }),
  twake_instance_cozy_domain: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_DOMAIN',
    default: '',
  }),
  twake_instance_cozy_context: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_CONTEXT',
    default: 'default',
    emptyIsValue: true,
  }),
  twake_instance_cozy_apps: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_APPS',
    default: 'home,drive,settings,notes,dataproxy',
    emptyIsValue: true,
  }),
  twake_instance_cozy_org_id: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_ORG_ID',
    default: '',
  }),
  twake_instance_cozy_org_domain: opt.string({
    env: 'DM_TWAKE_INSTANCE_COZY_ORG_DOMAIN',
    default: '',
  }),
  twake_instance_auth_exchange: opt.string({
    env: 'DM_TWAKE_INSTANCE_AUTH_EXCHANGE',
    default: 'auth',
  }),
  twake_instance_b2b_exchange: opt.string({
    env: 'DM_TWAKE_INSTANCE_B2B_EXCHANGE',
    default: 'b2b',
  }),
  twake_instance_user_created_key: opt.string({
    env: 'DM_TWAKE_INSTANCE_USER_CREATED_KEY',
    default: 'user.created',
  }),
  twake_instance_organization_created_key: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_CREATED_KEY',
    default: 'organization.created',
  }),
  twake_instance_workplace_created_key: opt.string({
    env: 'DM_TWAKE_INSTANCE_WORKPLACE_CREATED_KEY',
    default: 'workplace.created',
  }),
  twake_instance_queue: opt.string({
    env: 'DM_TWAKE_INSTANCE_QUEUE',
    default: 'workplace.created.ldap-rest',
  }),
  twake_instance_organization_base: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_BASE',
    default: '',
  }),
  twake_instance_organization_id_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_ID_ATTRIBUTE',
    default: 'ou',
  }),
  twake_instance_organization_domain_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_DOMAIN_ATTRIBUTE',
    default: 'twakeDomain',
  }),
  twake_instance_organization_name_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_NAME_ATTRIBUTE',
    default: 'description',
  }),
  twake_instance_organization_fqdn_attribute: opt.string({
    env: 'DM_TWAKE_INSTANCE_ORGANIZATION_FQDN_ATTRIBUTE',
    default: '',
  }),
});

export type TwakeInstancesOptions = OptionsOf<typeof twakeInstancesOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function twakeInstancesOptionsOf(config: Config): TwakeInstancesOptions {
  return readOptions(twakeInstancesOptions, config);
}
