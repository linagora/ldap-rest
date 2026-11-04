/** Trash plugin options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const trashOptions = defineOptions({
  trash_base: opt.string({ env: 'DM_TRASH_BASE', default: '' }),
  trash_watched_bases: opt.string({
    env: 'DM_TRASH_WATCHED_BASES',
    default: '',
  }),
  trash_add_metadata: opt.string({
    env: 'DM_TRASH_ADD_METADATA',
    default: 'true',
  }),
  trash_auto_create: opt.string({
    env: 'DM_TRASH_AUTO_CREATE',
    default: 'true',
  }),
});
export type TrashOptions = OptionsOf<typeof trashOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function trashOptionsOf(config: Config): TrashOptions {
  return readOptions(trashOptions, config);
}
