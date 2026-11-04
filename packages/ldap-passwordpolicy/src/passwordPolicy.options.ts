/** Password policy plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const passwordPolicyOptions = defineOptions({
  ppolicy_default_dn: opt.string({
    env: 'DM_PPOLICY_DEFAULT_DN',
    default: '',
  }),
  ppolicy_base: opt.string({ env: 'DM_PPOLICY_BASE', default: '' }),
  ppolicy_warn_days: opt.number({
    env: 'DM_PPOLICY_WARN_DAYS',
    default: 14,
    min: 1,
  }),
  ppolicy_validate_complexity: opt.boolean({
    env: 'DM_PPOLICY_VALIDATE_COMPLEXITY',
    default: false,
  }),
  ppolicy_min_length: opt.number({
    env: 'DM_PPOLICY_MIN_LENGTH',
    default: 12,
    min: 1,
  }),
  ppolicy_require_uppercase: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_UPPERCASE',
    default: true,
  }),
  ppolicy_require_lowercase: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_LOWERCASE',
    default: true,
  }),
  ppolicy_require_digit: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_DIGIT',
    default: true,
  }),
  ppolicy_require_special: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_SPECIAL',
    default: true,
  }),
  ldap_users_base: opt.string({ env: 'DM_LDAP_USERS_BASE', default: '' }),
});
export type PasswordPolicyOptions = OptionsOf<typeof passwordPolicyOptions>;
