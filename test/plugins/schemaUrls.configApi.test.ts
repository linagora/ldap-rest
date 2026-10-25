/**
 * Where the configuration API says the group, organization and flat entity
 * schema files are: at the URL where a static plugin serves the very file
 * the plugin reads, merged, whatever the static plugin's name.
 */
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import type { Config } from '../../src/config/args';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import Static from '../../src/plugins/static';

const shipped = join(__dirname, '..', '..', 'static', 'schemas');
const files = ['groups.json', 'organizations.json', 'positions.json'];
type Urls = {
  group: string | undefined;
  organization: string | undefined;
  flat: string | undefined;
};

describe('Schema URLs of groups, organizations and flat entities', () => {
  const saved: Record<string, string | undefined> = {};
  const names = [
    'DM_STATIC_PATH',
    'DM_STATIC_NAME',
    'DM_GROUP_SCHEMA',
    'DM_ORGANIZATION_SCHEMA',
    'DM_LDAP_FLAT_SCHEMA',
  ];
  let tmp: string;
  let empty: string;
  let own: string;
  let schemas: Partial<Config>;

  /** Copies of the shipped schemas in dir/twake, told apart by `$comment` */
  const copy = (dir: string, marker: string, to = files): void => {
    fs.mkdirSync(join(dir, 'twake'), { recursive: true });
    for (const [index, file] of files.entries()) {
      const schema = JSON.parse(
        fs.readFileSync(join(shipped, 'twake', file), 'utf8')
      ) as Record<string, unknown>;
      schema.$comment = `${marker} ${file}`;
      fs.writeFileSync(join(dir, 'twake', to[index]), JSON.stringify(schema));
    }
  };

  before(() => {
    for (const name of names) saved[name] = process.env[name];
    for (const name of names) delete process.env[name];
    tmp = fs.mkdtempSync(join(os.tmpdir(), 'schema-urls-'));
    empty = join(tmp, 'empty');
    fs.mkdirSync(empty);
    // A deployment's own schemas, outside any static directory
    own = join(tmp, 'etc', 'schemas');
    copy(own, 'own');
    schemas = {
      group_schema: join(own, 'twake', 'groups.json'),
      organization_schema: join(own, 'twake', 'organizations.json'),
      ldap_flat_schema: [join(own, 'twake', 'positions.json')],
    };
  });

  after(() => {
    for (const name of names)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** The announced URLs, with these static plugins loaded in this order */
  const announced = async (
    statics: [string, Partial<Config>][],
    config: Partial<Config> = schemas
  ): Promise<{ urls: Urls; dm: DM }> => {
    const dm = new DM();
    await dm.ready;
    Object.assign(dm.config, config);
    for (const [name, override] of statics)
      await dm.registerPlugin(
        name,
        new Static(dm.withConfig({ ...dm.config, ...override })),
        name
      );
    const flat = new LdapFlatGeneric(dm).getConfigApiData().flatResources as {
      schemaUrl?: string;
    }[];
    return {
      urls: {
        group: new LdapGroups(dm).getConfigApiData().schemaUrl as
          | string
          | undefined,
        organization: new LdapOrganizations(dm).getConfigApiData().schemaUrl as
          | string
          | undefined,
        flat: flat[0]?.schemaUrl,
      },
      dm,
    };
  };
  const shippedName: Record<string, string> = {
    group: 'groups.json',
    organization: 'organizations.json',
    flat: 'positions.json',
  };
  /** Each URL answers the file the plugin reads, merged */
  const served = async (
    dm: DM,
    urls: Partial<Urls>,
    marker: string | null = 'own'
  ): Promise<void> => {
    for (const [key, url] of Object.entries(urls)) {
      expect(url, key).to.be.a('string');
      const res = await supertest(dm.app).get(url as string);
      expect(res.status, url).to.equal(200);
      expect(res.body, url).to.include.keys('entity', 'attributes');
      // the copy of this very file, not another one of the same directory
      expect(
        (res.body as { $comment?: string }).$comment ?? null,
        url
      ).to.equal(marker && `${marker} ${shippedName[key]}`);
    }
  };
  const under = (path: string): Urls => ({
    group: `${path}/schemas/twake/groups.json`,
    organization: `${path}/schemas/twake/organizations.json`,
    flat: `${path}/schemas/twake/positions.json`,
  });

  it('should name the static plugin’s URL', async () => {
    const { urls, dm } = await announced([['static', {}]]);
    expect(urls).to.deep.equal(under('/static'));
    await served(dm, urls);
  });

  it('should name the shipped group schema by default', async () => {
    const { urls, dm } = await announced([['static', {}]], {});
    expect(urls.group).to.equal('/static/schemas/twake/groups.json');
    await served(dm, { group: urls.group }, null);
  });

  it('should follow the name the static plugin was given', async () => {
    // Announced under /static, they answered 404; loaded under another
    // name, none was announced.
    for (const [plugin, override] of [
      ['static', { static_name: 'console', static_path: empty }],
      ['console', { static_name: 'console', static_path: empty }],
      ['console', { static_path: empty }],
    ] as [string, Partial<Config>][]) {
      const { urls, dm } = await announced([[plugin, override]]);
      const name = override.static_name ?? 'static';
      expect(urls, plugin).to.deep.equal(under(`/${name}`));
      await served(dm, urls);
    }
  });

  it('should name the one registered as static first', async () => {
    const { urls, dm } = await announced([
      ['console', { static_name: 'console', static_path: empty }],
      ['static', {}],
    ]);
    expect(urls).to.deep.equal(under('/static'));
    await served(dm, urls);
  });

  it('should name none under the path of an earlier plugin', async () => {
    // The earlier one's routes answer first, even for the one registered
    // as static
    const { urls } = await announced([
      ['console', { static_name: 'console', static_path: empty }],
      ['static', { static_name: 'console/inner', static_path: empty }],
    ]);
    expect(urls).to.deep.equal(under('/console'));
    // Nor over it: the earlier one's express.static sends its own
    // twake/groups.json, as it stands, at /console/schemas/twake/groups.json
    const inner = join(tmp, 'inner');
    copy(join(inner, 'twake'), 'inner');
    const { urls: outer, dm } = await announced([
      ['inner', { static_name: 'console/schemas', static_path: inner }],
      ['static', { static_name: 'console', static_path: empty }],
    ]);
    expect(outer).to.deep.equal(under('/console/schemas'));
    await served(dm, outer);
  });

  it('should name none without a static plugin', async () => {
    const { urls } = await announced([]);
    expect(urls).to.deep.equal({
      group: undefined,
      organization: undefined,
      flat: undefined,
    });
  });

  it('should name none for a file no static plugin serves', async () => {
    // Left at its default, --group-schema is the package's file. A
    // --static-path of the deployment's own serves its own copy at that
    // URL, not the schema the server uses.
    const site = join(tmp, 'site');
    copy(join(site, 'schemas'), 'site');
    for (const path of [empty, site]) {
      const { urls, dm } = await announced(
        [['static', { static_path: path }]],
        {}
      );
      expect(urls.group, path).to.equal(undefined);
      if (path === site)
        await served(
          dm,
          { group: '/static/schemas/twake/groups.json' },
          'site'
        );
    }
  });

  it('should name a file of its schemas/ directory, through a link too', async () => {
    const site = join(tmp, 'linked');
    fs.mkdirSync(site);
    fs.symlinkSync(own, join(site, 'schemas'));
    for (const config of [
      schemas,
      // the file as reached through the link
      {
        group_schema: join(site, 'schemas', 'twake', 'groups.json'),
        organization_schema: join(
          site,
          'schemas',
          'twake',
          'organizations.json'
        ),
        ldap_flat_schema: [join(site, 'schemas', 'twake', 'positions.json')],
      },
    ]) {
      const { urls, dm } = await announced(
        [['static', { static_path: site }]],
        config
      );
      expect(urls).to.deep.equal(under('/static'));
      await served(dm, urls);
    }
  });

  it('should name a configured file whatever its extension', async () => {
    // The schema route serves a configured file before it looks at the name
    const odd = join(tmp, 'odd', 'schemas');
    copy(odd, 'odd', ['groups.JSON', 'organizations.schema', 'positions']);
    const { urls, dm } = await announced([['static', { static_path: empty }]], {
      group_schema: join(odd, 'twake', 'groups.JSON'),
      organization_schema: join(odd, 'twake', 'organizations.schema'),
      ldap_flat_schema: [join(odd, 'twake', 'positions')],
    });
    expect(urls).to.deep.equal({
      group: '/static/schemas/twake/groups.JSON',
      organization: '/static/schemas/twake/organizations.schema',
      flat: '/static/schemas/twake/positions',
    });
    await served(dm, urls, 'odd');
  });

  it('should name none for a file served as it stands', async () => {
    // express.static sends it without its `extends` merged nor its
    // placeholders replaced: outside schemas/, or not named .json
    const site = join(tmp, 'raw');
    copy(join(site, 'raw'), 'raw');
    copy(join(site, 'schemas'), 'raw', [
      'groups.JSON',
      'organizations.json',
      'positions.json',
    ]);
    for (const file of [
      join(site, 'raw', 'twake', 'groups.json'),
      join(site, 'schemas', 'twake', 'groups.JSON'),
    ]) {
      const { urls } = await announced([['static', { static_path: site }]], {
        group_schema: file,
      });
      // Configured, but in the static directory at its URL: the schema
      // route leaves that one to express.static
      expect(urls.group, file).to.equal(undefined);
    }
    // Left at its default, a file of the static directory is not configured
    const { dm } = await announced([['static', { static_path: site }]], {});
    const res = await supertest(dm.app).get('/static/raw/twake/groups.json');
    expect(res.status).to.equal(200);
    const plugin = dm.loadedPlugins.static as Static;
    expect(
      plugin.schemaUrlOf(join(site, 'raw', 'twake', 'groups.json'))
    ).to.equal(undefined);
    expect(
      plugin.schemaUrlOf(join(site, 'schemas', 'twake', 'groups.JSON'))
    ).to.equal(undefined);
    expect(
      plugin.schemaUrlOf(join(site, 'schemas', 'twake', 'positions.json'))
    ).to.equal('/static/schemas/twake/positions.json');
  });
});
