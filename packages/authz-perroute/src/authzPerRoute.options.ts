/** Per-route authorization plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const perRouteOptions = defineOptions({
  authz_per_route: opt.array({
    env: 'DM_AUTHZ_PER_ROUTES',
    default: [],
    plural: 'authz-per-routes',
  }),
});
export type PerRouteOptions = OptionsOf<typeof perRouteOptions>;
