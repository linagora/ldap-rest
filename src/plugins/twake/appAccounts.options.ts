/**
 * Applicative accounts options, shared by `appAccountsApi` and
 * `appAccountsConsistency`. See `docs/plugin-development/options.md`.
 */
import { defineOptions, opt, type OptionsOf } from '../../config/options';

export const appAccountsOptions = defineOptions({
  applicative_account_base: opt.string({
    env: 'DM_APPLICATIVE_ACCOUNT_BASE',
    default: '',
  }),
  max_app_accounts: opt.number({
    env: 'DM_MAX_APP_ACCOUNTS',
    default: 5,
  }),
  app_accounts_user_attribute: opt.string({
    env: 'DM_APP_ACCOUNTS_USER_ATTRIBUTE',
    default: '',
  }),
  applicative_account_attribute: opt.array({
    env: 'DM_APPLICATIVE_ACCOUNT_ATTRIBUTES',
    default: [
      'objectClass',
      'cn',
      'sn',
      'givenName',
      'displayName',
      'description',
    ],
    plural: 'applicative-account-attributes',
    kind: 'identifiers',
  }),
  ldap_operational_attribute: opt.array({
    env: 'DM_LDAP_OPERATIONAL_ATTRIBUTES',
    default: [
      'dn',
      'controls',
      'structuralObjectClass',
      'entryUUID',
      'entryDN',
      'subschemaSubentry',
      'modifyTimestamp',
      'modifiersName',
      'createTimestamp',
      'creatorsName',
      'userPassword',
    ],
    plural: 'ldap-operational-attributes',
    kind: 'identifiers',
  }),
});

export type AppAccountsOptions = OptionsOf<typeof appAccountsOptions>;
