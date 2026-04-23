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
        Operations: [
          { op: 'remove', path: 'members[value eq "alice"]' },
        ],
      },
      {
        mapping: DEFAULT_USER_MAPPING,
        resolveMemberRef: async v =>
          `uid=${v},ou=users,dc=example,dc=com`,
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
      expect(
        (r.name as Record<string, unknown>).givenName
      ).to.equal('Alice');
      expect(r.userName).to.be.undefined;
    });
  });
});
