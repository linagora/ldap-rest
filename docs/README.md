# LDAP-Rest Documentation

Complete documentation for LDAP-Rest, organized by use case.

## Documentation Categories

### [Usage](usage/README.md)

Installation, configuration and plugin usage.

- **[Getting Started](usage/README.md)** - Quick start guide
- **[Configuration](usage/configuration.md)** - CLI options and environment variables
- **[Upgrading](usage/upgrading.md)** - What to check before deploying a new version
- **[Directory audit](usage/directory-audit.md)** - What a schema would refuse in an existing directory
- **[Plugins](usage/plugins/README.md)** - Documentation for all available plugins

### [Plugin Development](plugin-development/README.md)

Create and extend LDAP-Rest with custom plugins.

- **[Development Guide](plugin-development/README.md)** - Architecture and plugin creation
- **[Hooks](plugin-development/hooks.md)** - LDAP hooks system
- **[Services](plugin-development/services.md)** - Typed interfaces between plugins
- **[Routes](plugin-development/routes.md)** - Declaring routes and their input schemas
- **[Testing](plugin-development/testing.md)** - Testing with embedded LDAP
- **[Dependencies](plugin-development/dependencies.md)** - Plugin dependencies matrix

### [Client Application Development](client-development/README.md)

Integrate LDAP-Rest into your web applications.

- **[REST API](client-development/api/rest-api.md)** - Complete API reference
- **[Browser Libraries](client-development/browser/libraries.md)** - Web components (LdapTreeViewer, LdapUserEditor, etc.)
- **[JSON Schemas](client-development/schemas/README.md)** - Schema structure and validation
- **[Examples](client-development/examples/README.md)** - React, Vue.js, Vanilla JS integration

## API stability

From 1.0.0, ldap-rest follows semantic versioning. These are its public
API, which a minor or a patch release does not break:

- **Configuration**: the options and environment variables of
  [Configuration](usage/configuration.md) and of each plugin's page.
- **Routes**: the paths, bodies and answers of the
  [REST API](client-development/api/rest-api.md) and the plugin pages,
  their statuses and their error `code`s.
- **Plugin API**: what `ldap-rest/plugin` exports — `DmPlugin` and its
  roles (`auth`, `authz`, …), `serviceToken`, `ServiceToken` and
  `ServiceProvider`, `asyncHandler`, the DN and filter escaping helpers and
  the error classes —, the `DM` type of `ldap-rest` and the
  `Hooks` of `ldap-rest/hooks`, whose arguments are those typed in
  `src/hooks.ts` ([hooks](plugin-development/hooks.md)), and the directory
  operations of [the development guide](plugin-development/README.md):
  `ldap.search`, `add`, `modify`, `rename`, `delete`, `ldap.forRequest`,
  `ldap.system`, `ldap.authorize`, `ldap.readableBy`,
  `ldap.canonicalAttributes`, `ldap.canonicalChanges` and
  `ldap.knowAttributeNames`.
- **Schemas**: the JSON schema format and the shipped schemas' attributes.

Everything else — other exports, internal helpers, log messages — may
change in any release.

## Presentations

Interactive presentations (using [presenterm](https://github.com/mfontanini/presenterm)):

- **[English](presentations/en.md)** - `presenterm docs/presentations/en.md`
- **[French](presentations/fr.md)** - `presenterm docs/presentations/fr.md`

## Support

- **Issues**: https://github.com/linagora/ldap-rest/issues
- **Documentation**: https://github.com/linagora/ldap-rest/tree/master/docs

## License

[![Powered by LINAGORA](./linagora.png)](https://linagora.com)

License: [AGPL-3.0](../LICENSE), copyright 2025-present LINAGORA.
