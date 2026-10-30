/**
 * A write to an entry or a value the directory does not hold, and a DN it
 * cannot parse, are the client's mistakes: they answer 404 and 400, not a
 * 500 hiding it.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import { errorResponse } from '../../../src/lib/expressFormatedResponses';
import {
  AUTHZ_REFUSED,
  AuthzRefusedError,
  GatewayTimeoutError,
} from '../../../src/lib/errors';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Writes to what the directory does not hold', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let topOrg: string;
  let groupDn: string;
  let ghost: string;
  let alice: string;

  /** The status and LDAP code of a direct write. */
  const outcome = async (
    write: Promise<unknown>
  ): Promise<{ status: number | 'ok'; code?: number }> => {
    try {
      await write;
      return { status: 'ok' };
    } catch (err) {
      const e = err as { statusCode?: number; code?: number };
      return { status: e.statusCode ?? 500, code: e.code };
    }
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    ghost = `uid=codes.ghost,ou=users,${base}`;
    alice = `uid=codes.alice,ou=users,${base}`;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);

    await server.ldap.delete(alice).catch(() => undefined);
    await server.ldap.add(alice, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: 'codes.alice',
      cn: 'Codes Alice',
      sn: 'Alice',
      givenName: 'Codes',
      displayName: 'Codes Alice',
      mail: 'codes.alice@example.com',
      employeeNumber: 'COD0001',
      twakeDepartmentLink: topOrg,
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    });

    groupDn = `cn=codes-guild,${server.config.ldap_group_base}`;
    await server.ldap.delete(groupDn).catch(() => undefined);
    await server.ldap.add(groupDn, {
      objectClass: ['top', 'groupOfNames'],
      cn: 'codes-guild',
      member: [alice],
    });
  });

  after(async () => {
    for (const dn of [groupDn, alice])
      if (dn) await server.ldap.delete(dn).catch(() => undefined);
  });

  describe('ldapActions', () => {
    it('should answer 404 to a modify of a missing entry, keeping the code', async () => {
      expect(
        await outcome(
          server.ldap.modify(ghost, { replace: { description: 'x' } })
        )
      ).to.deep.equal({ status: 404, code: 32 });
    });

    it('should answer 404 to the deletion of a value the entry lacks', async () => {
      expect(
        await outcome(
          server.ldap.modify(groupDn, { delete: { member: ghost } })
        )
      ).to.deep.equal({ status: 404, code: 16 });
    });

    it('should answer 404 to a delete of a missing entry, keeping the code', async () => {
      expect(await outcome(server.ldap.delete(ghost))).to.deep.equal({
        status: 404,
        code: 32,
      });
    });
  });

  describe('a plugin wrapping its error', () => {
    /** A route whose handler throws what a plugin wrapped as `cause`. */
    const route = (path: string, thrown: () => Error): void => {
      server.app.get(path, () => {
        try {
          throw thrown();
        } catch (err) {
          throw new Error(`Failed to read it: ${String(err)}`, { cause: err });
        }
      });
      server.setupErrorMiddleware();
    };

    it('keeps the 403 of a refusal, and names no branch', async () => {
      route(
        '/api/plugin-wrapped-refusal',
        () => new AuthzRefusedError('User bob may not write ou=Sales,dc=x')
      );
      const res = await request.get('/api/plugin-wrapped-refusal');
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(res.body).to.deep.equal({
        error: AUTHZ_REFUSED,
        code: 'forbidden',
      });
    });

    it('keeps the status of a server error', async () => {
      route(
        '/api/plugin-wrapped-timeout',
        () => new GatewayTimeoutError('Upstream timeout')
      );
      const res = await request.get('/api/plugin-wrapped-timeout');
      expect(res.status, JSON.stringify(res.body)).to.equal(504);
      expect(res.body).to.deep.equal(
        errorResponse(new GatewayTimeoutError('Upstream timeout')).body
      );
    });
  });

  describe('on the routes', () => {
    it('should answer 404 to the removal of a DN that is not a member', async () => {
      const res = await request.delete(
        `/api/v1/ldap/groups/codes-guild/members/${encodeURIComponent(ghost)}`
      );
      expect(res.status, JSON.stringify(res.body)).to.equal(404);
      expect(res.body.error).to.equal(`${ghost} is not a member of ${groupDn}`);
    });

    it('should answer 400 to the read of an organization that is not a DN', async () => {
      const res = await request.get('/api/v1/ldap/organizations/garbage');
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.equal('garbage is not a valid DN');
    });

    for (const path of ['subnodes', 'subnodes/search?q=x', 'search?q=x'])
      it(`should answer 400 to ${path} under something that is not a DN`, async () => {
        const res = await request.get(
          `/api/v1/ldap/organizations/garbage/${path}`
        );
        expect(res.status, JSON.stringify(res.body)).to.equal(400);
        expect(res.body.error).to.equal('garbage is not a valid DN');
      });

    it('should answer 404 to the deletion of a missing organization', async () => {
      const dn = `ou=CodesNope,${topOrg}`;
      const res = await request.delete(
        `/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
      );
      expect(res.status, JSON.stringify(res.body)).to.equal(404);
      expect(res.body.error).to.equal(`Organization ${dn} not found`);
    });

    it('should answer 400 to a move towards something that is not a DN', async () => {
      const res = await request
        .post('/api/v1/ldap/users/codes.alice/move')
        .send({ targetOrgDn: 'garbage' });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.equal('garbage is not a valid DN');
    });

    it('should answer 404 to the move of a missing entry', async () => {
      const res = await request
        .post('/api/v1/ldap/users/codes.ghost/move')
        .send({ targetOrgDn: topOrg });
      expect(res.status, JSON.stringify(res.body)).to.equal(404);
      expect(res.body.error).to.equal(`Entry ${ghost} not found`);
    });
  });
});
