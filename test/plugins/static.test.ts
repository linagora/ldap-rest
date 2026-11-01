import fs from 'fs';
import os from 'os';
import { join, sep } from 'path';

import supertest from 'supertest';
import { expect } from 'chai';

import { DM } from '../../src/bin';
import Static from '../../src/plugins/static';
import { schemaUrl } from '../../src/lib/schemaFile';

const dir = './test/__plugins__/static';
let dm: DM;
let plugin: Static;
let savedLdapBase: string | undefined;

describe('static', () => {
  before(() => {
    savedLdapBase = process.env.DM_LDAP_BASE;
  });

  after(() => {
    if (savedLdapBase !== undefined) {
      process.env.DM_LDAP_BASE = savedLdapBase;
    } else {
      delete process.env.DM_LDAP_BASE;
    }
  });

  describe('path configuration', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      process.env.DM_STATIC_PATH = dir;
      process.env.DM_LDAP_BASE = 'dc=example,dc=com';
      dm = new DM();
      await dm.ready;
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {
        // Nothing to remove
      }
    });

    afterEach(() => {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {
        // Nothing to remove
      }
    });

    it('should fail when directory does not exist', async () => {
      let err: Error | null = null;
      try {
        plugin = new Static(dm);
        await dm.registerPlugin('static', plugin);
        expect.fail('Should have failed');
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.an('error');
      expect(err?.message).to.match(/Bad directory/);
    });

    it('should fail when path is not a directory', async () => {
      let err: Error | null = null;
      try {
        fs.writeFileSync(dir, 'Hello');
        plugin = new Static(dm);
        await dm.registerPlugin('static', plugin);
        expect.fail('Should have failed');
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.an('error');
      expect(err?.message).to.match(/Bad directory/);
    });

    it('should return static content', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/test.txt`, 'Hello World');
      plugin = new Static(dm);
      await dm.registerPlugin('static', plugin);
      const request = supertest(dm.app);
      const res = await request.get('/static/test.txt');
      expect(res.status).to.equal(200);
      expect(res.text).to.equal('Hello World');
    });
  });

  describe('default path', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.DM_STATIC_PATH;
      dm = new DM();
      await dm.ready;
    });

    it('should use default paths and replace parameters', async () => {
      plugin = new Static(dm);
      await dm.registerPlugin('static', plugin);
      const request = supertest(dm.app);
      const res = await request.get('/static/schemas/twake/groups.json');
      expect(res.status).to.equal(200);
      expect(res.type).to.equal('application/json');
      expect(JSON.stringify(res.body)).to.match(/dc=example/);
    });
  });

  describe('headers', () => {
    const saved: Record<string, string | undefined> = {};
    const names = [
      'NODE_ENV',
      'DM_STATIC_PATH',
      'DM_STATIC_NAME',
      'DM_STATIC_CSP',
      'DM_STATIC_FRAME_OPTIONS',
    ];
    /** A server with the static plugin, the environment and overrides given */
    const serve = async (
      env: Record<string, string> = {},
      override: Record<string, unknown> = {}
    ): Promise<ReturnType<typeof supertest>> => {
      for (const name of names) delete process.env[name];
      Object.assign(process.env, { NODE_ENV: 'test' }, env);
      dm = new DM();
      await dm.ready;
      Object.assign(dm.config, override);
      // A route of another plugin, outside the prefix
      dm.app.get('/elsewhere', (_req, res) => {
        res.json({ ok: true });
      });
      await dm.registerPlugin('static', new Static(dm));
      return supertest(dm.app);
    };
    const refused = async (
      env: Record<string, string>,
      override: Record<string, unknown> = {}
    ): Promise<string> => {
      try {
        await serve(env, override);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };

    before(() => {
      for (const name of names) saved[name] = process.env[name];
    });

    after(() => {
      for (const name of names)
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    });

    it('should keep its pages from being framed by another origin', async () => {
      // A signed-in console could be framed by any page of the same site
      // (#407).
      const request = await serve();
      const page = await request.get('/static/schemas/example/README.md');
      const unchanged = await request
        .get('/static/schemas/example/README.md')
        .set('If-None-Match', String(page.headers.etag));
      const schema = await request.get('/static/schemas/twake/groups.json');
      expect([page.status, unchanged.status, schema.status]).to.deep.equal([
        200, 304, 200,
      ]);
      for (const res of [page, unchanged, schema]) {
        expect(res.headers['content-security-policy']).to.equal(
          "frame-ancestors 'self'"
        );
        expect(res.headers['x-frame-options']).to.equal('SAMEORIGIN');
        expect(res.headers['x-content-type-options']).to.equal('nosniff');
        expect(res.headers['x-powered-by']).to.equal(undefined);
      }
      // A 404 Express answers itself has its own policy, and keeps the
      // frame options.
      const missing = await request.get('/static/no-such-file.html');
      const directory = await request.get('/static/schemas/example');
      expect([missing.status, directory.status]).to.deep.equal([404, 301]);
      for (const res of [missing, directory])
        expect(res.headers['x-frame-options']).to.equal('SAMEORIGIN');
    });

    it('should frame nothing outside its prefix', async () => {
      const request = await serve();
      for (const path of ['/elsewhere', '/staticfoo']) {
        const res = await request.get(path);
        expect(res.headers['content-security-policy'] ?? '').to.not.include(
          'frame-ancestors'
        );
        expect(res.headers['x-frame-options']).to.equal(undefined);
        expect(res.headers['x-content-type-options']).to.equal('nosniff');
        expect(res.headers['x-powered-by']).to.equal(undefined);
      }
      expect((await request.get('/elsewhere')).status).to.equal(200);
    });

    it('should send the policy configured, none when off, the default when empty', async () => {
      // Written on several lines, as a YAML block holds it, it is one line.
      const strict = await serve({
        DM_STATIC_CSP: "default-src 'self';\n  frame-ancestors 'none'\n",
        DM_STATIC_FRAME_OPTIONS: 'DENY',
      });
      let res = await strict.get('/static/schemas/twake/groups.json');
      expect(res.status).to.equal(200);
      expect(res.headers['content-security-policy']).to.equal(
        "default-src 'self'; frame-ancestors 'none'"
      );
      expect(res.headers['x-frame-options']).to.equal('DENY');
      // A proxy that sets its own: none here, `false` in a JSON override.
      const cases: [Record<string, string>, Record<string, unknown>][] = [
        [{ DM_STATIC_CSP: 'off', DM_STATIC_FRAME_OPTIONS: 'OFF' }, {}],
        [{ DM_STATIC_CSP: 'off' }, { static_frame_options: false }],
      ];
      for (const [env, override] of cases) {
        const off = await serve(env, override);
        res = await off.get('/static/schemas/twake/groups.json');
        expect(res.headers['content-security-policy']).to.equal(undefined);
        expect(res.headers['x-frame-options']).to.equal(undefined);
      }
      // An unset `${VAR:-}` of a compose file drops nothing.
      const empty = await serve({
        DM_STATIC_NAME: '',
        DM_STATIC_CSP: '',
        DM_STATIC_FRAME_OPTIONS: ' ',
      });
      res = await empty.get('/static/schemas/twake/groups.json');
      expect(res.status).to.equal(200);
      expect(res.headers['content-security-policy']).to.equal(
        "frame-ancestors 'self'"
      );
      expect(res.headers['x-frame-options']).to.equal('SAMEORIGIN');
    });

    it('should refuse at startup what it could not send', async () => {
      // Refused at each request, it made every file a 500.
      expect(
        await refused({ DM_STATIC_CSP: "frame-ancestors 'self'\u0001" })
      ).to.include('--static-csp');
      expect(await refused({}, { static_frame_options: 1 })).to.include(
        '--static-frame-options'
      );
      for (const name of ['..', 'a//b', 'a/./b', 'a:b', 'a b', 'a*', 'café'])
        expect(await refused({ DM_STATIC_NAME: name })).to.include(
          '--static-name'
        );
      expect(await refused({}, { static_name: 0 })).to.include('--static-name');
    });

    it('should say where it serves a file, and nothing for one it does not', async () => {
      // For another plugin to announce it (#411)
      const tmp = fs.mkdtempSync(join(os.tmpdir(), 'static-url-'));
      const write = (path: string): string => {
        fs.mkdirSync(join(tmp, path, '..'), { recursive: true });
        fs.writeFileSync(join(tmp, path), '{}');
        return join(tmp, path);
      };
      try {
        const spaced = write('my files/a b.json');
        const odd = write('schemas/my schemas/x.json');
        const hidden = write('.conf/x.json');
        const dotted = write('..archive/x.json');
        const configured = write('elsewhere/schemas/extra/thing.json');
        const odder = write('elsewhere/schemas/a#b?c/x y.json');
        const dotted2 = write('elsewhere/schemas/sub/z.json');
        const capital = write('Schemas/x.json');
        // a file of its own at the URL a configured one holds
        const masked = write('schemas/other/thing.json');
        const holder = write('elsewhere/schemas/other/thing.json');
        let request = await serve(
          { DM_STATIC_PATH: tmp, DM_STATIC_NAME: 'console' },
          {
            ldap_flat_schema: [
              configured,
              odder,
              `${tmp}/elsewhere/schemas/sub/./z.json`,
              holder,
            ],
          }
        );
        const plugin = dm.loadedPlugins.static as Static;
        const answers = async (url: string | undefined): Promise<void> => {
          expect(url).to.be.a('string');
          expect((await request.get(url as string)).status, url).to.equal(200);
        };
        // from its directory, named as a URL writes it
        expect(plugin.urlOf(spaced)).to.equal('/console/my%20files/a%20b.json');
        await answers(plugin.urlOf(spaced));
        // a path that goes out and back in is the file's own
        await answers(plugin.urlOf(`${tmp}/my files/../my files/a b.json`));
        // a configured schema, at the URL the schema route gives
        expect(plugin.urlOf(configured)).to.equal(
          '/console/schemas/extra/thing.json'
        );
        await answers(plugin.urlOf(configured));
        expect(plugin.urlOf(odder)).to.equal(
          '/console/schemas/a%23b%3Fc/x%20y.json'
        );
        await answers(plugin.urlOf(odder));
        // configured at a URL a client would rewrite: from the directory
        expect(plugin.urlOf(dotted2)).to.equal(
          '/console/elsewhere/schemas/sub/z.json'
        );
        await answers(plugin.urlOf(dotted2));
        // nothing its routes would not answer with it: a directory, a
        // missing file, one outside, a hidden one, a schema path refused
        for (const file of [
          join(tmp, 'my files'),
          join(tmp, 'none.json'),
          __filename,
          hidden,
          dotted,
          odd,
          // a case the schema route reads otherwise, a URL a configured
          // schema holds
          capital,
          masked,
        ])
          expect(plugin.urlOf(file), file).to.equal(undefined);
        for (const path of ['/console/.conf/x.json', '/console/Schemas/x.json'])
          expect((await request.get(path)).status, path).to.equal(404);
        // a directory reached through a link
        const link = `${tmp}-link`;
        fs.symlinkSync(tmp, link);
        try {
          request = await serve({ DM_STATIC_PATH: link });
          await answers((dm.loadedPlugins.static as Static).urlOf(spaced));
        } finally {
          fs.rmSync(link, { force: true });
        }
        // a directory of / holds every file
        request = await serve({ DM_STATIC_PATH: '/', DM_STATIC_NAME: 'root' });
        expect((dm.loadedPlugins.static as Static).urlOf(spaced)).to.equal(
          `/root${spaced.split(sep).map(encodeURIComponent).join('/')}`
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('should serve under its name, the slashes around it left out', async () => {
      for (const [name, path] of [
        ['/console/', '/console'],
        ['admin/console', '/admin/console'],
        ['app@v2', '/app@v2'],
      ]) {
        const request = await serve({ DM_STATIC_NAME: name });
        const res = await request.get(`${path}/schemas/twake/groups.json`);
        expect(res.status).to.equal(200);
        expect(res.headers['x-frame-options']).to.equal('SAMEORIGIN');
        // and is said to be there
        expect(
          (dm.loadedPlugins.static as Static).getConfigApiData().staticPath
        ).to.equal(path);
        expect(schemaUrl(dm.config, '/x/schemas/a.json')).to.equal(
          `${path}/schemas/a.json`
        );
      }
    });
  });
});
