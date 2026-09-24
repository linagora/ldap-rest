/**
 * Two authorization plugins loaded together (#189).
 *
 * Every plugin judging LDAP operations registers the same hooks and
 * `launchHooksChained` runs them all, so two of them compose as an AND: the
 * first refusal wins. `authzPerBranch` beside `authzDynamic` judged a machine
 * token by a branch configuration written for administrators, found no key
 * for the tenant, and refused a write the token's own ACLs grant — with
 * nothing in the log saying which plugin refused.
 *
 * Pinned here: the AND itself, the startup refusal that now stands in front
 * of it, `authz_for` scoping, the dispatcher's record of who vouched, and the
 * log line naming the plugin that refused.
 */
import type { Express, Response } from 'express';
import { expect } from 'chai';
import supertest from 'supertest';

import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import { DM, type Config } from '../../../src/bin';
import type { DmRequest } from '../../../src/lib/auth/base';
import { assertAuthzComposition } from '../../../src/lib/authz/composition';
import { asyncHandler, launchHooksChained } from '../../../src/lib/utils';
import AuthToken from '../../../src/plugins/auth/token';
import AuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const DYNAMIC_TOKEN = 'dynamic-token-for-authz-composition';
const STATIC_TOKEN = 'static-token-for-authz-composition';
const STATIC_USER = 'composition-static';
const TENANT = 'composition-tenant';

/**
 * A route writing to one entry with the request threaded through, as the
 * issue's reproduction did — so the branch plugins, which read `req`, judge
 * it. It answers with what the dispatcher recorded.
 */
class Writer extends DmPlugin {
  name = 'writer';
  roles: Role[] = ['api'] as const;
  constructor(
    server: DM,
    private readonly target: () => string
  ) {
    super(server);
  }
  api(app: Express): void {
    for (const path of ['/api/test/write', '/api/other/write'])
      app.put(
        path,
        asyncHandler(async (req: DmRequest, res: Response) => {
          await this.server.ldap.modify(
            this.target(),
            { replace: { description: `written ${Date.now()}` } },
            req
          );
          res.json({ authenticators: req.authenticators ?? null });
        })
      );
  }
}

describe('Authorization plugins loaded together', function () {
  let baseDn: string;
  let tokensOu: string;
  let targetDn: string;
  let fixture: DM;
  const saved: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    baseDn = process.env.DM_LDAP_BASE as string;
    tokensOu = `ou=authz-composition-189,${baseDn}`;
    targetDn = `cn=composition-189-target,ou=groups,${baseDn}`;
    for (const k of [
      'DM_AUTHZ_DYNAMIC_BASE',
      'DM_AUTHZ_DYNAMIC_CACHE_TTL',
      'DM_AUTHZ_DYNAMIC_BYPASS',
      'DM_AUTH_TOKENS',
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_FOR',
      'DM_AUTHZ_COMBINE',
    ])
      saved[k] = process.env[k];
    process.env.DM_AUTHZ_DYNAMIC_BASE = tokensOu;
    process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = '1';
    process.env.DM_AUTH_TOKENS = `${STATIC_TOKEN}:${STATIC_USER}`;
    for (const k of [
      'DM_AUTHZ_DYNAMIC_BYPASS',
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_FOR',
      'DM_AUTHZ_COMBINE',
    ])
      delete process.env[k];

    fixture = new DM();
    await fixture.ready;
    await fixture.ldap
      .add(tokensOu, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'authz-composition-189',
      })
      .catch(() => undefined);
    await fixture.ldap
      .add(`cn=writer,${tokensOu}`, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'writer',
        sn: 'writer',
        userPassword: ssha(DYNAMIC_TOKEN),
        description: JSON.stringify({
          tenant: TENANT,
          bases: [
            {
              dn: `ou=groups,${baseDn}`,
              read: true,
              write: true,
              delete: false,
            },
          ],
        }),
      })
      .catch(() => undefined);
    await fixture.ldap
      .add(targetDn, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'composition-189-target',
        member: `cn=writer,${tokensOu}`,
      })
      .catch(() => undefined);
  });

  after(async () => {
    await fixture?.ldap.delete(targetDn).catch(() => undefined);
    await fixture?.ldap.delete(`cn=writer,${tokensOu}`).catch(() => undefined);
    await fixture?.ldap.delete(tokensOu).catch(() => undefined);
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  interface Build {
    dynamic?: boolean;
    /** `authToken`, unscoped or on its own prefix */
    token?: 'everywhere' | '/api/other';
    /** `authzPerBranch`, with these overrides */
    perBranch?: Partial<Config>;
    combine?: boolean;
    bypass?: string[];
  }

  /** A server with the plugins asked for, and what its log said. */
  const build = async (
    opts: Build
  ): Promise<{
    server: DM;
    request: ReturnType<typeof supertest>;
    warned: string[];
    info: string[];
    startup?: Error;
  }> => {
    const server = new DM();
    await server.ready;
    server.config.authz_combine = Boolean(opts.combine);
    server.config.authz_dynamic_bypass = opts.bypass ?? [];
    const warned: string[] = [];
    const info: string[] = [];
    server.logger.warn = ((message: string) => {
      warned.push(String(message));
      return server.logger;
    }) as unknown as typeof server.logger.warn;
    server.logger.info = ((message: string) => {
      info.push(String(message));
      return server.logger;
    }) as unknown as typeof server.logger.info;

    if (opts.token)
      await server.registerPlugin(
        'authToken',
        new AuthToken(
          opts.token === 'everywhere'
            ? server
            : server.withConfig({
                ...server.config,
                auth_path_prefix: [opts.token],
              })
        )
      );
    if (opts.dynamic) {
      const dynamic = new AuthzDynamic(server);
      await server.registerPlugin('authzDynamic', dynamic);
      await dynamic.reload();
    }
    if (opts.perBranch)
      await server.registerPlugin(
        'authzPerBranch',
        new AuthzPerBranch(
          server.withConfig({ ...server.config, ...opts.perBranch })
        )
      );
    await server.registerPlugin('writer', new Writer(server, () => targetDn));
    server.setupErrorMiddleware();
    let startup: Error | undefined;
    try {
      assertAuthzComposition(server);
    } catch (err) {
      startup = err as Error;
    }
    return { server, request: supertest(server.app), warned, info, startup };
  };

  describe('the AND, as it was', () => {
    it('should let a token write where its ACLs allow it, alone', async () => {
      const { request, startup } = await build({ dynamic: true });
      expect(startup).to.equal(undefined);
      const res = await request
        .put('/api/test/write')
        .set('Authorization', `Bearer ${DYNAMIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('should refuse it beside a branch plugin whose configuration does not name the tenant, and say who refused', async () => {
      // The combination the issue opens on, kept loadable through the
      // opt-in so the AND itself stays pinned: the token's ACLs cover the
      // branch, `authzPerBranch`'s default grants no write, and the first
      // refusal wins.
      const { request, warned, startup } = await build({
        dynamic: true,
        perBranch: {},
        combine: true,
      });
      expect(startup).to.equal(undefined);
      const res = await request
        .put('/api/test/write')
        .set('Authorization', `Bearer ${DYNAMIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(
        warned.some(m =>
          m.startsWith('authzPerBranch refused ldapmodifyrequest')
        ),
        warned.join('\n')
      ).to.equal(true);
      // The name goes to the log, never to the client.
      expect(JSON.stringify(res.body)).to.not.match(/authzPerBranch/);
    });

    it('should refuse a token write on the default branch configuration, with no other plugin at all', async () => {
      // The cheapest form of the accident: `authz_per_branch_config` has a
      // non-empty default, so the branch model judges every authenticated
      // identity — reads pass on `read: true`, writes are refused.
      const { request, info, startup } = await build({
        token: 'everywhere',
        perBranch: {},
      });
      expect(startup).to.equal(undefined);
      const res = await request
        .put('/api/test/write')
        .set('Authorization', `Bearer ${STATIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      // Said at startup, naming the authenticator it judges.
      expect(
        info.some(
          m =>
            m.startsWith('authzPerBranch judges') &&
            m.includes('every authenticated request (authToken)')
        ),
        info.join('\n')
      ).to.equal(true);
    });
  });

  describe('at startup', () => {
    it('should refuse two plugins judging the same requests, naming both', async () => {
      const { startup } = await build({ dynamic: true, perBranch: {} });
      expect(startup, 'refused').to.be.instanceOf(Error);
      expect(startup!.message).to.include('authzDynamic and authzPerBranch');
      expect(startup!.message).to.include('--authz-combine');
    });

    it('should refuse two branch-level plugins, naming both', async () => {
      const server = new DM();
      await server.ready;
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
      expect(() => assertAuthzComposition(server)).to.throw(
        /authzPerBranch and authzLinid1/
      );
      server.config.authz_combine = true;
      expect(() => assertAuthzComposition(server)).to.not.throw();
    });

    it('should accept them once each serves its own authenticators', async () => {
      const { startup } = await build({
        dynamic: true,
        token: '/api/other',
        perBranch: { authz_for: ['authToken'] },
      });
      expect(startup).to.equal(undefined);
    });

    it('should refuse an authz_for naming no loaded authenticator', async () => {
      // It would judge nobody, which reads as a working configuration.
      const { startup } = await build({
        dynamic: true,
        perBranch: { authz_for: ['oidc'] },
      });
      expect(startup).to.be.instanceOf(Error);
      expect(startup!.message).to.match(/authz_for names oidc/);
    });

    it('should refuse an authz_for that is not a list of names', async () => {
      const server = new DM();
      await server.ready;
      expect(
        () =>
          new AuthzPerBranch(
            server.withConfig({
              ...server.config,
              authz_for: [42] as unknown as string[],
            })
          )
      ).to.throw(/authz_for must list/);
    });

    it('should only warn when the populations meet through two credentials on one path', async () => {
      // Two authenticators on the same prefix both run: a request carrying
      // both credentials is judged by both. Asking for two credentials is
      // already a decision, so this is said rather than refused.
      const { startup, warned } = await build({
        dynamic: true,
        token: 'everywhere',
        perBranch: { authz_for: ['authToken'] },
      });
      expect(startup).to.equal(undefined);
      expect(
        warned.some(m => m.includes('authzDynamic and authzPerBranch judge')),
        warned.join('\n')
      ).to.equal(true);
    });
  });

  describe('authz_for', () => {
    it('should let each population be judged by its own model', async () => {
      const { request, warned } = await build({
        dynamic: true,
        token: '/api/other',
        perBranch: { authz_for: ['authToken'] },
      });
      // The dynamic token: authzPerBranch does not serve authzDynamic, so
      // the token's own ACLs decide.
      const dynamic = await request
        .put('/api/test/write')
        .set('Authorization', `Bearer ${DYNAMIC_TOKEN}`);
      expect(dynamic.status, JSON.stringify(dynamic.body)).to.equal(200);
      expect(dynamic.body.authenticators).to.deep.equal(['authzDynamic']);
      // The static token: authzPerBranch serves it, and its default
      // configuration grants no write.
      const stat = await request
        .put('/api/other/write')
        .set('Authorization', `Bearer ${STATIC_TOKEN}`);
      expect(stat.status, JSON.stringify(stat.body)).to.equal(403);
      expect(
        warned.some(m =>
          m.startsWith('authzPerBranch refused ldapmodifyrequest')
        )
      ).to.equal(true);
    });

    it('should skip another population and judge its own, at the hook', async () => {
      const server = new DM();
      await server.ready;
      await server.registerPlugin(
        'authzPerBranch',
        new AuthzPerBranch(
          server.withConfig({ ...server.config, authz_for: ['a', 'b'] })
        )
      );
      const write = (req: Partial<DmRequest>): Promise<unknown> =>
        launchHooksChained(server.hooks.ldapmodifyrequest, [
          targetDn,
          { replace: { description: 'x' } },
          0,
          req as DmRequest,
        ]);
      // Another population: skipped, not judged.
      await write({ user: 'x', authenticators: ['c'] });
      // Its own, alone or beside another: judged, and refused on write.
      for (const authenticators of [['a'], ['c', 'b']]) {
        let refused = false;
        await write({ user: 'x', authenticators }).catch(() => {
          refused = true;
        });
        expect(refused, authenticators.join(',')).to.equal(true);
      }
      // An identity nobody vouched for is judged: "not mine" is never
      // inferred from an absence.
      for (const authenticators of [undefined, []]) {
        let refused = false;
        await write({ user: 'x', authenticators }).catch(() => {
          refused = true;
        });
        expect(refused, String(authenticators)).to.equal(true);
      }
    });

    it('should scope authzPerRoute the same way', async () => {
      const server = new DM();
      await server.ready;
      server.config.authz_per_route = ['someone:GET:/api/nothing'];
      let vouched: string[] = [];
      server.app.use((req, _res, next) => {
        (req as DmRequest).user = 'x';
        (req as DmRequest).authenticators = vouched;
        next();
      });
      await server.registerPlugin(
        'authzPerRoute',
        new AuthzPerRoute(
          server.withConfig({ ...server.config, authz_for: ['a'] })
        )
      );
      server.app.get('/api/probe', (_req, res) => {
        res.json({ ok: true });
      });
      const request = supertest(server.app);
      vouched = ['c'];
      expect((await request.get('/api/probe')).status).to.equal(200);
      vouched = ['a'];
      expect((await request.get('/api/probe')).status).to.equal(403);
    });
  });

  describe('through the plugin loader', () => {
    const DYNAMIC = '../../dist/plugins/auth/authzDynamic.js';
    const PER_BRANCH = '../../dist/plugins/auth/authzPerBranch.js';
    const env: Record<string, string | undefined> = {};

    before(() => {
      for (const k of ['DM_PLUGINS', 'NODE_ENV']) env[k] = process.env[k];
      process.env.NODE_ENV = 'test';
    });

    after(() => {
      for (const [k, v] of Object.entries(env))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });

    it('should not start on the ambiguous composition', async () => {
      process.env.DM_PLUGINS = [DYNAMIC, PER_BRANCH].join(';');
      const server = new DM();
      let refused: Error | undefined;
      await server.ready.catch((err: Error) => {
        refused = err;
      });
      expect(refused, 'ready rejected').to.be.instanceOf(Error);
      // Named in hook order, which is registration order — here the
      // parallel batch, so either way round.
      expect(refused!.message).to.match(
        /authzDynamic and authzPerBranch|authzPerBranch and authzDynamic/
      );
    });

    it('should start once the branch plugin is scoped away from the tokens', async () => {
      process.env.DM_PLUGINS = [
        DYNAMIC,
        '../../dist/plugins/auth/token.js:authOther:{"auth_path_prefix":"/api/other"}',
        `${PER_BRANCH}:authzPerBranch:{"authz_for":["authOther"]}`,
      ].join(';');
      const server = new DM();
      await server.ready;
      expect(Object.keys(server.loadedPlugins)).to.include.members([
        'authzDynamic',
        'authOther',
        'authzPerBranch',
      ]);
    });
  });

  describe('what the dispatcher records', () => {
    it('should not record a plugin that only stepped aside', async () => {
      // authzDynamic lets the static token through on its bypass without a
      // token of its own: it did not vouch for the request, and a plugin
      // scoped to it must not judge it.
      const { request } = await build({
        token: 'everywhere',
        dynamic: true,
        bypass: [STATIC_USER],
      });
      const res = await request
        .put('/api/test/write')
        .set('Authorization', `Bearer ${STATIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.authenticators).to.deep.equal(['authToken']);
    });
  });
});
