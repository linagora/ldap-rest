import { expect } from 'chai';
import type { Entry } from 'ldapts';

import { DM } from '../../../src/bin';
import OnLdapChange, {
  diffEntries,
  type ChangesToNotify,
} from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

type EntryChange = [string, Entry | null, Entry | null];

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
      await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
      dm.hooks.onLdapEntryChange = [
        (dn: string, before: Entry | null, after: Entry | null) => {
          entryChanges.push([dn, before, after]);
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
  });
});
