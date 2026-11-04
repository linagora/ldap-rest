/** Groups plugin options. */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Config } from '@ldap-rest/core/config/args';
import type { AttributesList } from '@ldap-rest/core/lib/ldapActions';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

/**
 * The path of a schema the umbrella ships. The schemas have no package of
 * their own yet, so `static/schemas` is searched upwards: it is found whether
 * this module runs from its sources, from its own build, or from the copy the
 * umbrella bundles in its tarball.
 */
const schemaPath = (...parts: string[]): string => {
  let here = dirname(fileURLToPath(import.meta.url));
  let candidate = join(here, 'static', 'schemas', ...parts);
  while (!existsSync(candidate) && dirname(here) !== here) {
    here = dirname(here);
    candidate = join(here, 'static', 'schemas', ...parts);
  }
  return candidate;
};

export const groupsOptions = defineOptions({
  ldap_group_base: opt.string({ env: 'DM_LDAP_GROUP_BASE', default: '' }),
  ldap_groups_main_attribute: opt.string({
    env: 'DM_LDAP_GROUPS_MAIN_ATTRIBUTE',
    default: 'cn',
  }),
  group_class: opt.array({
    env: 'DM_GROUP_CLASSES',
    default: ['top', 'groupOfNames'],
    plural: 'group-classes',
    kind: 'identifiers',
  }),
  groups_allow_unexistent_members: opt.boolean({
    env: 'DM_ALLOW_UNEXISTENT_MEMBERS',
    default: false,
  }),
  group_default_attributes: opt.json<AttributesList>({
    env: 'DM_GROUP_DEFAULT_ATTRIBUTES',
    default: {},
  }),
  group_dummy_user: opt.string({
    env: 'DM_GROUP_DUMMY_USER',
    default: 'cn=fakeuser',
    emptyIsValue: true,
  }),
  group_schema: opt.string({
    env: 'DM_GROUP_SCHEMA',
    default: schemaPath('twake', 'groups.json'),
    emptyIsValue: true,
  }),
});
export type GroupsOptions = OptionsOf<typeof groupsOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function groupsOptionsOf(config: Config): GroupsOptions {
  return readOptions(groupsOptions, config);
}
