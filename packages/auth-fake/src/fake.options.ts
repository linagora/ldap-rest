/** Fake authentication plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const fakeOptions = defineOptions({
  auth_fake_user: opt.string({ env: 'DM_AUTH_FAKE_USER', default: '' }),
});
export type FakeOptions = OptionsOf<typeof fakeOptions>;
