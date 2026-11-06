/**
 * The SCIM plugin, at its historical short path (`core/scim`).
 *
 * A pure re-export alias: it crosses the misc/scim family boundary only so a
 * configuration naming the plugin by its short name resolves, as it always
 * has. See `docs/development/modularization-plan.md`.
 */
// eslint-disable-next-line local/no-plugin-family-import
export * from '@ldap-rest/scim';
// eslint-disable-next-line local/no-plugin-family-import
export { default } from '@ldap-rest/scim';
