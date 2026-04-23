/**
 * Security / edge-case regression tests for the SCIM plugin.
 *
 * Each test here corresponds to a reviewer finding (Copilot / CodeQL) and
 * documents the intended behaviour — if any of these regresses, the related
 * class of vulnerability is back.
 */
import { expect } from 'chai';

import {
  patchToModifyRequest,
  applyPatchToResource,
} from '../../../src/plugins/scim/patch';
import { scimFilterToLdap } from '../../../src/plugins/scim/filter';
import { DEFAULT_USER_MAPPING } from '../../../src/plugins/scim/mapping';
import { ScimError } from '../../../src/plugins/scim/errors';

describe('SCIM security hardening', () => {
  describe('prototype pollution via PATCH paths', () => {
    it('rejects __proto__ in path', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'add', path: '__proto__', value: 'polluted' }],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidPath');
      }
    });

    it('rejects constructor in path', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'add', path: 'constructor', value: 'x' }],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
      }
    });

    it('rejects prototype in sub-attribute', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'add', path: 'name.prototype', value: 'x' }],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
      }
    });

    it('does not pollute Object.prototype via implicit-path value object', () => {
      const before = ({} as { polluted?: string }).polluted;
      applyPatchToResource(
        { schemas: [] as string[] } as unknown as Record<string, unknown>,
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            // Try to inject via implicit-path object
            {
              op: 'replace',
              value: { __proto__: { polluted: 'leak' } } as unknown as Record<
                string,
                unknown
              >,
            },
          ],
        }
      );
      const after = ({} as { polluted?: string }).polluted;
      expect(before, 'before should be undefined').to.be.undefined;
      expect(after, 'Object.prototype must remain unmutated').to.be.undefined;
    });

    it('does not pollute Object.prototype via sub-attribute key', async () => {
      const before = ({} as { polluted?: string }).polluted;
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [
              { op: 'add', path: 'name.__proto__', value: 'leak' },
            ],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
      } catch {
        /* expected */
      }
      const after = ({} as { polluted?: string }).polluted;
      expect(before).to.be.undefined;
      expect(after).to.be.undefined;
    });
  });

  describe('PATCH path parsing — ReDoS / malformed input', () => {
    it('rejects a pathological repeated pattern in bounded time', async () => {
      const malicious = '$.' + '.$'.repeat(200);
      const start = Date.now();
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'add', path: malicious, value: 'x' }],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
      } catch {
        /* expected invalidPath */
      }
      const elapsed = Date.now() - start;
      // Even a polynomial-backtracking regex would take much longer than
      // 1 s with 200 repetitions — we expect <100 ms.
      expect(elapsed, `parse took ${elapsed}ms`).to.be.lessThan(1000);
    });

    it('rejects paths longer than the hard limit', async () => {
      const oversize = 'a' + '.'.repeat(600);
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'add', path: oversize, value: 'x' }],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
      }
    });

    it('rejects a mismatched bracket', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [
              { op: 'add', path: 'emails[broken', value: 'x' },
            ],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
      }
    });
  });

  describe('PATCH coerceValue on complex arrays', () => {
    it('extracts .value from array of objects shaped like SCIM multi-valued entries', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            {
              op: 'replace',
              path: 'emails',
              value: [
                { value: 'a@b.com', primary: true },
                { value: 'c@d.com' },
              ],
            },
          ],
        },
        { mapping: DEFAULT_USER_MAPPING }
      );
      expect(req.replace).to.deep.equal({
        mail: ['a@b.com', 'c@d.com'],
      });
    });

    it('rejects an array containing objects without a scalar .value', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [
              {
                op: 'replace',
                path: 'emails',
                value: [{ nested: { deep: 'x' } }],
              },
            ],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidValue');
      }
    });
  });

  describe('PATCH bracket filters on non-members paths', () => {
    it('rejects emails[type eq "work"] with invalidPath', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [
              {
                op: 'replace',
                path: 'emails[type eq "work"].value',
                value: 'x@y.com',
              },
            ],
          },
          { mapping: DEFAULT_USER_MAPPING }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidPath');
      }
    });
  });

  describe('Filter — id pseudo-attribute restrictions', () => {
    it('accepts id eq "..." (short-circuit)', () => {
      const r = scimFilterToLdap('id eq "alice"', DEFAULT_USER_MAPPING);
      expect(r.idEquals).to.equal('alice');
    });

    it('rejects id pr', () => {
      expect(() =>
        scimFilterToLdap('id pr', DEFAULT_USER_MAPPING)
      ).to.throw(ScimError);
    });

    it('rejects id co "..."', () => {
      expect(() =>
        scimFilterToLdap('id co "x"', DEFAULT_USER_MAPPING)
      ).to.throw(ScimError);
    });

    it('rejects id ne "..." (not in short-circuit form)', () => {
      expect(() =>
        scimFilterToLdap('id ne "x"', DEFAULT_USER_MAPPING)
      ).to.throw(ScimError);
    });
  });

  describe('Filter — bracket filters rejected', () => {
    it('rejects emails[value eq "x"]', () => {
      expect(() =>
        scimFilterToLdap('emails[value eq "x"]', DEFAULT_USER_MAPPING)
      ).to.throw(ScimError);
    });

    it('rejects emails[type eq "work"]', () => {
      expect(() =>
        scimFilterToLdap('emails[type eq "work"]', DEFAULT_USER_MAPPING)
      ).to.throw(ScimError);
    });

    it('bracket-rejection error carries invalidFilter scimType', () => {
      try {
        scimFilterToLdap('emails[value eq "x"]', DEFAULT_USER_MAPPING);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as ScimError).scimType).to.equal('invalidFilter');
      }
    });
  });
});
