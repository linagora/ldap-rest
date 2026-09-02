import { expect } from 'chai';

import {
  patchToModifyRequest,
  applyPatchToResource,
} from '../../../src/plugins/scim/patch';
import { DEFAULT_USER_MAPPING } from '../../../src/plugins/scim/mapping';
import { ScimError } from '../../../src/plugins/scim/errors';

describe('SCIM PATCH applicator', () => {
  const ctx = { mapping: DEFAULT_USER_MAPPING };

  it('add simple attribute → { add: {...} }', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'displayName', value: 'Alice' }],
      },
      ctx
    );
    expect(req.add).to.deep.equal({ displayName: 'Alice' });
  });

  it('replace sub-attribute → { replace: {...} }', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'replace', path: 'name.familyName', value: 'Smith' },
        ],
      },
      ctx
    );
    expect(req.replace).to.deep.equal({ sn: 'Smith' });
  });

  it('remove attribute → { delete: {...} }', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: 'displayName' }],
      },
      ctx
    );
    expect(req.delete).to.deep.equal({ displayName: '' });
  });

  it('no-path op with value object fans out', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'replace', value: { displayName: 'Z', title: 'CEO' } },
        ],
      },
      ctx
    );
    expect(req.replace).to.deep.equal({ displayName: 'Z', title: 'CEO' });
  });

  it('multiple operations merge', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'add', path: 'title', value: 'Dev' },
          { op: 'replace', path: 'displayName', value: 'Alice' },
          { op: 'remove', path: 'nickName' },
        ],
      },
      ctx
    );
    expect(req.add).to.deep.equal({ title: 'Dev' });
    expect(req.replace).to.deep.equal({ displayName: 'Alice' });
    expect(req.delete).to.deep.equal({ displayName: '' });
  });

  it('member add resolves via resolveMemberRef', async () => {
    const seen: string[] = [];
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          {
            op: 'add',
            path: 'members',
            value: [{ value: 'alice' }, { value: 'bob' }],
          },
        ],
      },
      {
        mapping: DEFAULT_USER_MAPPING,
        memberAttribute: 'member',
        resolveMemberRef: async v => {
          seen.push(v);
          return `uid=${v},ou=users,dc=example,dc=com`;
        },
      }
    );
    expect(seen).to.deep.equal(['alice', 'bob']);
    expect(req.add).to.deep.equal({
      member: [
        'uid=alice,ou=users,dc=example,dc=com',
        'uid=bob,ou=users,dc=example,dc=com',
      ],
    });
  });

  it('member remove via value-path filter', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: 'members[value eq "alice"]' }],
      },
      {
        mapping: DEFAULT_USER_MAPPING,
        resolveMemberRef: async v => `uid=${v},ou=users,dc=example,dc=com`,
      }
    );
    expect(req.delete).to.deep.equal({
      member: ['uid=alice,ou=users,dc=example,dc=com'],
    });
  });

  it('unknown path throws invalidPath', async () => {
    try {
      await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'add', path: 'nosuch', value: 'x' }],
        },
        ctx
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ScimError);
      expect((err as ScimError).scimType).to.equal('invalidPath');
    }
  });

  it('unknown op throws invalidValue', async () => {
    try {
      await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          // @ts-expect-error — testing runtime validation
          Operations: [{ op: 'merge', path: 'displayName', value: 'x' }],
        },
        ctx
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ScimError);
    }
  });

  describe('applyPatchToResource', () => {
    it('applies add/replace/remove on a plain object', () => {
      const r = applyPatchToResource(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          displayName: 'Old',
          name: { familyName: 'Doe' },
        },
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'displayName', value: 'New' },
            { op: 'add', path: 'name.givenName', value: 'Alice' },
            { op: 'remove', path: 'userName' },
          ],
        }
      );
      expect(r.displayName).to.equal('New');
      expect((r.name as Record<string, unknown>).givenName).to.equal('Alice');
      expect(r.userName).to.be.undefined;
    });
  });

  describe('remove without a path (RFC 7644 section 3.5.2.2)', () => {
    it('is rejected with noTarget', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'remove', value: { displayName: 'Alice' } }],
          },
          ctx
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('noTarget');
        expect((err as ScimError).statusCode).to.equal(400);
      }
    });

    it('is rejected whatever the case of the op', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'Remove', value: { displayName: 'Alice' } }],
          },
          ctx
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as ScimError).scimType).to.equal('noTarget');
      }
    });

    it('leaves add and replace without a path working', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', value: { displayName: 'Alice' } }],
        },
        ctx
      );
      expect(req.replace).to.deep.equal({ displayName: 'Alice' });
    });

    it('still removes when a path is given', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: 'displayName' }],
        },
        ctx
      );
      expect(req.delete).to.deep.equal({ displayName: '' });
    });
  });

  describe('active (RFC 7643 section 4.1.1)', () => {
    const activeCtx = {
      mapping: DEFAULT_USER_MAPPING,
      supportsActive: true,
      lockAttribute: 'pwdAccountLockedTime',
      lockValue: '000001010000Z',
    };

    it('replace active=false writes the lock attribute', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        },
        activeCtx
      );
      expect(req.replace).to.deep.equal({
        pwdAccountLockedTime: '000001010000Z',
      });
    });

    it('replace active=true removes it', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        },
        activeCtx
      );
      expect(req.delete).to.deep.equal({ pwdAccountLockedTime: '' });
    });

    it('remove active restores the default, an active account', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: 'active' }],
        },
        activeCtx
      );
      expect(req.delete).to.deep.equal({ pwdAccountLockedTime: '' });
    });

    it('reads the string form identity providers sometimes send', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: 'False' }],
        },
        activeCtx
      );
      expect(req.replace).to.deep.equal({
        pwdAccountLockedTime: '000001010000Z',
      });
    });

    it('honours a configured lock attribute and value', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        },
        {
          ...activeCtx,
          lockAttribute: 'nsAccountLock',
          lockValue: 'TRUE',
        }
      );
      expect(req.replace).to.deep.equal({ nsAccountLock: 'TRUE' });
    });

    it('applies through a path-less operation', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', value: { active: false } }],
        },
        activeCtx
      );
      expect(req.replace).to.deep.equal({
        pwdAccountLockedTime: '000001010000Z',
      });
    });

    it('rejects a sub-attribute on active', async () => {
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active.value', value: false }],
          },
          activeCtx
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidPath');
      }
    });

    it('is still an unknown path on a resource without active', async () => {
      // Groups do not carry `active`.
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: false }],
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
});
