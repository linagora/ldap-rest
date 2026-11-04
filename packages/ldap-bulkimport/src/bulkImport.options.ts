/** Bulk import plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const bulkImportOptions = defineOptions({
  bulk_import_schemas: opt.string({
    env: 'DM_BULK_IMPORT_SCHEMAS',
    default: '',
  }),
  bulk_import_max_file_size: opt.string({
    env: 'DM_BULK_IMPORT_MAX_FILE_SIZE',
    default: '10485760',
  }),
  bulk_import_batch_size: opt.string({
    env: 'DM_BULK_IMPORT_BATCH_SIZE',
    default: '100',
  }),
});
export type BulkImportOptions = OptionsOf<typeof bulkImportOptions>;
