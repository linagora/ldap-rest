import { expect } from 'chai';

import { scimFilterToLdap } from '../../../src/plugins/scim/filter';
import { DEFAULT_USER_MAPPING } from '../../../src/plugins/scim/mapping';
import { ScimError } from '../../../src/plugins/scim/errors';

describe('SCIM filter parser', () => {
  const m = DEFAULT_USER_MAPPING;

  describe('comparison operators', () => {
    it('translates eq string', () => {
      const r = scimFilterToLdap('userName eq "alice"', m);
      expect(r.ldapFilter).to.equal('(uid=alice)');
    });
    it('translates ne string', () => {
      const r = scimFilterToLdap('userName ne "alice"', m);
      expect(r.ldapFilter).to.equal('(!(uid=alice))');
    });
    it('translates co (contains)', () => {
      const r = scimFilterToLdap('displayName co "ali"', m);
      expect(r.ldapFilter).to.equal('(displayName=*ali*)');
    });
    it('translates sw (starts with)', () => {
      const r = scimFilterToLdap('displayName sw "Al"', m);
      expect(r.ldapFilter).to.equal('(displayName=Al*)');
    });
    it('translates ew (ends with)', () => {
      const r = scimFilterToLdap('displayName ew "ce"', m);
      expect(r.ldapFilter).to.equal('(displayName=*ce)');
    });
    it('translates pr (present)', () => {
      const r = scimFilterToLdap('displayName pr', m);
      expect(r.ldapFilter).to.equal('(displayName=*)');
    });
    it('translates gt / ge / lt / le', () => {
      expect(scimFilterToLdap('displayName gt "A"', m).ldapFilter).to.match(
        /^\(&\(displayName>=A\)\(!\(displayName=A\)\)\)$/
      );
      expect(scimFilterToLdap('displayName ge "A"', m).ldapFilter).to.equal(
        '(displayName>=A)'
      );
      expect(scimFilterToLdap('displayName lt "Z"', m).ldapFilter).to.match(
        /^\(&\(displayName<=Z\)\(!\(displayName=Z\)\)\)$/
      );
      expect(scimFilterToLdap('displayName le "Z"', m).ldapFilter).to.equal(
        '(displayName<=Z)'
      );
    });
  });

  describe('logic combinators', () => {
    it('and combines', () => {
      const r = scimFilterToLdap(
        'userName eq "alice" and displayName pr',
        m
      );
      expect(r.ldapFilter).to.equal('(&(uid=alice)(displayName=*))');
    });
    it('or combines', () => {
      const r = scimFilterToLdap(
        'userName eq "alice" or userName eq "bob"',
        m
      );
      expect(r.ldapFilter).to.equal('(|(uid=alice)(uid=bob))');
    });
    it('not negates', () => {
      const r = scimFilterToLdap('not (userName eq "alice")', m);
      expect(r.ldapFilter).to.equal('(!(uid=alice))');
    });
    it('parentheses override precedence', () => {
      const r = scimFilterToLdap(
        '(userName eq "a" or userName eq "b") and displayName pr',
        m
      );
      expect(r.ldapFilter).to.equal(
        '(&(|(uid=a)(uid=b))(displayName=*))'
      );
    });
  });

  describe('sub-attribute paths', () => {
    it('name.familyName → sn', () => {
      const r = scimFilterToLdap('name.familyName eq "Doe"', m);
      expect(r.ldapFilter).to.equal('(sn=Doe)');
    });
    it('emails.value → mail', () => {
      const r = scimFilterToLdap('emails.value co "@example.com"', m);
      // emails maps to primary=mail per default mapping
      expect(r.ldapFilter).to.equal('(mail=*@example.com*)');
    });
  });

  describe('id short-circuit', () => {
    it('id eq "foo" returns idEquals', () => {
      const r = scimFilterToLdap('id eq "foo"', m);
      expect(r.touchesId).to.be.true;
      expect(r.idEquals).to.equal('foo');
    });
  });

  describe('active pseudo-attribute', () => {
    it('active eq true → disabled-account filter', () => {
      const r = scimFilterToLdap('active eq true', m);
      expect(r.ldapFilter).to.equal('(!(pwdAccountLockedTime=*))');
    });
    it('active eq false', () => {
      const r = scimFilterToLdap('active eq false', m);
      expect(r.ldapFilter).to.equal('(pwdAccountLockedTime=*)');
    });
  });

  describe('security: LDAP injection escaping', () => {
    it('escapes asterisk', () => {
      const r = scimFilterToLdap('userName eq "a*b"', m);
      expect(r.ldapFilter).to.equal('(uid=a\\2ab)');
    });
    it('escapes parentheses', () => {
      const r = scimFilterToLdap('userName eq "a(b)c"', m);
      expect(r.ldapFilter).to.equal('(uid=a\\28b\\29c)');
    });
    it('escapes backslash', () => {
      const r = scimFilterToLdap('userName eq "a\\\\b"', m);
      expect(r.ldapFilter).to.equal('(uid=a\\5cb)');
    });
  });

  describe('errors', () => {
    it('unknown attribute throws invalidFilter', () => {
      expect(() => scimFilterToLdap('nosuch eq "x"', m)).to.throw(ScimError);
    });
    it('malformed filter throws', () => {
      expect(() => scimFilterToLdap('userName eq', m)).to.throw(ScimError);
    });
    it('unterminated string throws', () => {
      expect(() => scimFilterToLdap('userName eq "unfinished', m)).to.throw(
        ScimError
      );
    });
  });

  describe('edge cases', () => {
    it('empty filter returns objectClass=*', () => {
      const r = scimFilterToLdap('', m);
      expect(r.ldapFilter).to.equal('(objectClass=*)');
    });
    it('whitespace-only filter returns objectClass=*', () => {
      const r = scimFilterToLdap('   ', m);
      expect(r.ldapFilter).to.equal('(objectClass=*)');
    });
    it('null values', () => {
      const r = scimFilterToLdap('displayName eq null', m);
      expect(r.ldapFilter).to.equal('(!(displayName=*))');
    });
  });
});
