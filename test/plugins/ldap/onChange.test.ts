import { expect } from 'chai';
import type { Entry } from 'ldapts';

import { DM } from '../../../src/bin';
import OnLdapChange, {
  diffEntries,
  type ChangesToNotify,
} from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';
import type { ChangeContext } from '../../../src/lib/changeContext';
import type { Request } from 'express';
import type DmPlugin from '../../../src/abstract/plugin';
import type { Hooks } from '../../../src/hooks';

type EntryChange = [string, Entry | null, Entry | null, ChangeContext];

describe('onChange', () => {
  describe('diffEntries', () => {
    const entry = (attrs: Record<string, string | string[]>): Entry => ({
      dn: 'uid=x,dc=example,dc=com',
      ...attrs,
    });

    it('ignores a single value against a one-element array', () => {
      expect(diffEntries(entry({ mail: 'a' }), entry({ mail: ['a'] }))).to.eql(
        {}
      );
    });

    it('ignores the order of multiple values', () => {
      expect(
        diffEntries(
          entry({ member: ['a', 'b'] }),
          entry({ member: ['b', 'a'] })
        )
      ).to.eql({});
    });

    it('matches attribute names whatever their case', () => {
      expect(diffEntries(entry({ Mail: 'a' }), entry({ mail: 'a' }))).to.eql(
        {}
      );
    });

    it('gives the full values of an attribute that changed', () => {
      expect(
        diffEntries(
          entry({ member: ['a', 'b'], cn: 'x' }),
          entry({ member: ['a', 'c'], cn: 'x' })
        )
      ).to.eql({
        member: [
          ['a', 'b'],
          ['a', 'c'],
        ],
      });
    });

    it('gives null for a side where the attribute is absent', () => {
      expect(diffEntries(null, entry({ cn: 'x' }))).to.eql({
        cn: [null, 'x'],
      });
      expect(diffEntries(entry({ cn: 'x' }), null)).to.eql({
        cn: ['x', null],
      });
    });
  });

  describe('hooks', () => {
    let dm: DM;
    let onChange: OnLdapChange;
    let base: string;
    let entryChanges: EntryChange[];
    let ldapChanges: [string, ChangesToNotify][];
    const created: string[] = [];

    const user = (uid: string) => `uid=${uid},${base}`;
    const addUser = async (
      uid: string,
      extra: Record<string, string[]> = {}
    ) => {
      const dn = user(uid);
      created.push(dn);
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid,
        cn: `${uid} cn`,
        sn: 'Doe',
        ...extra,
      });
      await waitFor(() => entryChanges.some(([d]) => d === dn), {
        what: `the add of ${dn}`,
      });
      entryChanges = [];
      ldapChanges = [];
      return dn;
    };
    // Hooks fire after the operation returns: a write that must fire nothing
    // is followed by one that must, and the first is judged once the second
    // has arrived.
    const settle = async (uid: string) => {
      const dn = user(`${uid}-marker`);
      created.push(dn);
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: `${uid}-marker`,
        cn: 'marker',
        sn: 'marker',
      });
      await waitFor(() => entryChanges.some(([d]) => d === dn));
    };

    before(async function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
      base = process.env.DM_LDAP_BASE!;
      dm = new DM();
      await dm.ready;
      onChange = new OnLdapChange(dm);
      await dm.registerPlugin('onLdapChange', onChange);
      dm.hooks.onLdapEntryChange = [
        (
          dn: string,
          before: Entry | null,
          after: Entry | null,
          context: ChangeContext
        ) => {
          entryChanges.push([dn, before, after, context]);
        },
      ];
      dm.hooks.onLdapChange = [
        (dn: string, changes: ChangesToNotify) => {
          ldapChanges.push([dn, changes]);
        },
      ];
    });

    beforeEach(() => {
      entryChanges = [];
      ldapChanges = [];
    });

    afterEach(async () => {
      for (const dn of created.splice(0)) {
        await dm.ldap.delete(dn).catch(() => undefined);
      }
    });

    it('gives the entry after an add, and nothing before', async () => {
      const dn = user('ochadd');
      created.push(dn);
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'ochadd',
        cn: 'Add',
        sn: 'Doe',
      });
      await waitFor(() => entryChanges.length > 0);
      const [got, before, after] = entryChanges[0];
      expect(got).to.equal(dn);
      expect(before).to.be.null;
      expect(after).to.include({ dn, cn: 'Add', sn: 'Doe' });
    });

    it('gives the whole entry before and after a modify', async () => {
      const dn = await addUser('ochmod', { mail: ['m@example.com'] });
      await dm.ldap.modify(dn, { replace: { sn: 'Smith' } });
      await waitFor(() => entryChanges.length > 0);
      const [, before, after] = entryChanges[0];
      expect(before).to.include({ sn: 'Doe', mail: 'm@example.com' });
      expect(after).to.include({ sn: 'Smith', mail: 'm@example.com' });
      expect(after).to.not.have.property('*');
      await waitFor(() => ldapChanges.length > 0);
      expect(ldapChanges[0][1]).to.eql({ sn: ['Doe', 'Smith'] });
    });

    it('fires nothing for a replace with the value already there', async () => {
      const dn = await addUser('ochnoop', { description: ['a', 'b'] });
      await dm.ldap.modify(dn, {
        replace: { sn: 'Doe', description: ['b', 'a'] },
      });
      await settle('ochnoop');
      expect(entryChanges.filter(([d]) => d === dn)).to.eql([]);
      expect(ldapChanges.filter(([d]) => d === dn)).to.eql([]);
    });

    it('observes a modify of an entry that has children', async () => {
      const ou = `ou=ochparent,${base}`;
      const child = `uid=ochchild,${ou}`;
      await dm.ldap.add(ou, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'ochparent',
      });
      await dm.ldap.add(child, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'ochchild',
        cn: 'Child',
        sn: 'Doe',
      });
      created.push(child, ou);
      entryChanges = [];
      await dm.ldap.modify(ou, { replace: { description: 'changed' } });
      await waitFor(() => entryChanges.some(([d]) => d === ou), {
        what: `the modify of ${ou}`,
      });
    });

    it('gives both DNs on a rename', async () => {
      const dn = await addUser('ochren');
      const newDn = user('ochren2');
      await dm.ldap.rename(dn, newDn);
      created.push(newDn);
      await waitFor(() => entryChanges.length > 0);
      const [got, before, after] = entryChanges[0];
      expect(got).to.equal(newDn);
      expect(before).to.include({ dn, uid: 'ochren' });
      expect(after).to.include({ dn: newDn, uid: 'ochren2' });
    });

    it('gives the entry before a delete, and nothing after', async () => {
      const dn = await addUser('ochdel');
      await dm.ldap.delete(dn);
      await waitFor(() => entryChanges.length > 0);
      const [got, before, after] = entryChanges[0];
      expect(got).to.equal(dn);
      expect(before).to.include({ dn, uid: 'ochdel' });
      expect(after).to.be.null;
    });

    it('gives an empty context to a write no request is behind', async () => {
      await addUser('ochsys');
      await dm.ldap.modify(user('ochsys'), { replace: { sn: 'Other' } });
      await waitFor(() => entryChanges.length > 0);
      expect(entryChanges[0][3]).to.eql({});
    });

    it('names the caller, and one id for every write of a request', async () => {
      const req = { user: 'token1', userName: 'Jane' } as unknown as Request;
      const dn = user('ochctx');
      created.push(dn);
      const ldap = dm.ldap.forRequest(req);
      await ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'ochctx',
        cn: 'Ctx',
        sn: 'Doe',
      });
      await ldap.modify(dn, { replace: { sn: 'Other' } });
      await waitFor(() => entryChanges.length >= 2);
      const [add, modify] = entryChanges.map(c => c[3]);
      expect(add).to.include({ actor: 'Jane', source: 'rest' });
      expect(add.requestId).to.be.a('string');
      expect(modify.requestId).to.equal(add.requestId);
    });

    describe('once a write is over, whatever became of it', () => {
      // A hook registered after onChange, as core/ldap/trash and
      // core/twake/tombstone are
      const later = <K extends keyof Hooks>(name: K, hook: unknown) => {
        const hooks = (dm.hooks[name] ??= []) as unknown[];
        hooks.push(hook);
        return () => hooks.splice(hooks.indexOf(hook), 1);
      };
      // Refuses once onChange has read the entry, and says how much it kept
      let keptWhenRefused = 0;
      const refuse = () => {
        keptWhenRefused = kept();
        throw new Error('refused');
      };
      const failure = async (write: Promise<unknown>) => {
        try {
          await write;
        } catch (e) {
          return e as Error;
        }
        throw new Error('the write was expected to fail');
      };
      const kept = () =>
        onChange.pendingDeletions.size +
        onChange.pendingRenames.size +
        Object.keys(onChange.stack).length;

      it('keeps nothing of a delete another plugin takes out of the request', async () => {
        const dn = await addUser('ochtaken');
        const remove = later(
          'ldapdeleterequest',
          ([, req]: [string[], Request?]) => [[], req]
        );
        try {
          await dm.ldap.delete(dn);
        } finally {
          remove();
        }
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        await settle('ochtaken');
        expect(entryChanges.filter(([d]) => d === dn)).to.eql([]);
      });

      it('keeps nothing of a delete refused after it was read', async () => {
        const dn = await addUser('ochdelref');
        const remove = later('ldapdeleterequest', refuse);
        try {
          expect((await failure(dm.ldap.delete(dn))).message).to.equal(
            'refused'
          );
        } finally {
          remove();
        }
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        expect(keptWhenRefused, 'kept when refused').to.equal(1);
      });

      it('keeps nothing of a delete the directory refuses', async () => {
        const ou = `ou=ochnonleaf,${base}`;
        await dm.ldap.add(ou, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'ochnonleaf',
        });
        const child = `uid=ochchild,${ou}`;
        await dm.ldap.add(child, {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'ochchild',
          cn: 'child',
          sn: 'Doe',
        });
        created.push(child, ou);
        const remove = later('ldapdeleterequest', (args: unknown) => {
          keptWhenRefused = kept();
          return args;
        });
        try {
          // Not a leaf (66)
          await failure(dm.ldap.delete(ou));
        } finally {
          remove();
        }
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        expect(keptWhenRefused, 'kept before the write').to.equal(1);
      });

      it('keeps nothing of a modify refused after it was read', async () => {
        const dn = await addUser('ochmodref');
        const remove = later('ldapmodifyrequest', refuse);
        try {
          expect(
            (await failure(dm.ldap.modify(dn, { replace: { sn: 'Other' } })))
              .message
          ).to.equal('refused');
        } finally {
          remove();
        }
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        expect(keptWhenRefused, 'kept when refused').to.equal(1);
      });

      it('keeps nothing of a modify the directory refuses', async () => {
        const dn = await addUser('ochmodbad');
        const remove = later('ldapmodifyrequest', (args: unknown) => {
          keptWhenRefused = kept();
          return args;
        });
        try {
          // inetOrgPerson holds no uidNumber
          await failure(dm.ldap.modify(dn, { replace: { uidNumber: 'x' } }));
        } finally {
          remove();
        }
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        expect(keptWhenRefused, 'kept before the write').to.equal(1);
      });

      it('publishes a delete while another of the same DN is refused', async () => {
        const dn = await addUser('ochrace');
        const allowed = {} as unknown as Request;
        const denied = {} as unknown as Request;
        // Ahead of onChange, as the authorization plugins are
        const hooks = dm.hooks.ldapdeleterequest!;
        const deny = ([d, req]: [string[], Request?]) => {
          if (req === denied) throw new Error('refused');
          return [d, req];
        };
        hooks.unshift(deny);
        // Holds the allowed delete once onChange has read the entry
        let open!: () => void;
        const gate = new Promise<void>(resolve => (open = resolve));
        const remove = later(
          'ldapdeleterequest',
          async ([d, req]: [string[], Request?]) => {
            if (req === allowed) await gate;
            return [d, req];
          }
        );
        try {
          const write = dm.ldap.delete(dn, allowed);
          await waitFor(() => onChange.pendingDeletions.size === 1, {
            what: 'the entry read',
          });
          expect((await failure(dm.ldap.delete(dn, denied))).message).to.equal(
            'refused'
          );
          // Let the refused delete's end hook run
          await new Promise(resolve => setImmediate(resolve));
          open();
          await write;
        } finally {
          // Released whatever failed, or the held delete would never end
          open();
          hooks.splice(hooks.indexOf(deny), 1);
          remove();
        }
        await waitFor(
          () => entryChanges.some(([d, , after]) => d === dn && after === null),
          { what: `the delete of ${dn}` }
        );
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
      });

      it('publishes a rename once when its request chain moves the entry', async () => {
        const dn = await addUser('ochrenmv');
        const away = user('ochrenmv-away');
        const newDn = user('ochrenmv2');
        // A later request hook moves the entry away and back: those moves
        // are not the rename, and must not take its snapshot
        const remove = later(
          'ldaprenamerequest',
          async ([from, to, req]: [string, string, Request?]) => {
            await dm.ldap.move(from, away);
            await dm.ldap.move(away, from);
            return [from, to, req];
          }
        );
        try {
          await dm.ldap.rename(dn, newDn);
        } finally {
          remove();
        }
        created.push(newDn);
        await waitFor(() => entryChanges.some(([d]) => d === newDn), {
          what: `the rename to ${newDn}`,
        });
        await settle('ochrenmv');
        const renames = entryChanges.filter(([, before]) => before?.dn === dn);
        expect(renames.map(([d]) => d)).to.eql([newDn]);
        expect(entryChanges.filter(([d]) => d === away)).to.eql([]);
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
      });

      it('publishes nothing for a move after a rename the directory refused', async () => {
        const dn = await addUser('ochrenbad');
        await addUser('ochrentaken');
        // The target exists (68)
        await failure(dm.ldap.rename(dn, user('ochrentaken')));
        await waitFor(() => kept() === 0, { what: 'the snapshot dropped' });
        // A move launches no ldaprenamerequest: there is nothing to publish,
        // and the snapshot of the failed rename must not stand in for one
        const moved = user('ochrenmoved');
        await dm.ldap.move(dn, moved);
        created.push(moved);
        await settle('ochrenbad');
        expect(entryChanges.filter(([d]) => d === moved)).to.eql([]);
      });
    });

    describe('operational attributes', () => {
      const lock = { replace: { pwdAccountLockedTime: '000001010000Z' } };

      it('are not read while no plugin follows them', async () => {
        const dn = await addUser('ochlock1');
        await dm.ldap.modify(dn, lock);
        await settle('ochlock1');
        expect(entryChanges.filter(([d]) => d === dn)).to.eql([]);
      });

      it('are read on both sides once a plugin follows them', async () => {
        dm.loadedPlugins.follower = {
          followedOperationalAttributes: ['pwdAccountLockedTime'],
        } as unknown as DmPlugin;
        try {
          const dn = await addUser('ochlock2');
          await dm.ldap.modify(dn, lock);
          await waitFor(() => entryChanges.some(([d]) => d === dn));
          const [, before, after] = entryChanges.find(([d]) => d === dn)!;
          expect(before).to.not.have.property('pwdAccountLockedTime');
          expect(after).to.include({ pwdAccountLockedTime: '000001010000Z' });
        } finally {
          delete dm.loadedPlugins.follower;
        }
      });
    });
  });
});
