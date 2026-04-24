/**
 * Regression tests for the base-scope guard on LdapFlat operations.
 *
 * Context: every CRUD method of LdapFlat accepts an `id` that can be either
 * an RDN value or a full DN. Before the fix, only addEntry enforced that a
 * full DN had to terminate with `,this.base`. Callers scoped to one resource
 * (e.g. /ldap/titles) could pass a DN pointing at another branch (e.g.
 * ou=groups,...) and read/modify/delete entries outside the resource's scope.
 */

import { expect } from 'chai';
import supertest from 'supertest';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';
import { BadRequestError } from '../../../src/lib/errors';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('LdapFlat base-scope guard', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  let server: DM;
  let plugin: LdapFlatGeneric;
  let instance: LdapFlatGeneric['instances'][number];
  let request: any;
  let BASE: string;
  let TITLE_BRANCH: string;
  let FOREIGN_DN: string;

  before(async function () {
    this.timeout(5000);
    process.env.DM_LDAP_FLAT_SCHEMA =
      './static/schemas/twake/nomenclature/twakeTitle.json';
    server = new DM();
    await server.ready;
    plugin = new LdapFlatGeneric(server);
    await server.registerPlugin('ldapFlatBaseScope', plugin);
    request = supertest(server.app);
    instance = plugin.instances[0];
    BASE = process.env.DM_LDAP_BASE as string;
    TITLE_BRANCH = `ou=twakeTitle,ou=nomenclature,${BASE}`;
    // A DN that sits OUTSIDE the title branch — representative of the bypass
    FOREIGN_DN = `uid=admin,ou=users,${BASE}`;
  });

  /**
   * Encode the DN the way clients send it in the URL path.
   */
  const enc = (dn: string) => encodeURIComponent(dn);

  describe('direct method calls', () => {
    it('addEntry rejects a DN outside the branch', async () => {
      try {
        await instance.addEntry(FOREIGN_DN);
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
        expect((err as Error).message).to.match(/must be in the branch/i);
      }
    });

    it('modifyEntry rejects a DN outside the branch', async () => {
      try {
        await instance.modifyEntry(FOREIGN_DN, {
          replace: { description: 'hijacked' },
        });
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });

    it('deleteEntry rejects a DN outside the branch', async () => {
      try {
        await instance.deleteEntry(FOREIGN_DN);
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });

    it('renameEntry rejects a source DN outside the branch', async () => {
      try {
        await instance.renameEntry(FOREIGN_DN, 'cn=new');
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });

    it('renameEntry rejects a target DN outside the branch', async () => {
      try {
        await instance.renameEntry('cn=existing', FOREIGN_DN);
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });

    it('moveEntry rejects a DN outside the branch', async () => {
      try {
        await instance.moveEntry(FOREIGN_DN, TITLE_BRANCH);
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });
  });

  describe('HTTP API', () => {
    it('GET rejects a DN outside the branch', async () => {
      const res = await request.get(`/api/v1/ldap/titles/${enc(FOREIGN_DN)}`);
      expect(res.status).to.equal(400);
    });

    it('PUT rejects a DN outside the branch', async () => {
      const res = await request
        .put(`/api/v1/ldap/titles/${enc(FOREIGN_DN)}`)
        .send({ replace: { description: 'hijacked' } });
      expect(res.status).to.equal(400);
    });

    it('DELETE rejects a DN outside the branch', async () => {
      const res = await request.delete(
        `/api/v1/ldap/titles/${enc(FOREIGN_DN)}`
      );
      expect(res.status).to.equal(400);
    });

    it('POST /move rejects a source DN outside the branch', async () => {
      const res = await request
        .post(`/api/v1/ldap/titles/${enc(FOREIGN_DN)}/move`)
        .send({ targetOrgDn: TITLE_BRANCH });
      expect(res.status).to.equal(400);
    });

    it('POST (add) rejects a DN outside the branch in the main attribute', async () => {
      const res = await request
        .post('/api/v1/ldap/titles')
        .send({ cn: `cn=Foo,ou=somethingElse,${BASE}` });
      expect(res.status).to.equal(400);
    });
  });

  describe('positive path (in-branch DN still accepted)', () => {
    const uid = 'TestScopedTitle';
    const inBranchDn = () => `cn=${uid},${TITLE_BRANCH}`;

    afterEach(async () => {
      try {
        await instance.deleteEntry(uid);
      } catch (e) {
        // ignore
      }
    });

    it('accepts the full DN when it ends with the base (exact case)', async () => {
      await instance.addEntry(inBranchDn());
      const res = await request.get(`/api/v1/ldap/titles/${enc(inBranchDn())}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('cn', uid);
    });

    it('accepts the full DN with mixed-case suffix (LDAP is case-insensitive)', async () => {
      await instance.addEntry(uid);
      const mixedCase = `cn=${uid},OU=twakeTitle,ou=Nomenclature,${BASE}`;
      const res = await request.get(`/api/v1/ldap/titles/${enc(mixedCase)}`);
      // LDAP will resolve it (case-insensitive compare) — the guard must not block it
      expect(res.status).to.equal(200);
    });
  });
});
