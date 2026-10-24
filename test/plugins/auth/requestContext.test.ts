/**
 * Every operation made while serving a request is judged as its caller
 * (#385).
 *
 * The authorization plugins judge an operation by the request it carries.
 * A route that forgot to hand it down used to be let through unjudged: the
 * operation looked like the server's own. The dispatcher now runs what
 * serves an authenticated request inside it, so a forgotten request fails
 * closed, while `ldap.system` steps out of it for the server's own work and
 * the hooks act as the server unless they name a request.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Express, Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import type { Hooks } from '../../../src/hooks';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { currentRequest } from '../../../src/lib/requestContext';
import { asyncHandler } from '../../../src/lib/utils';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const READER = 'context.reader';
const STRANGER = 'context.stranger';

/** Authentication reduced to a header */
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Routes reading one entry without handing the request down, as the
 * server, and a hook reading it when an entry is added.
 */
class Reader extends DmPlugin {
  name = 'contextReader';
  roles: Role[] = ['api'] as const;
  hookSaw: { found: number; request: boolean } | undefined;

  constructor(
    server: DM,
    private readonly target: () => string
  ) {
    super(server);
  }

  private async count(system: boolean): Promise<number> {
    const ldap = system ? this.server.ldap.system : this.server.ldap;
    const found = (await ldap.search(
      { paged: false, scope: 'base', attributes: ['1.1'] },
      this.target()
    )) as SearchResult;
    return found.searchEntries.length;
  }

  api(app: Express): void {
    app.get(
      '/api/test/context/forgotten',
      asyncHandler(async (_req: DmRequest, res: Response) => {
        res.json({ found: await this.count(false) });
      })
    );
    app.get(
      '/api/test/context/judge',
      asyncHandler(async (_req: DmRequest, res: Response) => {
        await this.server.ldap.authorize('ldapdeleterequest', [
          this.target(),
          undefined,
        ]);
        res.json({ judged: true });
      })
    );
    app.get(
      '/api/test/context/system',
      asyncHandler(async (_req: DmRequest, res: Response) => {
        res.json({ found: await this.count(true) });
      })
    );
  }

  hooks: Hooks = {
    ldapadddone: async () => {
      this.hookSaw = {
        found: await this.count(false),
        request: currentRequest() !== undefined,
      };
    },
  };
}

describe('Operations made while serving a request', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let reader: Reader;
  let branch: string;
  let target: string;
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    const base = process.env.DM_LDAP_BASE as string;
    branch = `ou=ctxbranch,${base}`;
    target = `uid=ctx-target,${branch}`;
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    ])
      previous[k] = process.env[k];
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [READER]: { [branch]: { read: true, write: true, delete: true } },
        [STRANGER]: { [`ou=elsewhere,${base}`]: { read: true, write: true } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';
    server = new DM();
    await server.ready;
    await server.ldap
      .add(branch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'ctxbranch',
      })
      .catch(() => undefined);
    await server.ldap
      .add(target, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'ctx-target',
        cn: 'ctx-target',
        sn: 'ctx-target',
      })
      .catch(() => undefined);
    reader = new Reader(server, () => target);
    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('contextReader', reader);
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [`uid=ctx-added,${branch}`, target, branch])
      await server.ldap.delete(dn).catch(() => undefined);
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('judges an operation that does not name the request as its caller', async () => {
    const allowed = await request
      .get('/api/test/context/forgotten')
      .set('X-Test-User', READER);
    expect(allowed.status, JSON.stringify(allowed.body)).to.equal(200);
    expect(allowed.body).to.deep.equal({ found: 1 });

    const refused = await request
      .get('/api/test/context/forgotten')
      .set('X-Test-User', STRANGER);
    expect(refused.status, JSON.stringify(refused.body)).to.equal(403);
  });

  it('has a write judged first as the caller, request named or not', async () => {
    const allowed = await request
      .get('/api/test/context/judge')
      .set('X-Test-User', READER);
    expect(allowed.status, JSON.stringify(allowed.body)).to.equal(200);
    const refused = await request
      .get('/api/test/context/judge')
      .set('X-Test-User', STRANGER);
    expect(refused.status, JSON.stringify(refused.body)).to.equal(403);
  });

  it('judges nothing the server makes as itself', async () => {
    const res = await request
      .get('/api/test/context/system')
      .set('X-Test-User', STRANGER);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.deep.equal({ found: 1 });
  });

  it('runs the hooks of an operation as the server', async () => {
    reader.hookSaw = undefined;
    // A route of the reader's caller adding an entry: the hook reads what
    // the caller could not
    await server.ldap.add(
      `uid=ctx-added,${branch}`,
      {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'ctx-added',
        cn: 'ctx-added',
        sn: 'ctx-added',
      },
      { user: READER, headers: {} } as unknown as DmRequest
    );
    for (let i = 0; i < 50 && !reader.hookSaw; i++)
      await new Promise(resolve => setTimeout(resolve, 20));
    expect(reader.hookSaw).to.deep.equal({ found: 1, request: false });
  });

  it('judges nothing outside a request', async () => {
    expect(currentRequest()).to.equal(undefined);
    const found = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['1.1'] },
      target
    )) as SearchResult;
    expect(found.searchEntries).to.have.length(1);
  });
});
