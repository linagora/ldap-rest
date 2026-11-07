/**
 * The SCIM plugin, at its historical short path (`core/scim`).
 *
 * A pure re-export alias: it crosses the misc/scim family boundary so the
 * short name the documentation gives resolves. `core/…` is resolved as
 * `dist/plugins/…` before any package mapping applies, so the alias needs the
 * file even though the plugin lives in a package. See
 * `docs/development/modularization-plan.md`.
 */
// eslint-disable-next-line local/no-plugin-family-import
export * from '@ldap-rest/scim';
// eslint-disable-next-line local/no-plugin-family-import
export { default } from '@ldap-rest/scim';
