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
import { schemasPath } from '@ldap-rest/schemas';

/** Where this package's own manifest sits: the search stops past it */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The path of a schema this package names: the copy the deployment serves
 * when it has one, so the static plugin recognises the file, the package's
 * own otherwise. Empty when neither ships it.
 */
const schemaPath = (...parts: string[]): string => {
  let here = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(here, 'static', 'schemas', ...parts);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(here, 'package.json')) && here !== packageRoot) break;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  const packaged = join(schemasPath, ...parts);
  return existsSync(packaged) ? packaged : '';
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
