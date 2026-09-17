/**
 * Directory console — an administration interface built from what the server
 * advertises.
 *
 * ```html
 * <div id="console"></div>
 * <script type="module">
 *   import { DirectoryConsole } from '/static/browser/directory-console.esm.js';
 *   await new DirectoryConsole({ containerId: 'console' }).init();
 * </script>
 * ```
 *
 * @module browser/directory-console
 */

import './styles.css';

export { DirectoryConsole } from './DirectoryConsole';
export {
  ConsoleApiClient,
  hasRole,
  roleAttribute,
} from './api/ConsoleApiClient';
export { EntityForm } from './components/EntityForm';
export { EntityList, SEARCH_MINIMUM, csvCell } from './components/EntityList';
export { EntityDetail } from './components/EntityDetail';
export { OrganizationTree } from './components/OrganizationTree';
export { Translator, availableLanguages } from './i18n';
export type {
  ConsoleOptions,
  EntityDescriptor,
  EntitySchema,
  Entry,
  OrganizationNode,
  Scope,
  SchemaAttribute,
} from './types';
