import { expect } from 'chai';

import {
  patchToModifyRequest,
  applyPatchToResource,
} from '../../../src/plugins/scim/patch';
import { DEFAULT_USER_MAPPING } from '../../../src/plugins/scim/mapping';
import { ScimError } from '../../../src/plugins/scim/errors';

describe('SCIM PATCH applicator', () => {
  // The entry the operations are played against. Empty unless a case needs
  // the attribute to already be there.
  const ctx = { mapping: DEFAULT_USER_MAPPING, current: {} };
  const withEntry = (current: Record<string, string | string[]>) => ({
    ...ctx,
    current,
  });

  it('add on an absent attribute sets it', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'displayName', value: 'Alice' }],
      },
      ctx
    );
    // The emitted request says what the entry must end up holding, so an
    // add on an attribute that was not there is a replace.
    expect(req.replace).to.deep.equal({ displayName: 'Alice' });
    expect(req.add).to.be.undefined;
  });

  it('add on a multi-valued attribute keeps what is there', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'add', path: 'emails', value: [{ value: 'b@x.test' }] },
        ],
      },
      withEntry({ mail: 'a@x.test' })
    );
    expect(req.replace).to.deep.equal({ mail: ['a@x.test', 'b@x.test'] });
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

  it('remove deletes an attribute the entry holds', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: 'displayName' }],
      },
      withEntry({ displayName: 'Alice' })
    );
    expect(req.delete).to.deep.equal({ displayName: '' });
  });

  it('remove sends nothing when the entry does not hold it', async () => {
    // Deleting an absent attribute answers noSuchAttribute and fails the
    // whole modify, taking the operations sent alongside it down too.
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'remove', path: 'displayName' },
          { op: 'replace', path: 'title', value: 'CEO' },
        ],
      },
      ctx
    );
    expect(req.delete).to.be.undefined;
    expect(req.replace).to.deep.equal({ title: 'CEO' });
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

  it('applies operations in order, last one wins', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'add', path: 'title', value: 'Dev' },
          { op: 'replace', path: 'displayName', value: 'Alice' },
          { op: 'replace', path: 'displayName', value: 'Alice Doe' },
        ],
      },
      withEntry({ displayName: 'Old' })
    );
    // RFC 7644 section 3.5.2 applies operations sequentially, so the second
    // displayName wins. Both used to land on the same key and the emitter
    // kept whichever it saw first.
    expect(req.replace).to.deep.equal({
      title: 'Dev',
      displayName: 'Alice Doe',
    });
    expect(req.delete).to.be.undefined;
  });

  it('a set then a remove in one request leaves nothing behind', async () => {
    const req = await patchToModifyRequest(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'add', path: 'title', value: 'contractor' },
          { op: 'remove', path: 'title' },
        ],
      },
      ctx
    );
    // The entry never held `title`, so the pair cancels out and nothing is
    // sent — where before the remove was dropped and the add survived.
    expect(req.replace).to.be.undefined;
    expect(req.delete).to.be.undefined;
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
        current: { member: 'cn=fakeuser' },
        resolveMemberRef: async v => {
          seen.push(v);
          return `uid=${v},ou=users,dc=example,dc=com`;
        },
      }
    );
    expect(seen).to.deep.equal(['alice', 'bob']);
    // The answer is the member list the group must end up with, existing
    // members included.
    expect(req.replace).to.deep.equal({
      member: [
        'cn=fakeuser',
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
        current: {
          member: [
            'uid=alice,ou=users,dc=example,dc=com',
            'uid=bob,ou=users,dc=example,dc=com',
          ],
        },
        resolveMemberRef: async v => `uid=${v},ou=users,dc=example,dc=com`,
      }
    );
    // Alice goes, Bob stays.
    expect(req.replace).to.deep.equal({
      member: 'uid=bob,ou=users,dc=example,dc=com',
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
        withEntry({ displayName: 'Alice' })
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
      current: {},
    };
    // An account that is currently locked.
    const lockedCtx = {
      ...activeCtx,
      current: { pwdAccountLockedTime: '000001010000Z' },
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
        lockedCtx
      );
      expect(req.delete).to.deep.equal({ pwdAccountLockedTime: '' });
    });

    it('remove active restores the default, an active account', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: 'active' }],
        },
        lockedCtx
      );
      expect(req.delete).to.deep.equal({ pwdAccountLockedTime: '' });
    });

    it('refuses a value it cannot read as a boolean', async () => {
      // Reading an unparseable value as `true` would turn a deprovisioning
      // request into a re-activation, and answer 200 while doing it.
      for (const value of ['0', 'no', 'disabled', '', 42, null]) {
        try {
          await patchToModifyRequest(
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'active', value }],
            },
            activeCtx
          );
          expect.fail(`should have thrown for ${JSON.stringify(value)}`);
        } catch (err) {
          expect(err).to.be.instanceOf(ScimError);
          expect((err as ScimError).scimType).to.equal('invalidValue');
        }
      }
    });

    it('refuses an add or replace with no value at all', async () => {
      // `{"op":"replace","path":"active"}` is a malformed request, not a
      // request to unlock. `remove` is the explicit way to say that.
      for (const op of ['add', 'replace'] as const) {
        try {
          await patchToModifyRequest(
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op, path: 'active' }],
            },
            activeCtx
          );
          expect.fail(`should have thrown for ${op}`);
        } catch (err) {
          expect(err).to.be.instanceOf(ScimError);
          expect((err as ScimError).scimType).to.equal('invalidValue');
        }
      }
    });

    it('sends nothing when the account is already active', async () => {
      // The unlock every identity provider re-asserts routinely. It used to
      // need pruning to avoid noSuchAttribute; now it simply is not a change.
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        },
        activeCtx
      );
      expect(req.replace).to.be.undefined;
      expect(req.delete).to.be.undefined;
    });

    it('honours the last of two operations on active', async () => {
      // Both land on the same LDAP attribute. Emitting a write and a delete
      // for one key let the order of the ModifyRequest decide, not the order
      // the client sent.
      const off = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'active', value: true },
            { op: 'replace', path: 'active', value: false },
          ],
        },
        activeCtx
      );
      expect(off.replace).to.deep.equal({
        pwdAccountLockedTime: '000001010000Z',
      });
      expect(off.delete).to.be.undefined;

      const on = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'active', value: false },
            { op: 'replace', path: 'active', value: true },
          ],
        },
        lockedCtx
      );
      expect(on.delete).to.deep.equal({ pwdAccountLockedTime: '' });
      expect(on.replace).to.be.undefined;
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
          { mapping: DEFAULT_USER_MAPPING, current: {} }
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidPath');
      }
    });
  });
});
