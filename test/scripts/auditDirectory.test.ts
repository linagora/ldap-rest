import { expect } from 'chai';

import {
  auditEntry,
  parseOptions,
  printReport,
  resolvePlaceholders,
  type Finding,
} from '../../scripts/audit-directory';
import type { Schema } from '../../src/config/schema';

/** Capture what the report writes, so its wording can be asserted. */
function capture(run: () => boolean): { clean: boolean; output: string } {
  const original = process.stdout.write.bind(process.stdout);
  let output = '';
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
    chunk: string
  ) => {
    output += chunk;
    return true;
  };
  try {
    return { clean: run(), output };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

const schema: Schema = {
  strict: true,
  attributes: {
    objectClass: { type: 'array', fixed: true },
    uid: { type: 'string', required: true, generated: true },
    cn: { type: 'string', required: true },
    mail: {
      type: 'string',
      test: '^[^@\\s]{1,64}@example\\.org$',
      hint: 'Expected an address in the example.org domain',
    },
    telephoneNumber: {
      type: 'array',
      items: {
        type: 'string',
        test: '^\\d{3} \\d{4}$',
        hint: 'Expected 999 9999',
      },
    },
    manager: {
      type: 'pointer',
      branch: ['ou=users,dc=example,dc=com'],
    },
  },
};

describe('audit-directory', () => {
  describe('parseOptions', () => {
    const withEnv = <T>(
      env: Record<string, string | undefined>,
      run: () => T
    ): T => {
      const previous: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        return run();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    it('should accept both --flag value and --flag=value', () => {
      const options = withEnv({ DM_LDAP_URL: 'ldap://host' }, () =>
        parseOptions(['--schema', 'a.json', '--base=ou=users,dc=x'])
      );
      expect(options.schema).to.equal('a.json');
      expect(options.base).to.equal('ou=users,dc=x');
    });

    it('should fall back to the server’s own environment', () => {
      const options = withEnv(
        {
          DM_LDAP_URL: 'ldap://host:389',
          DM_LDAP_DN: 'cn=admin',
          DM_LDAP_PWD: 'secret',
        },
        () => parseOptions(['--schema', 'a.json'])
      );
      expect(options.url).to.equal('ldap://host:389');
      expect(options.bindDn).to.equal('cn=admin');
      expect(options.bindPassword).to.equal('secret');
    });

    it('should take the first of several configured URLs', () => {
      const options = withEnv(
        { DM_LDAP_URL: 'ldap://a:389,ldap://b:389' },
        () => parseOptions(['--schema', 'a.json'])
      );
      expect(options.url).to.equal('ldap://a:389');
    });

    it('should refuse to run without a schema or a directory', () => {
      expect(() =>
        withEnv({ DM_LDAP_URL: 'ldap://host' }, () => parseOptions([]))
      ).to.throw(/--schema/);
      expect(() =>
        withEnv({ DM_LDAP_URL: undefined, DM_LDAP_URI: undefined }, () =>
          parseOptions(['--schema', 'a.json'])
        )
      ).to.throw(/--url/);
    });
  });

  describe('resolvePlaceholders', () => {
    it('should substitute the directory suffix and leave the rest alone', () => {
      expect(
        resolvePlaceholders(
          '"branch": ["ou=users,__LDAP_BASE__"], "x": "__OTHER__"',
          'dc=example,dc=com'
        )
      ).to.equal('"branch": ["ou=users,dc=example,dc=com"], "x": "__OTHER__"');
    });
  });

  describe('auditEntry', () => {
    const run = (entries: [string, Record<string, unknown>][]): Finding[] => {
      const report = new Map<string, Finding>();
      for (const [dn, entry] of entries) auditEntry(dn, entry, schema, report);
      return [...report.values()];
    };

    it('should report a value the pattern refuses', () => {
      const findings = run([
        ['uid=a,ou=users,dc=example,dc=com', { cn: 'A', mail: 'a@evil.org' }],
      ]);
      expect(findings).to.have.length(1);
      expect(findings[0].attribute).to.equal('mail');
      expect(findings[0].reason).to.equal('does not match');
    });

    it('should say nothing about an entry the schema accepts', () => {
      expect(
        run([
          [
            'uid=a,ou=users,dc=example,dc=com',
            {
              cn: 'A',
              mail: 'a@example.org',
              telephoneNumber: ['123 4567'],
              manager: 'uid=b,ou=users,dc=example,dc=com',
            },
          ],
        ])
      ).to.deep.equal([]);
    });

    it('should count the same problem across entries once', () => {
      const findings = run([
        ['uid=a,ou=users,dc=example,dc=com', { cn: 'A', mail: 'a@evil.org' }],
        ['uid=b,ou=users,dc=example,dc=com', { cn: 'B', mail: 'b@evil.org' }],
      ]);
      expect(findings).to.have.length(1);
      expect(findings[0].count).to.equal(2);
    });

    it('should check every value of a multi-valued attribute', () => {
      const findings = run([
        [
          'uid=a,ou=users,dc=example,dc=com',
          { cn: 'A', telephoneNumber: ['123 4567', 'nope'] },
        ],
      ]);
      expect(findings).to.have.length(1);
      expect(findings[0].attribute).to.equal('telephoneNumber');
    });

    it('should report a required attribute that is absent', () => {
      const findings = run([['uid=a,ou=users,dc=example,dc=com', {}]]);
      expect(findings.map(f => f.attribute)).to.deep.equal(['cn']);
    });

    it('should not ask for an attribute the server computes', () => {
      // `uid` is required *and* generated: the server fills it, so an entry
      // without it is not a migration problem.
      const findings = run([['uid=a,ou=users,dc=example,dc=com', { cn: 'A' }]]);
      expect(findings.map(f => f.attribute)).to.not.include('uid');
    });

    it('should report a pointer outside its branch', () => {
      const findings = run([
        [
          'uid=a,ou=users,dc=example,dc=com',
          { cn: 'A', manager: 'uid=b,ou=other,dc=example,dc=com' },
        ],
      ]);
      expect(findings[0].reason).to.equal('outside the allowed branch');
    });
  });

  describe('printReport', () => {
    it('should say so plainly when the directory is clean', () => {
      const { clean, output } = capture(() => printReport([], 42, 5));
      expect(clean).to.be.true;
      expect(output).to.include('42 entries read');
      expect(output).to.include('satisfies the schema');
    });

    it('should quote the hint, so the reader knows what to aim for', () => {
      const { clean, output } = capture(() =>
        printReport(
          [
            {
              attribute: 'mail',
              reason: 'does not match',
              hint: 'Expected an address in the example.org domain',
              count: 3,
              samples: [
                { dn: 'uid=a,ou=users', value: 'a@evil.org' },
                { dn: 'uid=b,ou=users', value: 'b@evil.org' },
              ],
            },
          ],
          10,
          1
        )
      );
      expect(clean).to.be.false;
      expect(output).to.include('mail: does not match — 3');
      expect(output).to.include(
        'expected: Expected an address in the example.org domain'
      );
      expect(output).to.include('uid=a,ou=users');
      expect(output).to.include('and 2 more');
    });
  });
});
