import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';

import {
  converterFor,
  fromLdap,
  toLdap,
} from '../../../src/plugins/scim/converters';
import {
  DEFAULT_USER_MAPPING,
  ldapToScimUser,
  loadMappingFile,
  mergeMapping,
  scimUserToLdap,
  type MappingContext,
} from '../../../src/plugins/scim/mapping';
import { patchToModifyRequest } from '../../../src/plugins/scim/patch';
import { scimFilterToLdap } from '../../../src/plugins/scim/filter';
import { ScimError } from '../../../src/plugins/scim/errors';
import type { ResourceMapping } from '../../../src/plugins/scim/types';

const mapping: ResourceMapping = mergeMapping(DEFAULT_USER_MAPPING, {
  ...DEFAULT_USER_MAPPING,
  entries: [
    { scim: 'verified', ldap: 'x-verified', converter: 'boolean' },
    { scim: 'level', ldap: 'x-level', converter: 'number' },
    { scim: 'validUntil', ldap: 'x-validUntil', converter: 'date' },
    { scim: 'tags', ldap: 'x-tag', multi: 'array', converter: 'number' },
  ],
});

const ctx: MappingContext = {
  idAttribute: 'rdn',
  rdnAttribute: 'uid',
  resourceType: 'User',
  scimPrefix: '/scim/v2',
  lockAttribute: 'pwdAccountLockedTime',
  lockValue: '000001010000Z',
};

const refusal = (fn: () => unknown, scimType: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).to.be.instanceOf(ScimError);
    expect((err as ScimError).scimType).to.equal(scimType);
    return;
  }
  expect.fail('no error');
};

describe('SCIM converters', () => {
  describe('values', () => {
    it('writes booleans in the LDAP Boolean syntax', () => {
      expect(toLdap(true, 'boolean', 'a')).to.equal('TRUE');
      expect(toLdap('False', 'boolean', 'a')).to.equal('FALSE');
      refusal(() => toLdap('yes', 'boolean', 'a'), 'invalidValue');
    });

    it('writes numbers and refuses what is not one', () => {
      expect(toLdap(42, 'number', 'a')).to.equal('42');
      expect(toLdap('7', 'number', 'a')).to.equal('7');
      refusal(() => toLdap('', 'number', 'a'), 'invalidValue');
      refusal(() => toLdap('seven', 'number', 'a'), 'invalidValue');
      refusal(() => toLdap(1.5, 'number', 'a'), 'invalidValue');
      refusal(() => toLdap('1e21', 'number', 'a'), 'invalidValue');
      refusal(() => toLdap(2 ** 53, 'number', 'a'), 'invalidValue');
    });

    it('refuses a number written with a radix prefix', () => {
      refusal(() => toLdap('0x10', 'number', 'a'), 'invalidValue');
      refusal(() => toLdap('0b101', 'number', 'a'), 'invalidValue');
      refusal(() => toLdap('0o17', 'number', 'a'), 'invalidValue');
      expect(toLdap('-12', 'number', 'a')).to.equal('-12');
    });

    it('writes dates as a UTC GeneralizedTime', () => {
      expect(toLdap('2024-01-31T12:30:00Z', 'date', 'a')).to.equal(
        '20240131123000Z'
      );
      expect(toLdap('2024-01-31T12:30:00+02:00', 'date', 'a')).to.equal(
        '20240131103000Z'
      );
      expect(toLdap('2024-01-31T12:00:00.750Z', 'date', 'a')).to.equal(
        '20240131120000.75Z'
      );
      refusal(() => toLdap('2024-01-31', 'date', 'a'), 'invalidValue');
      refusal(() => toLdap('2024-01-31T12:00Z', 'date', 'a'), 'invalidValue');
      refusal(() => toLdap('31/01/2024', 'date', 'a'), 'invalidValue');
    });

    it('refuses a date that does not exist rather than rolling it over', () => {
      refusal(
        () => toLdap('2024-02-30T12:00:00Z', 'date', 'a'),
        'invalidValue'
      );
      refusal(
        () => toLdap('2023-02-29T12:00:00Z', 'date', 'a'),
        'invalidValue'
      );
      refusal(
        () => toLdap('2024-01-31T24:00:00Z', 'date', 'a'),
        'invalidValue'
      );
      refusal(
        () => toLdap('2024-01-31T12:60:00Z', 'date', 'a'),
        'invalidValue'
      );
      refusal(
        () => toLdap('2024-13-01T12:00:00Z', 'date', 'a'),
        'invalidValue'
      );
      refusal(
        () => toLdap('2024-01-31T12:00:00+24:00', 'date', 'a'),
        'invalidValue'
      );
      expect(toLdap('2024-02-29T23:59:59Z', 'date', 'a')).to.equal(
        '20240229235959Z'
      );
    });

    it('reads them back as JSON', () => {
      expect(fromLdap('TRUE', 'boolean')).to.equal(true);
      expect(fromLdap('FALSE', 'boolean')).to.equal(false);
      expect(fromLdap('42', 'number')).to.equal(42);
      expect(fromLdap('20240131123000Z', 'date')).to.equal(
        '2024-01-31T12:30:00Z'
      );
      expect(fromLdap('20240131120000.75Z', 'date')).to.equal(
        '2024-01-31T12:00:00.750Z'
      );
    });

    it('answers a value it cannot read as the directory holds it', () => {
      expect(fromLdap('maybe', 'boolean')).to.equal('maybe');
      expect(fromLdap('n/a', 'number')).to.equal('n/a');
      expect(fromLdap('soon', 'date')).to.equal('soon');
    });

    it('answers an integer a JSON number would round as its text', () => {
      expect(fromLdap('9007199254740993', 'number')).to.equal(
        '9007199254740993'
      );
      expect(fromLdap('-9007199254740991', 'number')).to.equal(
        -9007199254740991
      );
      expect(fromLdap('0x10', 'number')).to.equal('0x10');
      expect(fromLdap('1.5', 'number')).to.equal('1.5');
    });

    it('leaves strings and untyped entries alone', () => {
      expect(toLdap(true, undefined, 'a')).to.equal('true');
      expect(fromLdap('TRUE', 'string')).to.equal('TRUE');
      expect(converterFor('displayName', mapping)).to.be.undefined;
      expect(converterFor('name.familyName', mapping)).to.be.undefined;
      expect(converterFor('verified', mapping)).to.equal('boolean');
    });
  });

  describe('mapping', () => {
    it('converts a body on write', () => {
      const { attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          verified: true,
          level: 3,
          validUntil: '2030-12-31T23:59:59Z',
          tags: [1, '2'],
        } as never,
        mapping,
        ctx,
        ['inetOrgPerson']
      );
      expect(attributes['x-verified']).to.equal('TRUE');
      expect(attributes['x-level']).to.equal('3');
      expect(attributes['x-validUntil']).to.equal('20301231235959Z');
      expect(attributes['x-tag']).to.deep.equal(['1', '2']);
    });

    it('converts an entry on read', () => {
      const user = ldapToScimUser(
        {
          uid: 'alice',
          'x-verified': 'FALSE',
          'x-level': '3',
          'x-validUntil': '20301231235959Z',
          'x-tag': ['1', '2'],
        },
        mapping,
        ctx
      ) as Record<string, unknown>;
      expect(user.verified).to.equal(false);
      expect(user.level).to.equal(3);
      expect(user.validUntil).to.equal('2030-12-31T23:59:59Z');
      expect(user.tags).to.deep.equal([1, 2]);
    });

    it('converts PATCH values', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'verified', value: true },
            { op: 'replace', value: { level: 5 } },
          ],
        },
        { mapping, current: {} }
      );
      const all = { ...req.add, ...req.replace };
      expect([all['x-verified']].flat()).to.deep.equal(['TRUE']);
      expect([all['x-level']].flat()).to.deep.equal(['5']);
    });

    it('refuses a PATCH value of the wrong type', async () => {
      let caught: unknown;
      try {
        await patchToModifyRequest(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'verified', value: 'maybe' }],
          },
          { mapping, current: {} }
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as ScimError).scimType).to.equal('invalidValue');
    });

    it('refuses a mapping file naming an unknown converter', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-conv-'));
      const file = path.join(dir, 'm.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          resourceType: 'User',
          schemas: [],
          entries: [{ scim: 'a', ldap: 'a', converter: 'bool' }],
        })
      );
      try {
        expect(() => loadMappingFile(file)).to.throw(/Unknown converter/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('filters', () => {
    it('compares typed attributes in the directory form', () => {
      expect(scimFilterToLdap('verified eq true', mapping).ldapFilter).to.equal(
        '(x-verified=TRUE)'
      );
      expect(
        scimFilterToLdap('verified ne "false"', mapping).ldapFilter
      ).to.equal('(!(x-verified=FALSE))');
      expect(
        scimFilterToLdap('validUntil ge "2024-01-01T00:00:00Z"', mapping)
          .ldapFilter
      ).to.equal('(x-validUntil>=20240101000000Z)');
    });

    it('matches substrings as given', () => {
      expect(scimFilterToLdap('level sw "4"', mapping).ldapFilter).to.equal(
        '(x-level=4*)'
      );
    });

    it('answers invalidFilter for a value of the wrong type', () => {
      refusal(() => scimFilterToLdap('level eq "x"', mapping), 'invalidFilter');
    });
  });
});
