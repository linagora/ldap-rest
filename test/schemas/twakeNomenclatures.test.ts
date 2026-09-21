import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

import type { Schema } from '../../src/config/schema';

/**
 * A nomenclature schema file, typed with the entity fields this test reads
 * besides the ones `Schema` itself declares (`mainAttribute`, `base`) —
 * `ldapFlatGeneric` requires those too, so every file here carries them.
 */
interface NomenclatureSchema extends Schema {
  entity: NonNullable<Schema['entity']> & {
    mainAttribute: string;
    base: string;
  };
}

const nomenclatureDir = path.join(
  __dirname,
  '../../static/schemas/twake/nomenclature'
);

const fixturePath = path.join(__dirname, '../fixtures/base-structure.ldif');

const readSchema = (file: string): NomenclatureSchema =>
  JSON.parse(
    fs.readFileSync(path.join(nomenclatureDir, file), 'utf-8')
  ) as NomenclatureSchema;

const schemaFiles = fs
  .readdirSync(nomenclatureDir)
  .filter(file => file.endsWith('.json'))
  .sort();

/**
 * `cn` (or `dc`) values the test fixture seeds under each nomenclature's own
 * branch, keyed by the branch's own `ou`. `base-structure.ldif` is the one
 * source both this test and the LDAP container the other schema tests start
 * read, so a schema's `valueLabels` is checked against what the fixture
 * really holds rather than against a second, hand-kept list that could drift
 * from it.
 */
function fixtureValuesByBranch(): Record<string, Set<string>> {
  const ldif = fs.readFileSync(fixturePath, 'utf-8');
  const values: Record<string, Set<string>> = {};
  const dnPattern = /^dn: (?:cn|dc)=([^,]+),ou=([^,]+),ou=nomenclature,/gm;
  let match: RegExpExecArray | null;
  while ((match = dnPattern.exec(ldif))) {
    const [, value, branch] = match;
    (values[branch] ??= new Set<string>()).add(value);
  }
  return values;
}

describe('Twake nomenclature schemas', () => {
  const fixtureValues = fixtureValuesByBranch();

  // `twakeDomain` lives in the same directory but names deployment-chosen
  // domains, not a fixed set of states the product could translate — it
  // legitimately carries `label`/`singularLabel` and no `valueLabels`,
  // unlike every other nomenclature shipped here.
  const enumerating = schemaFiles.filter(file => file !== 'twakeDomain.json');

  for (const file of schemaFiles) {
    describe(file, () => {
      const schema = readSchema(file);
      const entity = schema.entity;

      it('names the collection and one of its entries', () => {
        expect(entity.label, 'entity.label').to.exist;
        expect(entity.singularLabel, 'entity.singularLabel').to.exist;
      });

      if (!entity.valueLabels) return;

      it('names only values the fixture holds, or the schema itself allows', () => {
        // A value the fixture has with no label is allowed — a directory
        // grows values the product has not named yet. The reverse is a
        // typo: a label for a key neither seeded in the fixture nor even
        // matching the attribute's own validation pattern could never be a
        // real entry.
        const mainAttribute = schema.attributes[entity.mainAttribute];
        const pattern = mainAttribute?.test
          ? new RegExp(mainAttribute.test as string)
          : undefined;

        const branchMatch = /^ou=([^,]+),ou=nomenclature,/.exec(entity.base);
        const held =
          (branchMatch && fixtureValues[branchMatch[1]]) || new Set<string>();

        const typos = Object.keys(entity.valueLabels ?? {}).filter(
          key => !held.has(key) && !(pattern && pattern.test(key))
        );
        expect(typos).to.deep.equal([]);
      });
    });
  }

  it('carries valueLabels for every nomenclature enumerating fixed states', () => {
    const missing = enumerating.filter(
      file => !readSchema(file).entity.valueLabels
    );
    expect(missing).to.deep.equal([]);
  });
});
