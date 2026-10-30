/** Keyed storage plugin options. */
import type { Config } from '../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../config/options';

export const storageOptions = defineOptions({
  storage_backend: opt.string({ env: 'DM_STORAGE_BACKEND', default: '' }),
  storage_sweep_interval: opt.number({
    env: 'DM_STORAGE_SWEEP_INTERVAL',
    default: 600,
  }),
  storage_ldap_base: opt.string({
    env: 'DM_STORAGE_LDAP_BASE',
    default: '',
  }),
  storage_ldap_object_class: opt.string({
    env: 'DM_STORAGE_LDAP_OBJECT_CLASS',
    default: 'applicationProcess',
  }),
  storage_file_directory: opt.string({
    env: 'DM_STORAGE_FILE_DIRECTORY',
    default: '',
  }),
  storage_postgres_url: opt.string({
    env: 'DM_STORAGE_POSTGRES_URL',
    default: '',
  }),
  storage_postgres_table: opt.string({
    env: 'DM_STORAGE_POSTGRES_TABLE',
    default: 'ldap_rest_storage',
  }),
  storage_valkey_url: opt.string({
    env: 'DM_STORAGE_VALKEY_URL',
    default: '',
  }),
  storage_valkey_prefix: opt.string({
    env: 'DM_STORAGE_VALKEY_PREFIX',
    default: 'ldap-rest:',
    emptyIsValue: true,
  }),
});
export type StorageOptions = OptionsOf<typeof storageOptions>;

export function storageOptionsOf(config: Config): StorageOptions {
  return readOptions(storageOptions, config);
}
