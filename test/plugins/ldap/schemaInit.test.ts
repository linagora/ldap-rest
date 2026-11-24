/**
 * The group and organization schemas are read before the plugin serves, and
 * a schema configured but unreadable stops the server: without it, a write
 * would skip every rule the schema holds.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import type { Schema } from '../../../src/config/schema';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';

// Loaded as the CLI loads them, from the build: the loader imports a path
const GROUPS = '../../dist/plugins/ldap/groups.js';
const ORGANIZATIONS = '../../dist/plugins/ldap/organizations.js';

const KEYS = [
  'DM_PLUGINS',
  'DM_GROUP_SCHEMA',
  'DM_ORGANIZATION_SCHEMA',
  'NODE_ENV',
];

describe('Group and organization schemas at startup', () => {
  const env: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) env[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('holds each schema before mounting its routes', async () => {
    delete process.env.DM_PLUGINS;
    const server = new DM();
    await server.ready;
    const seen: Record<string, Schema | undefined> = {};
    for (const plugin of [
      new LdapGroups(server),
      new LdapOrganizations(server),
    ]) {
      const api = plugin.api.bind(plugin);
      plugin.api = (app): void => {
        seen[plugin.name] = plugin.schema;
        api(app);
      };
      await server.registerPlugin(plugin.name, plugin);
    }
    expect(seen.ldapGroups?.attributes, 'groups').to.have.property('member');
    expect(
      seen.ldapOrganizations?.attributes,
      'organizations'
    ).to.have.property('ou');
  });

  it('is ready with both schemas loaded', async () => {
    process.env.DM_PLUGINS = [GROUPS, ORGANIZATIONS].join(';');
    const server = new DM();
    await server.ready;
    const groups = server.loadedPlugins.ldapGroups as LdapGroups;
    const organizations = server.loadedPlugins
      .ldapOrganizations as LdapOrganizations;
    expect(groups.schema?.attributes).to.have.property('member');
    expect(organizations.schema?.attributes).to.have.property('ou');
  });

  for (const [plugin, variable, what] of [
    [GROUPS, 'DM_GROUP_SCHEMA', 'group'],
    [ORGANIZATIONS, 'DM_ORGANIZATION_SCHEMA', 'organization'],
  ])
    it(`does not start on an unreadable ${what} schema`, async () => {
      process.env.DM_PLUGINS = plugin;
      process.env[variable] = '/nonexistent/schema.json';
      const server = new DM();
      let refused: Error | undefined;
      await server.ready.catch((err: Error) => {
        refused = err;
      });
      expect(refused, 'ready rejected').to.be.instanceOf(Error);
      expect(refused!.message).to.match(
        new RegExp(
          `Cannot load the ${what} schema from /nonexistent/schema\\.json`
        )
      );
    });

  it('does not register a plugin whose schema cannot be read', async () => {
    delete process.env.DM_PLUGINS;
    process.env.DM_GROUP_SCHEMA = '/nonexistent/schema.json';
    const server = new DM();
    await server.ready;
    let routed = false;
    const groups = new LdapGroups(server);
    groups.api = (): void => {
      routed = true;
    };
    let refused: Error | undefined;
    await server
      .registerPlugin('ldapGroups', groups)
      .catch((err: Error) => (refused = err));
    expect(refused?.message).to.match(/Cannot load the group schema/);
    expect(routed, 'routes mounted').to.equal(false);
    expect(server.loadedPlugins).to.not.have.property('ldapGroups');
  });
});
