/** External users in groups plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const externalUsersOptions = defineOptions({
  external_members_branch: opt.string({
    env: 'DM_EXTERNAL_MEMBERS_BRANCH',
    default: 'ou=contacts,dc=example,dc=com',
  }),
  external_branch_class: opt.array({
    env: 'DM_EXTERNAL_BRANCH_CLASSES',
    default: ['top', 'inetOrgPerson'],
    plural: 'external-branch-classes',
    kind: 'identifiers',
  }),
});
export type ExternalUsersOptions = OptionsOf<typeof externalUsersOptions>;
