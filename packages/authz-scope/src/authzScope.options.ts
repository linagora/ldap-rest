/** Scope authorization plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const authzOptions = defineOptions({
  // The branch-level plugin `authzScope` describes a caller with, when more
  // than one of them judges that caller. Empty: the first one loaded, and
  // the answer lists the others under `sources`.
  authz_scope_source: opt.string({
    env: 'DM_AUTHZ_SCOPE_SOURCE',
    default: '',
  }),
});
export type AuthzOptions = OptionsOf<typeof authzOptions>;
