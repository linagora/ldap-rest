/**
 * A flat entry may be named by a full DN, `uid=<value>,<base>`. The value the
 * entry is written with is the one its DN gives it, and reading it costs one
 * pass: a DN the directory refuses is answered without a pattern trying every
 * way of splitting a run of escapes.
 */
import { expect } from 'chai';

import { assertedRdnValue, namesByDn, rdnValue } from '../../src/lib/utils';

const B = String.fromCharCode(92);
const base = 'ou=users,dc=example,dc=com';

describe('assertedRdnValue', () => {
  it('reads the value of a DN in the branch', () => {
    expect(assertedRdnValue(`uid=bob,${base}`, 'uid', base)).to.equal('bob');
  });

  it('keeps the spaces a backslash puts in the value', () => {
    // An escaped space is a space of the value: the entry is written with
    // it, and it is what its DN names
    expect(assertedRdnValue(`uid=${B} bob,${base}`, 'uid', base)).to.equal(
      ' bob'
    );
    expect(assertedRdnValue(`uid=a${B} b,${base}`, 'uid', base)).to.equal(
      'a b'
    );
  });

  it('reads a quoted value holding a + as one assertion', () => {
    // LDAPv2 quotes a whole value: `splitRdn` and `normalizeDn` see one
    // assertion here, and so does this reader, which keeps the quotes as
    // `rdnValue` does
    expect(assertedRdnValue(`uid="a+b",${base}`, 'uid', base)).to.equal(
      '"a+b"'
    );
  });

  it('reads a value whose escapes decode to the name it names', () => {
    // The hex pairs of UTF-8 and the character are one name
    expect(
      assertedRdnValue(`uid=caf${B}C3${B}A9,${base}`, 'uid', base)
    ).to.equal('café');
  });

  it('decodes the escapes of the value, as the entry is named', () => {
    // `uid=Smith\,John` names the entry "Smith,John": the name is the value
    // of its RDN, as `rdnValue` reads it
    expect(
      assertedRdnValue(`uid=Smith${B},John,${base}`, 'uid', base)
    ).to.equal('Smith,John');
  });

  it('reads a bare RDN without a branch', () => {
    expect(assertedRdnValue(`cn=Sales${B}, EMEA`, 'cn')).to.equal(
      'Sales, EMEA'
    );
  });

  it('reads nothing from a DN naming another attribute', () => {
    expect(assertedRdnValue(`cn=bob,${base}`, 'uid', base)).to.equal(null);
  });

  it('reads nothing from a DN outside the branch', () => {
    expect(
      assertedRdnValue('uid=bob,ou=other,dc=example,dc=com', 'uid', base)
    ).to.equal(null);
  });

  it('reads nothing from a multi-valued RDN', () => {
    expect(assertedRdnValue(`uid=bob+cn=bob,${base}`, 'uid', base)).to.equal(
      null
    );
  });

  it('reads a plain identifier as no DN', () => {
    expect(assertedRdnValue('bob.joe@example.org', 'uid', base)).to.equal(null);
  });

  it('reads a run of escapes in linear time', () => {
    // The pattern it replaced backtracked on a value the optional `(?:,.*)?`
    // could not end: the cost doubled with each escape. The run is kept small
    // enough that such a reader finishes it, so a regression fails here.
    const n = 26;
    const dn = `uid=${`${B}a`.repeat(n)},${base}`;
    // A line break the trailing group cannot cross, as in the advisory
    const id = `${dn}${String.fromCharCode(10)}`;
    assertedRdnValue(dn, 'uid', base); // warm-up
    const start = process.hrtime.bigint();
    expect(assertedRdnValue(id, 'uid', base)).to.equal('a'.repeat(n));
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsed).to.be.below(50);
  });
});

describe('namesByDn', () => {
  it('tells a DN from a bare name', () => {
    expect(namesByDn(`uid=bob,${base}`, 'uid')).to.equal(true);
    expect(namesByDn('bob', 'uid')).to.equal(false);
    expect(namesByDn(`cn=bob,${base}`, 'uid')).to.equal(false);
  });

  it('still tells a DN whose value it would refuse', () => {
    // What `assertedRdnValue` reads as no name is not a bare name: a caller
    // deciding on it must keep the two apart
    expect(namesByDn(`uid=a+cn=b,${base}`, 'uid')).to.equal(true);
    expect(assertedRdnValue(`uid=a+cn=b,${base}`, 'uid', base)).to.equal(null);
  });
});
