import { expect } from 'chai';

import {
  scimFilterToLdap,
  tokenize,
  type Token,
} from '../../../src/plugins/scim/filter';
import { DEFAULT_USER_MAPPING } from '../../../src/plugins/scim/mapping';
import { ScimError, scimInvalidFilter } from '../../../src/plugins/scim/errors';

// The tokenizer as it was before it classified characters by code and
// sliced string literals; the new one must agree with it on every input.
function referenceTokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'LPAREN', value: '(', pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'RPAREN', value: ')', pos: i });
      i++;
      continue;
    }
    if (c === '[') {
      tokens.push({ kind: 'LBRACK', value: '[', pos: i });
      i++;
      continue;
    }
    if (c === ']') {
      tokens.push({ kind: 'RBRACK', value: ']', pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      // String literal, with \" and \\ escapes
      const start = i;
      i++;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === '"') {
            value += '"';
            i += 2;
            continue;
          }
          if (next === '\\') {
            value += '\\';
            i += 2;
            continue;
          }
          if (next === 'n') {
            value += '\n';
            i += 2;
            continue;
          }
          if (next === 't') {
            value += '\t';
            i += 2;
            continue;
          }
        }
        value += input[i];
        i++;
      }
      if (i >= input.length) {
        throw scimInvalidFilter(
          `Unterminated string literal at position ${start}`
        );
      }
      i++; // skip closing "
      tokens.push({ kind: 'STRING', value, pos: start });
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (
        i < input.length &&
        /[0-9.+\-eE]/.test(input[i]) &&
        !/[\s()[\]]/.test(input[i])
      ) {
        i++;
      }
      tokens.push({ kind: 'NUMBER', value: input.slice(start, i), pos: start });
      continue;
    }
    // Word: identifier, keyword, or dotted path
    if (/[A-Za-z_$:]/.test(c)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_.$:]/.test(input[i])) {
        i++;
      }
      tokens.push({ kind: 'WORD', value: input.slice(start, i), pos: start });
      continue;
    }
    throw scimInvalidFilter(`Unexpected character '${c}' at position ${i}`);
  }
  tokens.push({ kind: 'EOF', value: '', pos: input.length });
  return tokens;
}

describe('SCIM filter parser', () => {
  // `active` is a Users-only pseudo-attribute.
  const USERS = { supportsActive: true };
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
      const r = scimFilterToLdap('userName eq "alice" and displayName pr', m);
      expect(r.ldapFilter).to.equal('(&(uid=alice)(displayName=*))');
    });
    it('or combines', () => {
      const r = scimFilterToLdap('userName eq "alice" or userName eq "bob"', m);
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
      expect(r.ldapFilter).to.equal('(&(|(uid=a)(uid=b))(displayName=*))');
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
      const r = scimFilterToLdap('active eq true', m, USERS);
      expect(r.ldapFilter).to.equal('(!(pwdAccountLockedTime=000001010000Z))');
    });
    it('active eq false', () => {
      const r = scimFilterToLdap('active eq false', m, USERS);
      expect(r.ldapFilter).to.equal('(pwdAccountLockedTime=000001010000Z)');
    });
    it('active ne true', () => {
      const r = scimFilterToLdap('active ne true', m, USERS);
      expect(r.ldapFilter).to.equal('(pwdAccountLockedTime=000001010000Z)');
    });
    it('active pr matches every entry instead of emitting (active=*)', () => {
      // `active` is not an LDAP attribute; the directory would answer
      // undefinedAttributeType.
      const r = scimFilterToLdap('active pr', m, USERS);
      expect(r.ldapFilter).to.equal('(objectClass=*)');
      expect(r.ldapFilter).to.not.match(/active/);
    });
    it('honours a configured lock attribute and value', () => {
      const r = scimFilterToLdap('active eq false', m, {
        ...USERS,
        lockAttribute: 'nsAccountLock',
        lockValue: 'TRUE',
      });
      expect(r.ldapFilter).to.equal('(nsAccountLock=TRUE)');
    });
    it('refuses a configured lock attribute without its value', () => {
      expect(() =>
        scimFilterToLdap('active eq false', m, {
          ...USERS,
          lockAttribute: 'nsAccountLock',
        })
      ).to.throw(/No lock value given for 'nsAccountLock'/);
    });
    it('combines with another clause', () => {
      const r = scimFilterToLdap(
        'userName eq "bob" and active eq false',
        m,
        USERS
      );
      expect(r.ldapFilter).to.equal(
        '(&(uid=bob)(pwdAccountLockedTime=000001010000Z))'
      );
    });
    it('rejects an unsupported operator on active', () => {
      expect(() => scimFilterToLdap('active co "x"', m, USERS)).to.throw(
        /not supported for 'active'/
      );
    });
    it('is an unknown attribute for a resource type without it', () => {
      // Groups carry no `active`. Without the flag it must be rejected, not
      // translated into a pseudo-attribute that means nothing to them.
      expect(() => scimFilterToLdap('active eq true', m)).to.throw(
        /Unknown attribute path/
      );
      expect(() => scimFilterToLdap('active pr', m)).to.throw(
        /Unknown attribute path/
      );
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
    it('refuses a filter nested deeper than it parses', () => {
      for (const deep of [
        '('.repeat(10000) + 'userName eq "a"' + ')'.repeat(10000),
        'not ('.repeat(10000) + 'userName eq "a"' + ')'.repeat(10000),
      ]) {
        try {
          scimFilterToLdap(deep, m);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).to.be.instanceOf(ScimError);
          expect((err as ScimError).scimType).to.equal('invalidFilter');
        }
      }
      const fine = '('.repeat(20) + 'userName eq "a"' + ')'.repeat(20);
      expect(scimFilterToLdap(fine, m).ldapFilter).to.equal('(uid=a)');
    });

    it('null values', () => {
      const r = scimFilterToLdap('displayName eq null', m);
      expect(r.ldapFilter).to.equal('(!(displayName=*))');
    });
  });

  describe('tokenizer', () => {
    const outcome = (fn: (s: string) => Token[], input: string) => {
      try {
        return { tokens: fn(input) };
      } catch (e) {
        return { error: (e as ScimError).message };
      }
    };
    const values = (input: string) =>
      tokenize(input)
        .filter(t => t.kind === 'STRING')
        .map(t => t.value);

    it('keeps a lone trailing backslash as a literal character', () => {
      // Unterminated: the backslash is consumed, then the string ends.
      expect(() => tokenize('a eq "abc\\')).to.throw(
        'Unterminated string literal at position 5'
      );
      expect(values('"a\\\\"')).to.deep.equal(['a\\']);
    });
    it('reports an unterminated string at its opening quote', () => {
      expect(() => tokenize('userName eq "abc')).to.throw(
        'Unterminated string literal at position 12'
      );
      expect(() => tokenize('a eq "x\\"')).to.throw(
        'Unterminated string literal at position 5'
      );
      expect(() => tokenize('"')).to.throw(
        'Unterminated string literal at position 0'
      );
    });
    it('keeps the backslash of an unknown escape', () => {
      expect(values('"a\\xb"')).to.deep.equal(['a\\xb']);
      expect(values('"\\x"')).to.deep.equal(['\\x']);
    });
    it('decodes the four escapes', () => {
      expect(values('"q\\"q\\\\q\\nq\\tq"')).to.deep.equal(['q"q\\q\nq\tq']);
    });
    it('rejects an unexpected character with its position', () => {
      expect(() => tokenize('a eq #')).to.throw(
        "Unexpected character '#' at position 5"
      );
    });
    it('agrees with the reference tokenizer on generated inputs', () => {
      const alphabet = [
        ...'aZ_$:.09+-eE \t\n\r()[]"\\nt#é',
        'eq',
        'and',
        '\\"',
        '\\\\',
        '\ud83d',
      ];
      let seed = 987654321;
      const rnd = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
      };
      for (let n = 0; n < 20000; n++) {
        let input = '';
        for (let k = rnd(24); k > 0; k--)
          input += alphabet[rnd(alphabet.length)];
        expect(outcome(tokenize, input), JSON.stringify(input)).to.deep.equal(
          outcome(referenceTokenize, input)
        );
      }
    });
  });
});
