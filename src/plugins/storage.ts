/**
 * The keyed storage plugin, at its historical path.
 *
 * The plugin and its backends live in `@ldap-rest/storage`; the umbrella
 * re-exports its default so `core/storage` keeps loading it. See
 * `docs/development/modularization-plan.md`.
 */
export { default } from '@ldap-rest/storage';
