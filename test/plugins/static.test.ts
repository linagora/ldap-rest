import fs from 'fs';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import Static from '../../src/plugins/static';
import { schemaUrl } from '../../src/lib/schemaFile';
import { expect } from 'chai';

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
      } catch (e) {}
    });

    afterEach(() => {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch (e) {}
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
