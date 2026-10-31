import { expect } from 'chai';
import type { SearchOptions, SearchResult } from 'ldapts';

import type { AttributesList } from '../../../src/lib/ldapActions';
import DirectorySchema, {
  type DirectorySearch,
  type SchemaLogger,
} from '../../../src/lib/ldap/schema';

const SCHEMA_ENTRY = {
  objectClasses: [
    "( 1.2.3 NAME 'testPerson' SUP top STRUCTURAL MUST cn MAY mail )",
    "( 1.2.4 NAME 'testAux' SUP top AUXILIARY MAY description )",
  ],
  attributeTypes: [
    "( 2.5.4.3 NAME ( 'cn' 'commonName' ) EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
    "( 0.9.2342.19200300.100.1.3 NAME ( 'mail' 'rfc822Mailbox' ) EQUALITY caseIgnoreIA5Match SYNTAX 1.3.6.1.4.1.1466.115.121.1.26 )",
    "( 1.2.5 NAME 'description' EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
    "( 2.5.4.36 NAME 'userCertificate' SYNTAX 1.3.6.1.4.1.1466.115.121.1.5 )",
  ],
  ldapSyntaxes: [],
  matchingRules: [],
};

const answer = (entries: Array<Record<string, unknown>>): SearchResult =>
  ({
    searchEntries: entries,
    searchReferences: [],
  }) as unknown as SearchResult;

interface FakeLogger extends SchemaLogger {
  infos: string[];
  warns: string[];
}

const logger = (): FakeLogger => {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (message: string) => infos.push(message),
    warn: (message: string) => warns.push(message),
  };
};

interface FakeDirectory {
  searches: Array<{ base: string; options: SearchOptions }>;
  search: DirectorySearch;
}

/**
 * A directory whose root DSE advertises `subschemaDn`, whose subschema
 * holds {@link SCHEMA_ENTRY}, and whose other bases answer with `entries`.
 */
const directory = (
  entries: (base: string) => Array<Record<string, unknown>> = () =>
    [] as Array<Record<string, unknown>>,
  subschemaDn: string | null = 'cn=Subschema'
): FakeDirectory => {
  const searches: FakeDirectory['searches'] = [];
  const search: DirectorySearch = (options, base) => {
    searches.push({ base, options });
    if (base === '')
      return Promise.resolve(
        answer([subschemaDn ? { subschemaSubentry: subschemaDn } : {}])
      );
    if (base === 'cn=Subschema')
      return Promise.resolve(answer([{ ...SCHEMA_ENTRY }]));
    return Promise.resolve(answer(entries(base)));
  };
  return { searches, search };
};

const schemaFor = (
  dir: FakeDirectory,
  overrides: Partial<{
    autoRepair: boolean;
    schemaCacheTtl: number;
    logger: FakeLogger;
  }> = {}
): { schema: DirectorySchema; logger: FakeLogger } => {
  const log = overrides.logger ?? logger();
  return {
    logger: log,
    schema: new DirectorySchema({
      logger: log,
      search: dir.search,
      autoRepair: () => overrides.autoRepair ?? true,
      schemaCacheTtl: () => overrides.schemaCacheTtl ?? 3_600_000,
    }),
  };
};

describe('DirectorySchema', () => {
  describe('where the schema lives', () => {
    it('reads the DN the root DSE advertises', async () => {
      const dir = directory();
      const { schema } = schemaFor(dir);
      expect(await schema.subschemaDn()).to.equal('cn=Subschema');
      expect(dir.searches[0].base).to.equal('');
    });

    it('falls back to cn=Subschema when the root DSE names none', async () => {
      const { schema } = schemaFor(directory(() => [], null));
      expect(await schema.subschemaDn()).to.equal('cn=Subschema');
    });

    it('falls back to cn=Subschema when the root DSE cannot be read', async () => {
      const log = logger();
      const schema = new DirectorySchema({
        logger: log,
        search: () => Promise.reject(new Error('root DSE unreadable')),
        autoRepair: () => true,
        schemaCacheTtl: () => 3_600_000,
      });
      expect(await schema.subschemaDn()).to.equal('cn=Subschema');
      expect(log.warns.join('\n')).to.include(
        'Unable to read subschemaSubentry'
      );
    });
  });

  describe('the schema index', () => {
    it('indexes the subschema entry and says so', async () => {
      const { schema, logger: log } = schemaFor(directory());
      const index = await schema.schemaIndex();
      expect(index.getAttributeType('mail')?.oid).to.equal(
        '0.9.2342.19200300.100.1.3'
      );
      expect(index.getObjectClass('testPerson')?.kind).to.equal('STRUCTURAL');
      expect(log.infos.join('\n')).to.include('2 object classes');
    });

    it('keeps the index for its TTL', async () => {
      const dir = directory();
      const { schema } = schemaFor(dir);
      const first = await schema.schemaIndex();
      const second = await schema.schemaIndex();
      expect(second).to.equal(first);
      expect(
        dir.searches.filter(s => s.base === 'cn=Subschema')
      ).to.have.length(1);
    });

    it('reads the schema once for concurrent callers', async () => {
      const dir = directory();
      const { schema } = schemaFor(dir);
      const [first, second] = await Promise.all([
        schema.schemaIndex(),
        schema.schemaIndex(),
      ]);
      expect(second).to.equal(first);
      expect(
        dir.searches.filter(s => s.base === 'cn=Subschema')
      ).to.have.length(1);
    });

    it('reads the schema again once its TTL has passed', async () => {
      const dir = directory();
      const { schema } = schemaFor(dir, { schemaCacheTtl: 0 });
      await schema.schemaIndex();
      await schema.schemaIndex();
      expect(
        dir.searches.filter(s => s.base === 'cn=Subschema')
      ).to.have.length(2);
    });

    it('refuses an advertised subschema entry the directory lacks', async () => {
      const schema = new DirectorySchema({
        logger: logger(),
        search: (options, base) =>
          base === ''
            ? Promise.resolve(answer([{ subschemaSubentry: 'cn=Missing' }]))
            : Promise.resolve(answer([])),
        autoRepair: () => true,
        schemaCacheTtl: () => 3_600_000,
      });
      let raised: unknown;
      try {
        await schema.schemaIndex();
      } catch (err) {
        raised = err;
      }
      expect((raised as { statusCode?: number }).statusCode).to.equal(404);
    });

    it('turns the driver code 32 into a 404 naming the entry', async () => {
      const schema = new DirectorySchema({
        logger: logger(),
        search: () =>
          Promise.reject(
            Object.assign(new Error('no such object'), { code: 32 })
          ),
        autoRepair: () => true,
        schemaCacheTtl: () => 3_600_000,
      });
      let raised: unknown;
      try {
        await schema.schemaIndex();
      } catch (err) {
        raised = err;
      }
      expect((raised as { statusCode?: number }).statusCode).to.equal(404);
      expect((raised as Error).message).to.include('cn=Subschema');
    });
  });

  describe('attribute names', () => {
    it('resolves through the schema, whatever the case, alias or OID', async () => {
      const { schema } = schemaFor(directory());
      const entry: AttributesList = {
        MAIL: 'alice@example.com',
        '0.9.2342.19200300.100.1.3': 'alice@example.com',
        commonName: 'Alice',
      };
      let raised: unknown;
      try {
        await schema.canonicalAttributes(entry);
      } catch (err) {
        raised = err;
      }
      expect((raised as { statusCode?: number }).statusCode).to.equal(400);
      expect(Object.keys(entry)).to.deep.equal([
        'MAIL',
        '0.9.2342.19200300.100.1.3',
        'commonName',
      ]);
    });

    it('names each attribute as the configuration or schema spells it', async () => {
      const { schema } = schemaFor(directory());
      schema.knowAttributeNames(['RANK']);
      const entry: AttributesList = { MAIL: 'alice@example.com', rank: 'x' };
      await schema.canonicalAttributes(entry);
      expect(Object.keys(entry)).to.deep.equal(['mail', 'RANK']);
    });

    it('resolves the standard types without the schema', async () => {
      const schema = new DirectorySchema({
        logger: logger(),
        search: () => Promise.reject(new Error('cn=Subschema unreadable')),
        autoRepair: () => true,
        schemaCacheTtl: () => 3_600_000,
      });
      const entry: AttributesList = { STATEORPROVINCENAME: 'Ile-de-France' };
      await schema.canonicalAttributes(entry);
      expect(Object.keys(entry)).to.deep.equal(['st']);
      let raised: unknown;
      try {
        await schema.canonicalAttributes({
          '1.3.6.1.4.1.10943.1.50.1.1': 'x',
        });
      } catch (err) {
        raised = err;
      }
      expect((raised as { statusCode?: number }).statusCode).to.equal(400);
    });

    it('refuses one attribute named twice in one part of a write', async () => {
      const { schema } = schemaFor(directory());
      let raised: unknown;
      try {
        await schema.canonicalChanges({ delete: ['mail', 'Mail'] });
      } catch (err) {
        raised = err;
      }
      expect((raised as { statusCode?: number }).statusCode).to.equal(400);
    });

    it('keeps ;binary and refuses any other option', async () => {
      const { schema } = schemaFor(directory());
      const entry: AttributesList = { 'USERCERTIFICATE;BINARY': 'x' };
      await schema.canonicalAttributes(entry);
      expect(Object.keys(entry)).to.deep.equal(['userCertificate;binary']);
      for (const given of [
        'member;lang-en',
        'mail;x-tag',
        'cn;binary;lang-fr',
      ]) {
        let raised: unknown;
        try {
          await schema.canonicalAttributes({ [given]: 'x' });
        } catch (err) {
          raised = err;
        }
        expect((raised as { statusCode?: number }).statusCode, given).to.equal(
          400
        );
      }
    });
  });

  describe('object class repair', () => {
    it('repairs nothing when auto-repair is off', async () => {
      const dir = directory();
      const { schema } = schemaFor(dir, { autoRepair: false });
      schema.declareObjectClasses('ou=users,dc=example,dc=com', [
        'top',
        'testAux',
      ]);
      expect(
        await schema.classRepair(
          'uid=alice,ou=users,dc=example,dc=com',
          { replace: { description: 'x' } },
          []
        )
      ).to.deep.equal([]);
      expect(dir.searches).to.be.empty;
    });

    it('repairs nothing without a declaration', async () => {
      const { schema } = schemaFor(directory());
      expect(
        await schema.classRepair(
          'uid=alice,ou=users,dc=example,dc=com',
          { replace: { description: 'x' } },
          []
        )
      ).to.deep.equal([]);
    });

    it('adds the declared auxiliary class a change needs', async () => {
      const dir = directory(base =>
        base === 'uid=alice,ou=users,dc=example,dc=com'
          ? [{ dn: base, objectClass: ['top', 'testPerson'], cn: ['Alice'] }]
          : []
      );
      const { schema } = schemaFor(dir);
      schema.declareObjectClasses('ou=users,dc=example,dc=com', [
        'top',
        'testAux',
      ]);
      expect(
        await schema.classRepair(
          'uid=alice,ou=users,dc=example,dc=com',
          { replace: { description: 'x' } },
          []
        )
      ).to.deep.equal(['testAux']);
    });
  });
});
