import { expect } from 'chai';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import request from 'supertest';

import { DM } from '../../../src/bin';
import AuthLLNG from '../../../src/plugins/auth/llng';
import {
  loadLlng,
  llngFixture,
  llngVhost,
  type LlngFixture,
  type LlngModule,
} from '../../helpers/llngHandler';

describe('LemonLDAP::NG location rules and the letter case of the path', () => {
  describe('location keys', () => {
    /** A handler whose compiled keys are `sources`, for every request */
    const withKeys = (
      sources: string[]
    ): { Plugin: typeof AuthLLNG; list: Array<{ source: string }> } => {
      const list = sources.map(source => ({ source }));
      const handler = {
        init: async (): Promise<unknown> => ({
          tsv: { locationRegexp: { [llngVhost]: list } },
        }),
        run: (
          req: { headers: Record<string, string> },
          _res: unknown,
          next: () => void
        ): void => {
          req.headers['Lm-Remote-User'] = 'dwho';
          next();
        },
      };
      const Plugin = class extends AuthLLNG {
        protected async loadHandler(): Promise<never> {
          return handler as never;
        }
      };
      return { Plugin, list };
    };

    const startup = async (
      Plugin: typeof AuthLLNG
    ): Promise<{ plugin: AuthLLNG; error?: Error }> => {
      const dm = new DM();
      await dm.ready;
      const plugin = new Plugin(dm);
      try {
        await plugin.api({} as Express);
        return { plugin };
      } catch (err) {
        return { plugin, error: err as Error };
      }
    };

    // Keys as RE2 compiles them: the handler escapes every `/`
    const needCapital = [
      '^\\/scim\\/v2\\/Users',
      '^\\/x\\/\\x55sers',
      '^\\/x\\/\\x{55}sers',
      '^\\/x\\/\\125sers',
      '^\\/x\\/\\p{Lu}',
      '^\\/x\\/\\p{Uppercase}',
      '^\\/x\\/\\p{Uppercase_Letter}',
      '^\\/x\\/É',
      '^\\/x\\/\\x{FF21}',
      '^\\/x\\/[À-Ö]',
      '^\\/x\\/[[:upper:]]',
      '^\\/x\\/\\QUsers\\E',
      '^\\/x\\/[A-Z]',
      '^\\/x\\/[\\x41-\\x5a]',
      '^\\/x\\/U?',
      '^(?i:\\/a)\\/Users',
      '(?i)\\/a(?-i:\\/Users)',
    ];
    for (const key of needCapital)
      it(`refuses at startup the key ${key}`, async () => {
        const { Plugin } = withKeys(['^\\/api\\/v1', key]);
        const { error } = await startup(Plugin);
        expect(error?.message).to.include(key);
        expect(error?.message).to.include('(?i)');
      });

    const matchLowerCase = [
      '^\\/x\\/\\D+\\S*\\w\\.',
      '(?i)^\\/scim\\/v2\\/Users',
      '^(?i)\\/scim\\/v2\\/Groups',
      '^(?i:\\/scim\\/v2\\/Users)',
      '^\\/x\\/[Uu]sers',
      '^\\/x\\/[A-Za-z]',
      '^\\/x\\/[^A-Z]',
      '^\\/x\\/[[:alpha:]]',
      '^\\/x\\/\\x75sers',
      '^\\/x\\/%C3%A9quipe',
      '^\\/x\\/[À-ÿ]',
      '^\\/scim\\/v2\\/(?P<kind>schemas)',
    ];
    for (const key of matchLowerCase)
      it(`accepts the key ${key}`, async () => {
        const { Plugin } = withKeys([key]);
        const { error } = await startup(Plugin);
        expect(error).to.equal(undefined);
      });

    it('refuses the handler when it gives no compiled keys to read', async () => {
      const dm = new DM();
      await dm.ready;
      const Plugin = class extends AuthLLNG {
        protected async loadHandler(): Promise<never> {
          return {
            init: async (): Promise<unknown> => ({}),
            run: (): void => undefined,
          } as never;
        }
      };
      const { error } = await startup(Plugin);
      expect(error?.message).to.include('not supported');
    });

    it('stops serving when a reloaded configuration brings one', async () => {
      const { Plugin, list } = withKeys(['^\\/api\\/v1']);
      const { plugin, error } = await startup(Plugin);
      expect(error).to.equal(undefined);
      list.push({ source: '^\\/scim\\/v2\\/Users' });

      const app = express();
      app.use(plugin.authMethod.bind(plugin) as RequestHandler);
      app.get('/api/v1/ldap/users', (_req, res) => {
        res.json({});
      });
      await request(app).get('/api/v1/ldap/users').expect(503);
    });
  });

  describe('with the real handler', function () {
    let llng: LlngModule | undefined;
    let fixture: LlngFixture;
    let app: Express;
    let bob: string;
    let carol: string;

    before(async function () {
      llng = await loadLlng();
      if (!llng) return this.skip();
      fixture = llngFixture({
        '^/api/v1/ldap/users': '/\\bhr\\b/.test($groups)',
        '^/api/v1/ldap/groups/admins': '/\\badmins\\b/.test($groups)',
        '^/api/v1/ldap/groups/%C3%A9quipe': '/\\badmins\\b/.test($groups)',
        default: 'accept',
      });
      bob = fixture.session('bob-session', { uid: 'bob', groups: 'staff' });
      carol = fixture.session('carol-session', { uid: 'carol', groups: 'hr' });

      const dm = new DM();
      await dm.ready;
      dm.config.llng_ini = fixture.ini;
      const plugin = new AuthLLNG(dm);
      await plugin.api({} as Express);

      app = express();
      app.use(plugin.authMethod.bind(plugin) as RequestHandler);
      app.get('/api/v1/ldap/users{/:id}', (req, res) => {
        res.json({ path: req.path, id: req.params.id ?? null });
      });
      app.get('/api/v1/ldap/groups/:id', (req, res) => {
        res.json({ id: req.params.id });
      });
      app.get('/api/v1/ldap/organizations', (_req, res) => {
        res.json({});
      });
    });

    after(async () => {
      if (llng) await llng.shutdown();
      fixture?.remove();
    });

    const get = (path: string, cookie: string): request.Test =>
      request(app).get(path).set('Host', llngVhost).set('Cookie', cookie);

    it('applies a location rule to the path whatever its case', async () => {
      await get('/api/v1/ldap/users', bob).expect(403);
      await get('/API/V1/LDAP/USERS', bob).expect(403);
      await get('/Api/V1/Ldap/Users/carol?x=Y', bob).expect(403);
      await get('/api/v1/ldap/organizations', bob).expect(200);
    });

    it('applies it to a letter sent percent-encoded', async () => {
      const res = await get('/api/v1/ldap/groups/%41dmins', carol);
      expect(res.status).to.equal(403);
      await get('/api/v1/ldap/groups/staff', carol).expect(200);
    });

    it('applies it to a non-ASCII letter whatever its case', async () => {
      await get('/api/v1/ldap/groups/%C3%A9quipe', carol).expect(403);
      await get('/api/v1/ldap/groups/%c3%a9quipe', carol).expect(403);
      await get('/api/v1/ldap/groups/%C3%89QUIPE', carol).expect(403);
    });

    it('routes the request as it was sent', async () => {
      const res = await get('/API/V1/LDAP/USERS/CaRoL', carol).expect(200);
      expect(res.body).to.deep.equal({
        path: '/API/V1/LDAP/USERS/CaRoL',
        id: 'CaRoL',
      });
    });
  });
});
