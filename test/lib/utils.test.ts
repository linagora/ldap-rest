import { expect } from 'chai';
import {
  escapeDnValue,
  unescapeDnValue,
  escapeLdapFilter,
  validateDnValue,
  parseDn,
  getParentDn,
  getRdn,
  isChildOf,
  normalizeDn,
  isDnInBranch,
  organizationLink,
} from '../../src/lib/utils';
import { BadRequestError } from '../../src/lib/errors';

describe('LDAP Utils', () => {
  describe('escapeDnValue', () => {
    it('should escape comma in DN values', () => {
      expect(escapeDnValue('Smith, John')).to.equal('Smith\\, John');
    });

    it('should escape plus sign in DN values', () => {
      expect(escapeDnValue('user+admin')).to.equal('user\\+admin');
    });

    it('should escape backslash in DN values', () => {
      expect(escapeDnValue('path\\to\\file')).to.equal('path\\\\to\\\\file');
    });

    it('should escape multiple special characters', () => {
      expect(escapeDnValue('a,b+c=d')).to.equal('a\\,b\\+c\\=d');
    });

    it('should escape leading space', () => {
      expect(escapeDnValue(' leadingspace')).to.equal('\\ leadingspace');
    });

    it('should escape trailing space', () => {
      expect(escapeDnValue('trailingspace ')).to.equal('trailingspace\\ ');
    });

    it('should escape leading hash', () => {
      expect(escapeDnValue('#comment')).to.equal('\\#comment');
    });

    it('should escape quotes and angle brackets', () => {
      expect(escapeDnValue('"test"')).to.equal('\\"test\\"');
      expect(escapeDnValue('<tag>')).to.equal('\\<tag\\>');
    });

    it('should handle normal strings without escaping', () => {
      expect(escapeDnValue('normaluser123')).to.equal('normaluser123');
    });
  });

  describe('unescapeDnValue', () => {
    it('should unescape comma in DN values', () => {
      expect(unescapeDnValue('Smith\\, John')).to.equal('Smith, John');
    });

    it('should unescape plus sign in DN values', () => {
      expect(unescapeDnValue('user\\+admin')).to.equal('user+admin');
    });

    it('should unescape backslash in DN values', () => {
      expect(unescapeDnValue('path\\\\to\\\\file')).to.equal('path\\to\\file');
    });

    it('should unescape multiple special characters', () => {
      expect(unescapeDnValue('a\\,b\\+c\\=d')).to.equal('a,b+c=d');
    });

    it('should reject a non-string with a forged length', () => {
      expect(() =>
        unescapeDnValue({ length: 1e100 } as unknown as string)
      ).to.throw(BadRequestError, 'must be a string');
    });

    it('should unescape leading space', () => {
      expect(unescapeDnValue('\\ leadingspace')).to.equal(' leadingspace');
    });

    it('should unescape trailing space', () => {
      expect(unescapeDnValue('trailingspace\\ ')).to.equal('trailingspace ');
    });

    it('should unescape leading hash', () => {
      expect(unescapeDnValue('\\#comment')).to.equal('#comment');
    });

    it('should unescape quotes and angle brackets', () => {
      expect(unescapeDnValue('\\"test\\"')).to.equal('"test"');
      expect(unescapeDnValue('\\<tag\\>')).to.equal('<tag>');
    });

    it('should handle hex-encoded characters', () => {
      expect(unescapeDnValue('user\\00name')).to.equal('user\0name');
      expect(unescapeDnValue('path\\5cname')).to.equal('path\\name');
    });

    it('should decode hex escapes as UTF-8 bytes', () => {
      expect(unescapeDnValue('ACME-\\C3\\A9')).to.equal('ACME-é');
      expect(unescapeDnValue('\\E2\\82\\AC\\2C\\F0\\9F\\98\\80')).to.equal(
        '€,😀'
      );
    });

    it('should keep an escaped U+FEFF instead of stripping it as a BOM', () => {
      expect(unescapeDnValue('a\\EF\\BB\\BFb')).to.equal('a\uFEFFb');
      expect(unescapeDnValue('\\EF\\BB\\BFabc')).to.equal('\uFEFFabc');
    });

    it('should keep invalid UTF-8 hex escapes as one char per byte', () => {
      expect(unescapeDnValue('caf\\E9')).to.equal('café');
    });

    it('should handle normal strings without changes', () => {
      expect(unescapeDnValue('normaluser123')).to.equal('normaluser123');
    });

    it('should be the inverse of escapeDnValue', () => {
      const original = 'Smith, John+Admin';
      expect(unescapeDnValue(escapeDnValue(original))).to.equal(original);
    });

    it('should roundtrip complex values', () => {
      const values = [
        'user+admin',
        'Smith, John',
        'path\\to\\file',
        '"quoted"',
        '<tag>',
        '#comment',
        ' leadingspace',
        'trailingspace ',
        'a,b+c=d<e>f;g"h',
      ];
      for (const val of values) {
        expect(unescapeDnValue(escapeDnValue(val))).to.equal(val);
      }
    });
  });

  describe('escapeLdapFilter', () => {
    it('should escape asterisk in filter values', () => {
      expect(escapeLdapFilter('user*')).to.equal('user\\2a');
    });

    it('should escape parentheses in filter values', () => {
      expect(escapeLdapFilter('(admin)')).to.equal('\\28admin\\29');
    });

    it('should escape backslash in filter values', () => {
      expect(escapeLdapFilter('path\\name')).to.equal('path\\5cname');
    });

    it('should handle complex filter injection attempts', () => {
      // Attempt to inject: )(uid=*)
      const malicious = ')(uid=*)';
      const escaped = escapeLdapFilter(malicious);
      expect(escaped).to.equal('\\29\\28uid=\\2a\\29');
    });
  });

  describe('validateDnValue', () => {
    it('should accept valid alphanumeric values', () => {
      expect(() => validateDnValue('user123', 'uid')).to.not.throw();
    });

    it('should accept values with allowed special characters', () => {
      expect(() =>
        validateDnValue('john.doe@example.com', 'mail')
      ).to.not.throw();
      expect(() => validateDnValue('Smith, John', 'cn')).to.not.throw();
      expect(() => validateDnValue("O'Brien", 'sn')).to.not.throw();
    });

    it('should reject null character', () => {
      expect(() => validateDnValue('user\x00name', 'uid')).to.throw(
        'uid contains invalid control characters'
      );
    });

    it('should reject newline characters', () => {
      expect(() => validateDnValue('user\nname', 'uid')).to.throw(
        'uid contains invalid control characters'
      );
      expect(() => validateDnValue('user\rname', 'uid')).to.throw(
        'uid contains invalid control characters'
      );
    });

    it('should reject tab character', () => {
      expect(() => validateDnValue('user\tname', 'uid')).to.throw(
        'uid contains invalid control characters'
      );
    });

    it('should reject zero-width space', () => {
      expect(() => validateDnValue('user\u200Bname', 'uid')).to.throw(
        'uid contains invalid invisible characters'
      );
    });

    it('should reject BOM character', () => {
      expect(() => validateDnValue('\uFEFFuser', 'uid')).to.throw(
        'uid contains invalid invisible characters'
      );
    });

    it('should reject empty string', () => {
      expect(() => validateDnValue('', 'uid')).to.throw(
        'uid must be a non-empty string'
      );
    });

    it('should reject whitespace-only string', () => {
      expect(() => validateDnValue('   ', 'uid')).to.throw(
        'uid must be a non-empty string'
      );
    });

    it('should include field name in error message', () => {
      expect(() =>
        validateDnValue('bad\x00value', 'organizationalUnit')
      ).to.throw('organizationalUnit contains invalid control characters');
    });
  });

  describe('parseDn', () => {
    it('should parse simple DN', () => {
      const parts = parseDn('uid=user,ou=users,dc=example,dc=com');
      expect(parts).to.deep.equal([
        'uid=user',
        'ou=users',
        'dc=example',
        'dc=com',
      ]);
    });

    it('should handle escaped commas in DN', () => {
      const parts = parseDn('cn=Smith\\, John,ou=users,dc=example,dc=com');
      expect(parts).to.deep.equal([
        'cn=Smith\\, John',
        'ou=users',
        'dc=example',
        'dc=com',
      ]);
    });

    // CWE-834: a JSON body can forge `.length`, e.g. {"dn": {"length": 1e100}},
    // which would drive the parsing loop for 10^100 iterations.
    it('should reject a non-string with a forged length instead of looping', () => {
      const forged = { length: 1e100 } as unknown as string;
      expect(() => parseDn(forged)).to.throw(
        BadRequestError,
        'must be a string'
      );
      expect(() => getParentDn(forged)).to.throw(BadRequestError);
      expect(() => normalizeDn(forged)).to.throw(BadRequestError);
      expect(() => isDnInBranch(forged, 'dc=example,dc=com')).to.throw(
        BadRequestError
      );
    });

    it('should answer with a 400 status code', () => {
      try {
        parseDn(undefined as unknown as string);
        expect.fail('parseDn should have thrown');
      } catch (err) {
        expect((err as BadRequestError).statusCode).to.equal(400);
      }
    });
  });

  describe('getParentDn', () => {
    it('should return parent DN', () => {
      expect(getParentDn('uid=user,ou=users,dc=example,dc=com')).to.equal(
        'ou=users,dc=example,dc=com'
      );
    });

    it('should return same DN if no parent', () => {
      expect(getParentDn('dc=com')).to.equal('dc=com');
    });
  });

  describe('getRdn', () => {
    it('should return first RDN component', () => {
      expect(getRdn('uid=user,ou=users,dc=example,dc=com')).to.equal(
        'uid=user'
      );
    });
  });

  describe('isChildOf', () => {
    it('should return true for direct child', () => {
      expect(
        isChildOf(
          'uid=user,ou=users,dc=example,dc=com',
          'ou=users,dc=example,dc=com'
        )
      ).to.be.true;
    });

    it('should return false for same DN', () => {
      expect(
        isChildOf('ou=users,dc=example,dc=com', 'ou=users,dc=example,dc=com')
      ).to.be.false;
    });

    it('should return false for unrelated DNs', () => {
      expect(
        isChildOf(
          'uid=user,ou=users,dc=example,dc=com',
          'ou=groups,dc=example,dc=com'
        )
      ).to.be.false;
    });
  });

  describe('normalizeDn', () => {
    it('should lowercase and drop whitespace around separators', () => {
      expect(normalizeDn('UID=x, ou=AppAccounts ,dc=Example,dc=com')).to.equal(
        'uid=x,ou=appaccounts,dc=example,dc=com'
      );
    });

    it('should collapse whitespace around the = of an RDN', () => {
      expect(normalizeDn('ou = AppAccounts , dc = example')).to.equal(
        'ou=appaccounts,dc=example'
      );
    });

    it('should order multi-valued RDN assertions deterministically', () => {
      expect(normalizeDn('ou=b+cn=a,dc=example')).to.equal(
        normalizeDn('cn=a+ou=b,dc=example')
      );
    });

    it('should preserve escaped commas as a single RDN', () => {
      expect(normalizeDn('cn=Smith\\, John,ou=users')).to.equal(
        'cn=smith\\, john,ou=users'
      );
    });

    it('spells an escape one way, whatever the directory wrote', () => {
      for (const [a, b] of [
        ['ou=Sales\\2C EMEA', 'ou=Sales\\, EMEA'],
        ['ou=Sales\\20EMEA', 'ou=Sales EMEA'],
        ['ou=\\23Sales', 'ou=\\#Sales'],
        ['ou=Sales\\2B EMEA', 'ou=Sales\\+ EMEA'],
        ['ou=caf\\C3\\A9', 'ou=café'],
        ['ou=a\\4D', 'ou=aM'],
        // Not UTF-8: the ASCII pair is still read
        ['ou=x\\FF\\2C', 'ou=x\\ff\\,'],
      ])
        expect(normalizeDn(a), a).to.equal(normalizeDn(b));
    });

    it('drops the spaces the matching rules ignore, escaped or not', () => {
      for (const spelled of [
        'ou=Sales\\ ,dc=x',
        'ou=Sales\\20,dc=x',
        'ou=\\20Sales,dc=x',
        'ou= Sales ,dc=x',
      ])
        expect(normalizeDn(spelled), spelled).to.equal('ou=sales,dc=x');
      expect(normalizeDn('ou=Sales  \\20EMEA,dc=x')).to.equal(
        'ou=sales emea,dc=x'
      );
      // A non-breaking space, raw or escaped, is a space
      for (const spelled of ['ou=a\u00a0b,dc=x', 'ou=a\\C2\\A0b,dc=x'])
        expect(normalizeDn(spelled), spelled).to.equal('ou=a b,dc=x');
      expect(normalizeDn('ou=a\u3000\u00a0 b,dc=x')).to.equal('ou=a b,dc=x');
      // Not those the directory keeps apart
      for (const other of ['\u1680', '\u2028', '\u2029'])
        expect(normalizeDn(`ou=a${other}b,dc=x`)).to.not.equal('ou=a b,dc=x');
      // A tab is not
      expect(normalizeDn('ou=a\\09b,dc=x')).to.not.equal('ou=a b,dc=x');
    });

    it('keeps the # that an escape protects', () => {
      expect(normalizeDn('ou=\\23x,dc=x')).to.equal('ou=\\#x,dc=x');
      // The BER form is another value
      expect(normalizeDn('ou=#0c0178,dc=x')).to.not.equal(
        normalizeDn('ou=\\#0c0178,dc=x')
      );
    });

    it('is idempotent', () => {
      for (const dn of [
        'ou=Sales\\20,dc=x',
        'ou=\\20Sales,dc=x',
        'ou=\\23Sales,dc=x',
        'cn=a\\2Bb+sn=c,dc=x',
        'ou=a\\5c,dc=x',
        'ou=x\\FF\\2C,dc=x',
        'ou=caf\\C3\\A9,dc=x',
        'ou=a=b;c,dc=x',
      ])
        expect(normalizeDn(normalizeDn(dn)), dn).to.equal(normalizeDn(dn));
    });

    it('escapes the specials whether or not the writer did', () => {
      expect(normalizeDn('ou=a=b,dc=x')).to.equal(normalizeDn('ou=a\\=b,dc=x'));
    });

    it('reads Unicode equivalents as the directory does', () => {
      expect(normalizeDn('ou=cafe\u0301,dc=x')).to.equal(
        normalizeDn('ou=café,dc=x')
      );
      expect(normalizeDn('ou=\ufb01le,dc=x')).to.equal('ou=file,dc=x');
      // A fullwidth comma is a comma, so a special
      expect(normalizeDn('ou=a\uff0cb,dc=x')).to.equal('ou=a\\,b,dc=x');
    });

    it('reads a quoted value ending in an escaped backslash', () => {
      expect(normalizeDn(String.raw`ou="a\\",dc=x`)).to.equal(
        normalizeDn(String.raw`ou=a\\,dc=x`)
      );
    });

    it('reads a quote as a value only where it opens one', () => {
      expect(normalizeDn('cn=a"b,dc=x')).to.equal('cn=a\\"b,dc=x');
      expect(() => normalizeDn('uid=x,ou="payroll,dc=x')).to.throw(
        /unbalanced quote/
      );
    });

    it('reads the LDAPv2 separators and quotes OpenLDAP accepts', () => {
      expect(normalizeDn('ou=a; dc=x;dc=y')).to.equal('ou=a,dc=x,dc=y');
      expect(normalizeDn('ou="a,b;c",dc=x')).to.equal(
        normalizeDn('ou=a\\,b\\;c,dc=x')
      );
      expect(normalizeDn('cn="a+b"+sn=c,dc=x')).to.equal(
        normalizeDn('sn=c+cn=a\\+b,dc=x')
      );
    });

    it('reads an attribute type by any of its names or its OID', () => {
      for (const spelled of [
        'organizationalUnitName=Payroll,dc=x',
        '2.5.4.11=Payroll,dc=x',
        'OID.2.5.4.11=Payroll,dc=x',
        'OU=Payroll,domainComponent=x',
      ])
        expect(normalizeDn(spelled), spelled).to.equal('ou=payroll,dc=x');
    });

    it('keeps an escaped backslash apart from the hex that follows', () => {
      expect(normalizeDn('ou=a\\5c2C')).to.equal(normalizeDn('ou=a\\\\2C'));
      expect(normalizeDn('ou=a\\5c2C')).to.not.equal(normalizeDn('ou=a\\,'));
    });

    it('splits a multi-valued RDN on unescaped plus signs only', () => {
      // One assertion: its value holds the `+` and the `=`
      expect(normalizeDn('cn=a\\+sn=b,dc=x')).to.equal('cn=a\\+sn\\=b,dc=x');
      expect(normalizeDn('sn=b+cn=a,dc=x')).to.equal('cn=a+sn=b,dc=x');
    });
  });

  describe('isDnInBranch', () => {
    it('does not read an escaped comma as a separator', () => {
      expect(isDnInBranch('cn=x\\2Cou=pub,ou=acme', 'ou=pub,ou=acme')).to.equal(
        false
      );
      expect(isDnInBranch('cn=x\\2Cou=pub,ou=acme', 'ou=acme')).to.equal(true);
    });

    it('should return true for a descendant', () => {
      expect(
        isDnInBranch(
          'uid=alice_c1,ou=appAccounts,dc=example,dc=com',
          'ou=appAccounts,dc=example,dc=com'
        )
      ).to.be.true;
    });

    it('should return true for the base itself', () => {
      expect(
        isDnInBranch(
          'ou=appAccounts,dc=example,dc=com',
          'ou=appAccounts,dc=example,dc=com'
        )
      ).to.be.true;
    });

    it('should be insensitive to case and whitespace (the cascade-guard hardening)', () => {
      expect(
        isDnInBranch(
          'uid=alice_c1, ou=AppAccounts, dc=example, dc=com',
          'ou=appaccounts,dc=example,dc=com'
        )
      ).to.be.true;
    });

    it('should tolerate a trailing newline/space in the configured base', () => {
      expect(
        isDnInBranch(
          'uid=alice_c1,ou=appAccounts,dc=example,dc=com',
          'ou=appAccounts,dc=example,dc=com\n'
        )
      ).to.be.true;
    });

    it('should return false for a different branch', () => {
      expect(
        isDnInBranch(
          'uid=user,ou=users,dc=example,dc=com',
          'ou=appAccounts,dc=example,dc=com'
        )
      ).to.be.false;
    });

    it('should not match on a non-aligned suffix', () => {
      // "accounts,dc=example,dc=com" is a raw-string suffix but NOT an RDN-aligned one
      expect(
        isDnInBranch(
          'uid=x,ou=otheraccounts,dc=example,dc=com',
          'ou=accounts,dc=example,dc=com'
        )
      ).to.be.false;
    });

    it('should return false when base is empty', () => {
      expect(isDnInBranch('uid=x,ou=a,dc=c', '')).to.be.false;
    });
  });

  describe('organizationLink', () => {
    it('reads the first value naming an organization', () => {
      expect(organizationLink(['', 'ou=a,dc=x'])).to.equal('ou=a,dc=x');
      expect(organizationLink(['  ', 'ou=a,dc=x'])).to.equal('ou=a,dc=x');
      expect(organizationLink('')).to.equal(undefined);
      expect(organizationLink([])).to.equal(undefined);
    });
  });
});
