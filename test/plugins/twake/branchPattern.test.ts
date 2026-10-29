/**
 * The Twake branch pattern reads one organization out of a DN, the value the
 * entry is moved into. Its tests are written from the DNs a deployment holds:
 * an organization named with a comma is a single RDN value, and a DN that
 * does not fit the branch must not cost more than reading it.
 */
import { expect } from 'chai';

import {
  branchPattern,
  organizationIn,
} from '../../../src/plugins/twake/groups';

const B = String.fromCharCode(92);
const base = 'ou=groups,ou={org},o=gov,c=mu';

/** A group one level under the organization `org` of the branch */
const under = (org: string): string =>
  `cn=group,ou=groups,ou=${org},o=gov,c=mu`;

describe('branchPattern', () => {
  const pattern = branchPattern(base);

  it('reads the organization of a group in its branch', () => {
    expect(organizationIn(pattern, under('The Judiciary'))).to.equal(
      'The Judiciary'
    );
  });

  it('reads an organization whose DN escapes its comma', () => {
    // `ou=Sales\, EMEA` is one RDN, the organization named "Sales, EMEA"
    expect(organizationIn(pattern, under(`Sales${B}, EMEA`))).to.equal(
      'Sales, EMEA'
    );
  });

  it('reads an organization whose comma is written as a hex escape', () => {
    expect(organizationIn(pattern, under(`Sales${B}2C EMEA`))).to.equal(
      'Sales, EMEA'
    );
  });

  it('reads no organization from a group in another branch', () => {
    expect(
      organizationIn(pattern, 'cn=group,ou=groups,ou=Sales,o=other,c=mu')
    ).to.equal(undefined);
  });

  it('reads no organization from a DN missing the organization level', () => {
    expect(organizationIn(pattern, 'cn=group,ou=groups,o=gov,c=mu')).to.equal(
      undefined
    );
  });

  it('reads a DN that does not fit the branch in linear time', () => {
    // A DN in the branch with a different tail: the run of escapes ends the
    // organization, so the tail never matches. Every way of splitting the
    // run between an escape and a plain character is tried unless each
    // character is followed one way only
    const read = (n: number): number => {
      const dn = `cn=group,ou=groups,ou=${`${B}a`.repeat(n)},o=gov,c=other`;
      const start = process.hrtime.bigint();
      expect(organizationIn(pattern, dn)).to.equal(undefined);
      return Number(process.hrtime.bigint() - start);
    };
    read(200); // warm-up
    const small = read(20000);
    const large = read(40000);
    // Doubling a linear read costs about twice, three times under load; an
    // exponential one multiplies by 2^20000
    expect(large).to.be.below(small * 4 + 1);
  });
});
