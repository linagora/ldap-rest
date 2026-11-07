/**
 * The JSON schemas LDAP-Rest ships, and where they live.
 *
 * A plugin that names one of them when its options are read joins this
 * directory rather than searching the tree: the package is the one that
 * ships the file.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** The `static/schemas` directory this package ships. */
export const schemasPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'static',
  'schemas'
);
