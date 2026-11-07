/**
 * `core/scim` resolves to `plugins/scim.js`, so the documented short name
 * needs a module beside the plugin's own `scim/` directory.
 */
export * from './scim/scim.js';
export { default } from './scim/scim.js';
