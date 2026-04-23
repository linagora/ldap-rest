import { expect } from 'chai';
import crypto from 'crypto';

import {
  verifyLdapPassword,
  ssha,
} from '../../../src/plugins/auth/authzDynamicHash';

function ldapify(prefix: string, digest: Buffer): string {
  return `{${prefix}}${digest.toString('base64')}`;
}

describe('verifyLdapPassword', () => {
  describe('{SSHA}', () => {
    it('accepts the correct password', () => {
      const stored = ssha('s3cret');
      expect(verifyLdapPassword('s3cret', stored)).to.be.true;
    });
    it('rejects the wrong password', () => {
      const stored = ssha('s3cret');
      expect(verifyLdapPassword('s3crat', stored)).to.be.false;
    });
    it('rejects malformed base64', () => {
      expect(verifyLdapPassword('x', '{SSHA}***not-base64***')).to.be.false;
    });
    it('rejects truncated payload', () => {
      // Less than digestLength → cannot extract salt
      expect(verifyLdapPassword('x', '{SSHA}dGVzdA==')).to.be.false;
    });
  });

  describe('{SHA}', () => {
    it('accepts the correct password', () => {
      const digest = crypto.createHash('sha1').update('s3cret').digest();
      expect(verifyLdapPassword('s3cret', ldapify('SHA', digest))).to.be.true;
    });
    it('rejects the wrong password', () => {
      const digest = crypto.createHash('sha1').update('s3cret').digest();
      expect(verifyLdapPassword('nope', ldapify('SHA', digest))).to.be.false;
    });
  });

  describe('{SSHA256}', () => {
    it('accepts the correct password', () => {
      const salt = Buffer.from('saltysalt', 'utf8');
      const hash = crypto
        .createHash('sha256')
        .update('s3cret')
        .update(salt)
        .digest();
      const stored = `{SSHA256}${Buffer.concat([hash, salt]).toString('base64')}`;
      expect(verifyLdapPassword('s3cret', stored)).to.be.true;
    });
    it('rejects the wrong password', () => {
      const salt = Buffer.from('saltysalt', 'utf8');
      const hash = crypto
        .createHash('sha256')
        .update('s3cret')
        .update(salt)
        .digest();
      const stored = `{SSHA256}${Buffer.concat([hash, salt]).toString('base64')}`;
      expect(verifyLdapPassword('s3crit', stored)).to.be.false;
    });
  });

  describe('{SSHA512}', () => {
    it('accepts the correct password', () => {
      const salt = crypto.randomBytes(16);
      const hash = crypto
        .createHash('sha512')
        .update('s3cret')
        .update(salt)
        .digest();
      const stored = `{SSHA512}${Buffer.concat([hash, salt]).toString('base64')}`;
      expect(verifyLdapPassword('s3cret', stored)).to.be.true;
    });
  });

  describe('{SHA256}', () => {
    it('accepts the correct password', () => {
      const digest = crypto.createHash('sha256').update('s3cret').digest();
      expect(verifyLdapPassword('s3cret', ldapify('SHA256', digest))).to.be.true;
    });
  });

  describe('cleartext', () => {
    it('plain string with no prefix matches', () => {
      expect(verifyLdapPassword('plaintoken', 'plaintoken')).to.be.true;
    });
    it('plain string with no prefix mismatch', () => {
      expect(verifyLdapPassword('bad', 'plaintoken')).to.be.false;
    });
    it('{CLEARTEXT} prefix matches', () => {
      expect(verifyLdapPassword('tok', '{CLEARTEXT}tok')).to.be.true;
    });
    it('{PLAIN} prefix matches', () => {
      expect(verifyLdapPassword('tok', '{PLAIN}tok')).to.be.true;
    });
  });

  describe('safety', () => {
    it('rejects unknown scheme rather than silently matching', () => {
      expect(verifyLdapPassword('anything', '{UNKNOWN}data')).to.be.false;
    });
    it('rejects empty provided', () => {
      expect(verifyLdapPassword('', '{SSHA}whatever')).to.be.false;
    });
    it('rejects empty stored', () => {
      expect(verifyLdapPassword('tok', '')).to.be.false;
    });
  });

  describe('scheme prefix is case-insensitive', () => {
    it('accepts lowercase scheme prefix', () => {
      const digest = crypto.createHash('sha1').update('p').digest();
      expect(verifyLdapPassword('p', `{sha}${digest.toString('base64')}`)).to.be
        .true;
    });
  });
});

describe('ssha helper', () => {
  it('produces an {SSHA} hash round-trippable with verifyLdapPassword', () => {
    const hash = ssha('round-trip');
    expect(hash).to.match(/^\{SSHA\}/);
    expect(verifyLdapPassword('round-trip', hash)).to.be.true;
    expect(verifyLdapPassword('round-tripp', hash)).to.be.false;
  });
});
