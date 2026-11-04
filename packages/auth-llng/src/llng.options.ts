/** LemonLDAP::NG authentication plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const llngOptions = defineOptions({
  llng_ini: opt.string({
    env: 'DM_LLNG_INI',
    default: '/etc/lemonldap-ng/lemonldap-ng.ini',
  }),
  llng_username_header: opt.string({
    env: 'DM_LLNG_USERNAME_HEADER',
    default: '',
  }),
});
export type LlngOptions = OptionsOf<typeof llngOptions>;
