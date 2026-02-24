import { expect } from 'chai';
import {
  escapeDnValue,
  escapeLdapFilter,
  validateDnValue,
  parseDn,
  getParentDn,
  getRdn,
  isChildOf,
} from '../../src/lib/utils';

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
});
