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
    // A DN that sits OUTSIDE the title branch — representative of the bypass.
    // We use the same RDN attribute (cn) as the title branch so the guard's
    // DN-detection triggers; different-attribute DNs are handled by the escape
    // path and tested separately below.
    FOREIGN_DN = `cn=hijacked,ou=users,${BASE}`;
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
        expect((err as Error).message).to.match(
          /must be a direct child of/i
        );
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
        await instance.renameEntry(FOREIGN_DN, 'NewTitleName');
        throw new Error('expected BadRequestError');
      } catch (err) {
        expect(err).to.be.instanceOf(BadRequestError);
      }
    });

    it('renameEntry rejects a target DN outside the branch', async () => {
      // Source is a valid in-branch DN so the rejection comes from the target.
      const validSource = `cn=some-existing,${TITLE_BRANCH}`;
      try {
        await instance.renameEntry(validSource, FOREIGN_DN);
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

    it('rejects a partial DN (prefix without base) rather than producing a malformed DN', () => {
      // Regression caught during review: "cn=foo" starts with the main
      // attribute but is not a full DN. It must be rejected cleanly by the
      // guard, not silently re-escaped into `cn=cn\=foo,<base>` with an
      // attribute value that no longer matches the RDN.
      expect(() =>
        (
          instance as unknown as { resolveDn: (id: string) => string }
        ).resolveDn('cn=foo')
      ).to.throw(BadRequestError, /must be a direct child of/i);
    });

    it('does not misclassify a main-attribute value containing a comma as a DN', () => {
      // Regression caught during review: with a naive comma-based heuristic,
      // values like "Smith, John" (legitimate for a cn-based branch) would be
      // treated as DNs and rejected by the suffix check. The guard must only
      // trigger when the id actually starts with `mainAttribute=`.
      const valueWithComma = 'Smith, John';
      const dn = (
        instance as unknown as { resolveDn: (id: string) => string }
      ).resolveDn(valueWithComma);
      expect(dn).to.equal(`cn=Smith\\, John,${TITLE_BRANCH}`);
    });
  });

  describe('escape-aware DN parsing (guards against RFC 4514 tricks)', () => {
    const callResolve = (dn: string) =>
      (
        instance as unknown as { resolveDn: (id: string) => string }
      ).resolveDn(dn);

    it('rejects a DN whose textual tail matches the base via an escaped comma in the first RDN', () => {
      // Attack: `cn=pwn\,ou=twakeTitle,ou=nomenclature,<BASE>` textually
      // ends with `,ou=twakeTitle,ou=nomenclature,<BASE>`, so a naive
      // `endsWith` check would accept it. But per RFC 4514 `\,` is a
      // literal comma inside the first RDN value, so the entry's real
      // parent is `ou=nomenclature,<BASE>` — a sibling of the titles
      // branch. Passing this DN through to ldapts would let a titles-API
      // caller create/read/modify/delete entries outside the titles
      // branch.
      const malicious = `cn=pwn\\,ou=twakeTitle,ou=nomenclature,${BASE}`;
      expect(() => callResolve(malicious)).to.throw(
        BadRequestError,
        /must be a direct child of/i
      );
    });

    it('rejects a DN whose tail matches via a deeply nested escaped comma', () => {
      // Same trick, one RDN deeper: the entry's real parent would be
      // `ou=other,<BASE>`, still outside the titles branch.
      const malicious = `cn=pwn\\,deep,ou=other,ou=twakeTitle,ou=nomenclature,${BASE}`;
      expect(() => callResolve(malicious)).to.throw(
        BadRequestError,
        /must be a direct child of/i
      );
    });

    it('rejects an HTTP DELETE with an escaped-comma bypass payload', async () => {
      // End-to-end: the decodeURIComponent'd path parameter must not reach
      // ldap.delete with a DN whose real parent is outside the branch.
      const malicious = `cn=pwn\\,ou=twakeTitle,ou=nomenclature,${BASE}`;
      const res = await request.delete(
        `/api/v1/ldap/titles/${enc(malicious)}`
      );
      expect(res.status).to.equal(400);
    });

    it('rejects an HTTP POST add with an escaped-comma bypass payload', async () => {
      const malicious = `cn=pwn\\,ou=twakeTitle,ou=nomenclature,${BASE}`;
      const res = await request
        .post('/api/v1/ldap/titles')
        .send({ cn: malicious });
      expect(res.status).to.equal(400);
    });

    it('still accepts a legitimate direct child of the base', () => {
      const dn = `cn=ValidTitle,${TITLE_BRANCH}`;
      expect(callResolve(dn)).to.equal(dn);
    });

    it('still accepts a direct child with an escaped comma in the RDN value', () => {
      // `cn=Smith\, John,<TITLE_BRANCH>` is a legitimate in-branch DN with a
      // literal comma inside the cn value. The parent is the branch, not a
      // sibling, so the guard must NOT reject it.
      const dn = `cn=Smith\\, John,${TITLE_BRANCH}`;
      expect(callResolve(dn)).to.equal(dn);
    });
  });
});
