/**
 * `entity.pluralName` becomes the last segment of a flat entity's URL, and the
 * other LDAP plugins serve collections of their own under the same prefix. A
 * schema claiming `groups` while `core/ldap/groups` is loaded registers its
 * routes on a path Express already answers, Express answers with whichever
 * registered first, and the loser keeps being advertised by the configuration
 * API — exactly the failure the guard against two schemas claiming one name
 * exists to prevent, between a schema and a plugin this time.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import LdapFlatGeneric, {
  ldapPluginCollections,
} from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapRaw from '../../../src/plugins/ldap/raw';
import LdapBulkImport from '../../../src/plugins/ldap/bulkImport';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/**
 * Build a plugin while collecting what it logs as an error: a schema is
 * refused by throwing inside the loading loop, which the constructor logs and
 * skips, so the refusal is read there.
 *
 * @param server server the plugin is built on
 * @returns the plugin and the errors logged while it was built
 */
function buildCollectingErrors(server: DM): {
  flat: LdapFlatGeneric;
  errors: string[];
} {
  const errors: string[] = [];
  const logger = server.logger as unknown as { error: unknown };
  const original = logger.error;
  logger.error = (message: unknown) => errors.push(String(message));
  try {
    return { flat: new LdapFlatGeneric(server), errors };
  } finally {
    logger.error = original;
  }
}

/**
 * Paths registered on a server's Express app. Express 5 exposes the router as
 * `router`, Express 4 as `_router`, the way `src/bin` reads it.
 *
 * @param server server to read
 * @returns every route path registered so far
 */
function routePaths(server: DM): string[] {
  const app = server.app as unknown as {
    router?: { stack: { route?: { path?: string } }[] };
    _router?: { stack: { route?: { path?: string } }[] };
  };
  const stack = (app.router ?? app._router)?.stack ?? [];
  return stack
    .map(layer => layer.route?.path)
    .filter((path): path is string => typeof path === 'string');
}

describe('flatGeneric against the plugins serving their own collection', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  it('should refuse a schema claiming the URL a loaded plugin serves', async () => {
    const server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/groups.json'];
    await server.registerPlugin('ldapGroups', new LdapGroups(server));

    const { flat, errors } = buildCollectingErrors(server);
    expect(flat.instances.map(instance => instance.pluralName)).to.deep.equal(
      []
    );
    expect(errors.join('\n')).to.contain(
      'wants the URL of "groups", already served by plugin ldapGroups'
    );
  });

  it('should refuse it just as well before that plugin is loaded', async () => {
    // The loader builds the plugins in parallel, so this constructor runs
    // before `core/ldap/groups` as often as after it. The configuration says
    // what will be served whatever the order.
    const server = new DM();
    await server.ready;
    server.config.plugin = ['core/ldap/groups', 'core/ldap/flatGeneric'];
    server.config.ldap_flat_schema = ['./static/schemas/twake/groups.json'];

    const { flat, errors } = buildCollectingErrors(server);
    expect(flat.instances.map(instance => instance.pluralName)).to.deep.equal(
      []
    );
    expect(errors.join('\n')).to.contain('already served by plugin ldapGroups');
  });

  it('should read a plugin named by its built module too', async () => {
    const server = new DM();
    await server.ready;
    server.config.plugin = ['./dist/plugins/ldap/groups.js:groups2:{}'];
    server.config.ldap_flat_schema = ['./static/schemas/twake/groups.json'];

    expect(
      buildCollectingErrors(server).flat.instances.map(
        instance => instance.pluralName
      )
    ).to.deep.equal([]);
  });

  it('should leave a schema claiming a URL of its own alone', async () => {
    const server = new DM();
    await server.ready;
    server.config.plugin = ['core/ldap/groups', 'core/ldap/organizations'];
    server.config.ldap_flat_schema = ['./static/schemas/twake/positions.json'];
    await server.registerPlugin('ldapGroups', new LdapGroups(server));

    const { flat, errors } = buildCollectingErrors(server);
    expect(errors).to.deep.equal([]);
    expect(flat.instances.map(instance => instance.pluralName)).to.deep.equal([
      'positions',
    ]);
  });

  it('should name the collections those plugins really serve', async () => {
    // The list the guard reads is written by hand — the plugins spell their
    // routes literally, so the OpenAPI generator documents the real paths —
    // and this is what keeps it from drifting away from them.
    const server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    server.config.group_schema = './static/schemas/twake/groups.json';
    server.config.bulk_import_schemas =
      'users:./static/schemas/twake/users.json';
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    await server.registerPlugin('ldapRaw', new LdapRaw(server));
    await server.registerPlugin('ldapBulkImport', new LdapBulkImport(server));

    const paths = routePaths(server);
    for (const { plugin, collection } of ldapPluginCollections) {
      const base = `${server.config.api_prefix}/v1/ldap/${collection}`;
      expect(
        paths.some(path => path === base || path.startsWith(`${base}/`)),
        `${plugin} serves ${base}`
      ).to.be.true;
    }
  });
});
