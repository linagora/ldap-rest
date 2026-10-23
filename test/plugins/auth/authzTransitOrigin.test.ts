/**
 * `--authz-transit-origin-attribute`: an entry put in transit keeps the
 * organization it leaves, and loses it when it is claimed, so that who claims
 * it can tell where it comes from.
 *
 * The option is spelt both as the schema does and in lower case: LDAP
 * ignores the case of attribute names, and so must the comparisons.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars } from '../../helpers/env';

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
 * A server with the transit branch and its origin attribute as given, and
 * one administrator writing two organizations.
 */
function originSuite(
  title: string,
  option: string,
  withTransit: boolean,
  tests: (ctx: OriginContext) => void
): void {
  describe(title, function () {
    const ctx = {} as OriginContext;
    const saved: Record<string, string | undefined> = {};
    const prefix = `origin.${option.toLowerCase()}.${withTransit ? 't' : 'n'}`;
    ctx.uid = (name: string) => `${prefix}.${name}`;
    const names = ['moved', 'modified', 'loose', 'typed'];

    before(function () {
      skipIfMissingEnvVars(this, [
        'DM_LDAP_DN',
        'DM_LDAP_PWD',
        'DM_LDAP_BASE',
        'DM_LDAP_TOP_ORGANIZATION',
      ]);
    });

    before(async function () {
      this.timeout(20000);
      const top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      ctx.userBranch = `ou=users,${process.env.DM_LDAP_BASE}`;
      ctx.sales = `ou=OriginSales,${top}`;
      ctx.backend = `ou=OriginBackend,${top}`;
      ctx.transit = `ou=OriginTransit,${top}`;

      const rw = { read: true, write: true, delete: false };
      const env: Record<string, string | undefined> = {
        DM_AUTHZ_FILTER_ATTACHED_ENTRIES: 'true',
        DM_AUTHZ_TRANSIT_BRANCH: withTransit ? ctx.transit : undefined,
        DM_AUTHZ_TRANSIT_ORIGIN_ATTRIBUTE: option,
        DM_LDAP_FLAT_SCHEMA: './static/schemas/twake/users.json',
        DM_AUTHZ_PER_BRANCH_CONFIG: JSON.stringify({
          default: { read: false, write: false, delete: false },
          users: {
            [ADMIN]: { [ctx.sales]: rw, [ctx.backend]: rw, [ctx.transit]: rw },
          },
          groups: {},
        }),
      };
      for (const [key, value] of Object.entries(env)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      ctx.server = new DM();
      await ctx.server.ready;

      for (const [dn, ou] of [
        [ctx.sales, 'OriginSales'],
        [ctx.backend, 'OriginBackend'],
        [ctx.transit, 'OriginTransit'],
      ]) {
        await ctx.server.ldap.delete(dn).catch(() => undefined);
        await ctx.server.ldap.add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou,
          twakeDepartmentPath: ou,
        });
      }

      const account = (uid: string, org: string | null): AttributesList => ({
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid,
        cn: uid,
        sn: 'Origin',
        givenName: 'Test',
        displayName: 'Test Origin',
        mail: `${uid}@example.com`,
        ...(org
          ? { twakeDepartmentLink: org, twakeDepartmentPath: 'OriginOrg' }
          : {}),
      });
      for (const name of names) {
        const uid = ctx.uid(name);
        await ctx.server.ldap
          .delete(`uid=${uid},${ctx.userBranch}`)
          .catch(() => undefined);
        await ctx.server.ldap.add(
          `uid=${uid},${ctx.userBranch}`,
          account(uid, name === 'loose' ? null : ctx.sales)
        );
      }

      await ctx.server.registerPlugin(
        'testAuth',
        new TestAuthPlugin(ctx.server)
      );
      await ctx.server.registerPlugin(
        'authzPerBranch',
        new AuthzPerBranch(ctx.server)
      );
      await ctx.server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(ctx.server)
      );
      ctx.server.setupErrorMiddleware();
      ctx.request = supertest(ctx.server.app);
    });

    after(async () => {
      for (const name of names)
        await ctx.server.ldap
          .delete(`uid=${ctx.uid(name)},${ctx.userBranch}`)
          .catch(() => undefined);
      for (const dn of [ctx.sales, ctx.backend, ctx.transit])
        await ctx.server.ldap.delete(dn).catch(() => undefined);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    ctx.move = (name: string, targetOrgDn: string) =>
      ctx.request
        .post(`/api/v1/ldap/users/${ctx.uid(name)}/move`)
        .set(as(ADMIN))
        .send({ targetOrgDn });
    ctx.origin = async (name: string): Promise<unknown> => {
      const res = (await ctx.server.ldap.search(
        { paged: false, scope: 'base', attributes: [ORIGIN] },
        `uid=${ctx.uid(name)},${ctx.userBranch}`
      )) as SearchResult;
      const value = res.searchEntries[0]?.[ORIGIN];
      return Array.isArray(value) ? value[0] : value;
    };

    tests(ctx);
  });
}

interface OriginContext {
  server: DM;
  request: ReturnType<typeof supertest>;
  userBranch: string;
  sales: string;
  backend: string;
  transit: string;
  uid(name: string): string;
  move(name: string, targetOrgDn: string): supertest.Test;
  origin(name: string): Promise<unknown>;
}

const ADMIN = 'origin.admin';
const ORIGIN = 'departmentNumber';
const as = (user: string) => ({
  'X-Test-User': user,
  Accept: 'application/json',
});

for (const option of [ORIGIN, ORIGIN.toLowerCase()])
  originSuite(
    `Transit branch: where an entry comes from (${option})`,
    option,
    true,
    ctx => {
      it('records the organization an entry leaves for transit', async () => {
        expect((await ctx.move('moved', ctx.transit)).status).to.equal(200);
        expect(await ctx.origin('moved')).to.equal(ctx.sales);
      });

      it('keeps it from transit to transit', async () => {
        await ctx.server.ldap.modify(
          `uid=${ctx.uid('moved')},${ctx.userBranch}`,
          { delete: ['twakeDepartmentLink'] }
        );
        expect(await ctx.origin('moved')).to.equal(ctx.sales);
      });

      it('removes it when the entry is claimed', async () => {
        expect((await ctx.move('moved', ctx.backend)).status).to.equal(200);
        expect(await ctx.origin('moved')).to.equal(undefined);
      });

      it('records it when the link itself is modified', async () => {
        const res = await ctx.request
          .put(`/api/v1/ldap/users/${ctx.uid('modified')}`)
          .set(as(ADMIN))
          .send({ replace: { twakeDepartmentLink: ctx.transit } });
        expect(res.status).to.equal(200);
        expect(await ctx.origin('modified')).to.equal(ctx.sales);
      });

      it('claims an entry attached to nothing without an origin', async () => {
        expect((await ctx.move('loose', ctx.backend)).status).to.equal(200);
        expect(await ctx.origin('loose')).to.equal(undefined);
      });

      it('leaves alone a modify that names the attribute itself', async () => {
        await ctx.server.ldap.modify(
          `uid=${ctx.uid('typed')},${ctx.userBranch}`,
          { replace: { twakeDepartmentLink: ctx.transit, [ORIGIN]: 'typed' } }
        );
        expect(await ctx.origin('typed')).to.equal('typed');
      });
    }
  );

originSuite('Transit origin without a transit branch', ORIGIN, false, ctx => {
  it('records nothing', async () => {
    expect((await ctx.move('moved', ctx.transit)).status).to.equal(200);
    expect(await ctx.origin('moved')).to.equal(undefined);
  });
});
