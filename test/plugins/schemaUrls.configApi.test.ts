/**
 * Where the configuration API says the group, organization and flat entity
 * schema files are: at the URL of the static plugin that serves them,
 * whatever its name (#413).
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
  let empty: string;
  let own: string;
  let schemas: Partial<Config>;

  before(() => {
    for (const name of names) saved[name] = process.env[name];
    for (const name of names) delete process.env[name];
    empty = fs.mkdtempSync(join(os.tmpdir(), 'schema-urls-static-'));
    // A deployment's own schemas, outside any static directory
    own = fs.mkdtempSync(join(os.tmpdir(), 'schema-urls-own-'));
    fs.mkdirSync(join(own, 'schemas', 'twake'), { recursive: true });
    for (const file of ['groups.json', 'organizations.json', 'positions.json'])
      fs.copyFileSync(
        join(shipped, 'twake', file),
        join(own, 'schemas', 'twake', file)
      );
    schemas = {
      group_schema: join(own, 'schemas', 'twake', 'groups.json'),
      organization_schema: join(own, 'schemas', 'twake', 'organizations.json'),
      ldap_flat_schema: [join(own, 'schemas', 'twake', 'positions.json')],
    };
  });

  after(() => {
    for (const name of names)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(own, { recursive: true, force: true });
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
  /** Each URL answers a schema */
  const served = async (dm: DM, urls: Urls): Promise<void> => {
    for (const [key, url] of Object.entries(urls)) {
      expect(url, key).to.be.a('string');
      const res = await supertest(dm.app).get(url as string);
      expect(res.status, url).to.equal(200);
      expect(res.body).to.include.keys('entity', 'attributes');
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

  it('should follow the name the static plugin was given', async () => {
    // Announced under /static, they answered 404; loaded under another
    // name, none was announced.
    for (const plugin of ['static', 'console']) {
      const { urls, dm } = await announced([
        [plugin, { static_name: 'console', static_path: empty }],
      ]);
      expect(urls).to.deep.equal(under('/console'));
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

  it('should name none without a static plugin', async () => {
    const { urls } = await announced([]);
    expect(urls).to.deep.equal({
      group: undefined,
      organization: undefined,
      flat: undefined,
    });
  });

  it('should name none for a file no static plugin serves', async () => {
    // Left at its default, --group-schema is the package's file, which a
    // --static-path of the deployment's own does not serve.
    const { urls } = await announced([['static', { static_path: empty }]], {});
    expect(urls.group).to.equal(undefined);
  });

  it('should name none for a file served as it stands, outside schemas/', async () => {
    // express.static would send it without its `extends` merged nor its
    // placeholders replaced
    const { urls } = await announced([['static', { static_path: own }]], {
      group_schema: join(own, 'schemas', 'twake', 'groups.json'),
    });
    expect(urls.group).to.equal('/static/schemas/twake/groups.json');
    const raw = join(own, 'raw');
    fs.mkdirSync(raw, { recursive: true });
    fs.copyFileSync(
      join(shipped, 'twake', 'groups.json'),
      join(raw, 'groups.json')
    );
    const { urls: elsewhere, dm } = await announced(
      [['static', { static_path: own }]],
      { group_schema: join(raw, 'groups.json') }
    );
    expect(elsewhere.group).to.equal(undefined);
    // express.static does serve it there
    const res = await supertest(dm.app).get('/static/raw/groups.json');
    expect(res.status).to.equal(200);
  });
});
