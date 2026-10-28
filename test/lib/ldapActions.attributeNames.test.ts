/**
 * The names a write gives its attributes.
 *
 * The directory takes `MAIL`, `rfc822Mailbox` and `0.9.2342.19200300.100.1.3`
 * for `mail`; the authorization plugins and the hooks looked for `mail`. A
 * write naming an attribute otherwise was written, and the rules guarding it
 * never ran: the organization link given by its OID moved an account to an
 * organization its administrator may not write.
 */
import { expect } from 'chai';

import { DM } from '../../src/bin';
import type { AttributesList, SearchResult } from '../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

describe('Attribute names of a write', function () {
  let server: DM;
  let base: string;
  let dn: string;

  /** The names `entry` is written under */
  const names = async (entry: AttributesList): Promise<string[]> => {
    const copy = { ...entry };
    await server.ldap.canonicalAttributes(copy);
    return Object.keys(copy);
  };
  /** The status a write naming `entry` is refused with, if it is */
  const refusal = async (entry: AttributesList): Promise<number | 'ok'> => {
    try {
      await server.ldap.canonicalAttributes({ ...entry });
      return 'ok';
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    dn = `uid=names-test,ou=users,${base}`;
    server = new DM();
    await server.ready;
    await server.ldap.delete(dn).catch(() => undefined);
  });

  after(async () => {
    await server?.ldap.delete(dn).catch(() => undefined);
  });

  it('names an attribute as the server does, whatever its case, alias or OID', async () => {
    for (const [given, name] of [
      ['MAIL', 'mail'],
      ['rfc822Mailbox', 'mail'],
      ['0.9.2342.19200300.100.1.3', 'mail'],
      ['commonName', 'cn'],
      ['OID.2.5.4.3', 'cn'],
      ['OBJECTCLASS', 'objectClass'],
      // The Twake link, by the OID its schema gives it
      ['1.3.6.1.4.1.10943.1.50.1.1', 'twakeDepartmentLink'],
      ['TWAKEDEPARTMENTLINK', 'twakeDepartmentLink'],
    ])
      expect(await names({ [given]: 'x' }), given).to.deep.equal([name]);
  });

  it('spells a name as the configuration or a loaded schema does', async () => {
    const other = new DM();
    await other.ready;
    other.ldap.knowAttributeNames(['RANK']);
    const entry: AttributesList = { rank: 'x' };
    await other.ldap.canonicalAttributes(entry);
    expect(Object.keys(entry)).to.deep.equal(['RANK']);
  });

  it('resolves the names it knows of itself without the schema', async () => {
    const other = new DM();
    await other.ready;
    (
      other.ldap as unknown as { schemaIndex: () => Promise<never> }
    ).schemaIndex = () => Promise.reject(new Error('cn=Subschema unreadable'));
    // Names no option spells, so the standard table answers them
    for (const [given, name] of [
      ['C', 'c'],
      ['domainComponent', 'dc'],
      ['OID.0.9.2342.19200300.100.1.25', 'dc'],
      ['STATEORPROVINCENAME', 'st'],
    ]) {
      const entry: AttributesList = { [given]: 'x' };
      await other.ldap.canonicalAttributes(entry);
      expect(Object.keys(entry), given).to.deep.equal([name]);
    }
    for (const given of [
      '1.3.6.1.4.1.10943.1.50.1.1',
      'OID.OID.0.9.2342.19200300.100.1.25',
    ]) {
      let status: number | 'ok' = 'ok';
      try {
        await other.ldap.canonicalAttributes({ [given]: 'x' });
      } catch (err) {
        status = (err as { statusCode?: number }).statusCode ?? 500;
      }
      expect(status, given).to.equal(400);
    }
  });

  it('warns of a second name for one attribute', async () => {
    const other = new DM();
    await other.ready;
    const warned: string[] = [];
    const warn = other.logger.warn.bind(other.logger);
    (other.logger as unknown as { warn: unknown }).warn = (
      message: string,
      ...rest: unknown[]
    ) => {
      warned.push(String(message));
      return warn(message, ...rest);
    };
    // `mail` is the configuration's
    other.ldap.knowAttributeNames(['rfc822Mailbox', 'Mail', 'mail']);
    expect(warned.filter(m => /also named "mail"/.test(m))).to.have.length(2);
  });

  it('keeps ;binary, and refuses any other option', async () => {
    expect(await names({ 'USERCERTIFICATE;BINARY': 'x' })).to.deep.equal([
      'userCertificate;binary',
    ]);
    for (const given of ['member;lang-en', 'mail;x-tag', 'cn;binary;lang-fr'])
      expect(await refusal({ [given]: 'x' }), given).to.equal(400);
  });

  it('refuses a name that is not an attribute description', async () => {
    for (const given of [
      '__proto__',
      'OID.__proto__',
      'OID.OID.2.5.4.4',
      'mail address',
      '-mail',
      'mail.x',
      '2.5.4.',
      '',
    ])
      expect(await refusal({ [given]: 'x' }), given).to.equal(400);
    const entry = JSON.parse(
      '{"rfc822Mailbox":"x","__proto__":{"objectClass":["top"]}}'
    ) as AttributesList;
    await server.ldap.canonicalAttributes(entry).catch(() => undefined);
    expect(Object.getPrototypeOf(entry)).to.equal(Object.prototype);
    expect(Object.keys(entry)).to.deep.equal(['rfc822Mailbox', '__proto__']);
  });

  it('refuses one attribute named twice in one part of a write', async () => {
    expect(await refusal({ mail: 'a', MAIL: 'b' })).to.equal(400);
    expect(await refusal({ mail: 'a', rfc822Mailbox: 'b' })).to.equal(400);
    let status: number | 'ok' = 'ok';
    try {
      await server.ldap.canonicalChanges({ delete: ['mail', 'Mail'] });
    } catch (err) {
      status = (err as { statusCode?: number }).statusCode ?? 500;
    }
    expect(status).to.equal(400);
    // One part each: the directory applies them in turn
    await server.ldap.canonicalChanges({
      add: { mail: 'a' },
      delete: { MAIL: 'b' },
    });
  });

  it('writes under those names', async () => {
    await server.ldap.add(dn, {
      OBJECTCLASS: ['top', 'inetOrgPerson'],
      UID: 'names-test',
      commonName: 'Names',
      surname: 'Test',
      rfc822Mailbox: 'names-test@example.com',
    });
    await server.ldap.modify(dn, {
      replace: { '0.9.2342.19200300.100.1.3': 'names-other@example.com' },
    });
    const entry = (
      (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['mail', 'sn'] },
        dn
      )) as SearchResult
    ).searchEntries[0];
    expect(entry.mail).to.equal('names-other@example.com');
    expect(entry.sn).to.equal('Test');
  });

  // A rename writes the values of its new RDN on the entry, past every check
  // of a write: one value, of the attribute the entry is named by
  it('renames an entry by one value of the attribute it is named by', async () => {
    const users = `ou=users,${base}`;
    for (const newDn of [
      `uid=names-x+mail=taken@example.com,${users}`,
      `cn=names-test,${users}`,
      `2.5.4.3=names-test,${users}`,
    ]) {
      let status: number | 'ok' = 'ok';
      try {
        await server.ldap.rename(dn, newDn);
      } catch (err) {
        status = (err as { statusCode?: number }).statusCode ?? 500;
      }
      expect(status, newDn).to.equal(400);
    }
    // Under any spelling of that attribute
    const renamed = `userid=names-renamed,${users}`;
    await server.ldap.rename(dn, renamed);
    await server.ldap.rename(renamed, dn);
  });
});
