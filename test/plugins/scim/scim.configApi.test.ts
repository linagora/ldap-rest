/**
 * Where the configuration API says SCIM's schema files are: at the URL of
 * the static plugin that serves the very files SCIM reads, whatever its
 * name (#411).
 */
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import type { Config } from '../../../src/config/args';
import Scim from '../../../src/plugins/scim/scim';
import Static from '../../../src/plugins/static';

const shipped = join(__dirname, '..', '..', '..', 'static', 'schemas');
const files = ['User.json', 'Group.json', 'default-mapping.json'];
type Urls = { user: string; group: string; defaultMapping?: string };

describe('SCIM schema URLs in the configuration API', () => {
  const saved: Record<string, string | undefined> = {};
  const names = ['DM_STATIC_PATH', 'DM_STATIC_NAME', 'DM_SCHEMAS_PATH'];
  let empty: string;
  let copy: string;

  before(() => {
    for (const name of names) saved[name] = process.env[name];
    for (const name of names) delete process.env[name];
    empty = fs.mkdtempSync(join(os.tmpdir(), 'scim-static-'));
    // A deployment's own copy of the SCIM schemas, in a directory of its own
    copy = fs.mkdtempSync(join(os.tmpdir(), 'scim-schemas-'));
    fs.mkdirSync(join(copy, 'schemas', 'scim'), { recursive: true });
    for (const file of files)
      fs.copyFileSync(
        join(shipped, 'scim', file),
        join(copy, 'schemas', 'scim', file)
      );
  });

  after(() => {
    for (const name of names)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  });

  /** SCIM's announced URLs, with these static plugins loaded in this order */
  const announced = async (
    statics: [string, Partial<Config>][],
    scim: Partial<Config> = {}
  ): Promise<{ urls: Urls | undefined; dm: DM }> => {
    const dm = new DM();
    await dm.ready;
    for (const [name, override] of statics)
      await dm.registerPlugin(
        name,
        new Static(dm.withConfig({ ...dm.config, ...override })),
        name
      );
    const plugin = new Scim(dm.withConfig({ ...dm.config, ...scim }));
    return {
      urls: plugin.getConfigApiData().schemaUrls as Urls | undefined,
      dm,
    };
  };
  /** Each URL answers the file */
  const served = async (dm: DM, urls: Urls | undefined): Promise<void> => {
    expect(urls).to.not.equal(undefined);
    for (const [key, url] of Object.entries(urls as Urls)) {
      const res = await supertest(dm.app).get(url as string);
      expect(res.status, url).to.equal(200);
      // the file it names, not another one at that URL
      if (key !== 'defaultMapping')
        expect(JSON.stringify(res.body)).to.include(
          key === 'user' ? 'User' : 'Group'
        );
    }
  };
  const under = (path: string): Urls => ({
    user: `${path}/schemas/scim/User.json`,
    group: `${path}/schemas/scim/Group.json`,
    defaultMapping: `${path}/schemas/scim/default-mapping.json`,
  });

  it('should name the static plugin’s URL', async () => {
    const { urls, dm } = await announced([['static', {}]]);
    expect(urls).to.deep.equal(under('/static'));
    await served(dm, urls);
  });

  it('should follow the name the static plugin was given', async () => {
    // Announced under /static, they answered 404 (#411); loaded under
    // another name, none was announced.
    for (const plugin of ['static', 'console']) {
      const { urls, dm } = await announced([
        [plugin, { static_name: 'console' }],
      ]);
      expect(urls).to.deep.equal(under('/console'));
      await served(dm, urls);
    }
  });

  it('should name the one that holds them, and none when none does', async () => {
    // The console's own directory holds no SCIM schema.
    let { urls, dm } = await announced([
      ['console', { static_name: 'console', static_path: empty }],
      ['static', {}],
    ]);
    expect(urls).to.deep.equal(under('/static'));
    await served(dm, urls);
    ({ urls } = await announced([
      ['console', { static_name: 'console', static_path: empty }],
    ]));
    expect(urls).to.equal(undefined);
    ({ urls } = await announced([]));
    expect(urls).to.equal(undefined);
  });

  it('should name none whose path an earlier plugin answers', async () => {
    // The earlier plugin's schema route answers 404 before the later one,
    // whatever the case of its name: Express matches paths regardless.
    for (const first of [{}, { static_name: 'Static' }]) {
      const { urls, dm } = await announced([
        ['first', { static_path: empty, ...first }],
        ['static', {}],
      ]);
      expect(urls).to.equal(undefined);
      const res = await supertest(dm.app).get(under('/static').user);
      expect(res.status).to.equal(404);
    }
  });

  it('should name the mapping only when it is there', async () => {
    // A template beside them, which SCIM does not read
    const two = fs.mkdtempSync(join(os.tmpdir(), 'scim-two-'));
    try {
      fs.mkdirSync(join(two, 'schemas', 'scim'), { recursive: true });
      for (const file of ['User.json', 'Group.json'])
        fs.copyFileSync(
          join(shipped, 'scim', file),
          join(two, 'schemas', 'scim', file)
        );
      const { urls, dm } = await announced(
        [['own', { static_name: 'own', static_path: two }]],
        { schemas_path: join(two, 'schemas') }
      );
      expect(urls).to.deep.equal({
        user: '/own/schemas/scim/User.json',
        group: '/own/schemas/scim/Group.json',
      });
      await served(dm, urls);
    } finally {
      fs.rmSync(two, { recursive: true, force: true });
    }
  });

  it('should name the files SCIM reads, not those shipped', async () => {
    // --schemas-path elsewhere: the shipped copy is not what SCIM serves.
    const schemas_path = join(copy, 'schemas');
    let { urls, dm } = await announced([['static', {}]], { schemas_path });
    expect(urls).to.equal(undefined);
    ({ urls, dm } = await announced(
      [
        ['static', {}],
        ['own', { static_name: 'own', static_path: copy }],
      ],
      { schemas_path }
    ));
    expect(urls).to.deep.equal(under('/own'));
    await served(dm, urls);
  });

  it('should name none served as they stand, outside schemas/', async () => {
    // express.static would send them without their `extends` merged
    const { dm } = await announced([]);
    (dm.loadedPlugins as Record<string, unknown>).other = {
      name: 'other',
      servedPath: () => '/other',
      urlOf: (file: string) => `/other/scim/${file.split('/').pop()}`,
    };
    expect(new Scim(dm).getConfigApiData().schemaUrls).to.equal(undefined);
  });

  it('should ask any plugin that says where it serves, whatever its class', async () => {
    // Another copy of ldap-rest has a class of its own.
    const { dm } = await announced([]);
    (dm.loadedPlugins as Record<string, unknown>).other = {
      name: 'other',
      servedPath: () => '/other',
      urlOf: (file: string) => `/other/schemas/scim/${file.split('/').pop()}`,
    };
    const urls = new Scim(dm).getConfigApiData().schemaUrls;
    expect(urls).to.deep.equal(under('/other'));
  });
});
