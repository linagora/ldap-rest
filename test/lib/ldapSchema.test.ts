import { expect } from 'chai';

import {
  parseAttributeType,
  parseObjectClass,
  parseSyntax,
  parseMatchingRule,
  parseSchema,
  SchemaIndex,
} from '../../src/lib/ldapSchema';

describe('LDAP schema parser', () => {
  describe('parseAttributeType', () => {
    it('should parse a definition with multiple names', () => {
      const at = parseAttributeType(
        "( 2.5.4.3 NAME ( 'cn' 'commonName' ) DESC 'RFC2256: common name(s) for which the entity is known by' SUP name )"
      );
      expect(at).to.not.equal(null);
      expect(at!.oid).to.equal('2.5.4.3');
      expect(at!.names).to.deep.equal(['cn', 'commonName']);
      expect(at!.desc).to.equal(
        'RFC2256: common name(s) for which the entity is known by'
      );
      expect(at!.sup).to.equal('name');
      expect(at!.singleValue).to.equal(false);
      expect(at!.usage).to.equal('userApplications');
    });

    it('should parse flags and matching rules', () => {
      const at = parseAttributeType(
        "( 2.5.4.0 NAME 'objectClass' EQUALITY objectIdentifierMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.38 )"
      );
      expect(at!.equality).to.equal('objectIdentifierMatch');
      expect(at!.syntax).to.equal('1.3.6.1.4.1.1466.115.121.1.38');
      expect(at!.syntaxLength).to.equal(undefined);
    });

    it('should split the suggested length from the syntax OID', () => {
      const at = parseAttributeType(
        "( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )"
      );
      expect(at!.syntax).to.equal('1.3.6.1.4.1.1466.115.121.1.15');
      expect(at!.syntaxLength).to.equal(32768);
      expect(at!.substr).to.equal('caseIgnoreSubstringsMatch');
    });

    it('should detect operational attributes', () => {
      const at = parseAttributeType(
        "( 2.5.18.1 NAME 'createTimestamp' EQUALITY generalizedTimeMatch ORDERING generalizedTimeOrderingMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 SINGLE-VALUE NO-USER-MODIFICATION USAGE directoryOperation )"
      );
      expect(at!.singleValue).to.equal(true);
      expect(at!.noUserModification).to.equal(true);
      expect(at!.usage).to.equal('directoryOperation');
      expect(at!.ordering).to.equal('generalizedTimeOrderingMatch');
    });

    it('should ignore vendor extensions', () => {
      const at = parseAttributeType(
        "( 1.2.3.4 NAME 'custom' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 X-ORIGIN 'user defined' X-ORDERED ( 'VALUES' ) )"
      );
      expect(at!.names).to.deep.equal(['custom']);
      expect(at!.syntax).to.equal('1.3.6.1.4.1.1466.115.121.1.15');
    });

    it('should unescape quotes inside descriptions', () => {
      const at = parseAttributeType(
        "( 1.2.3.5 NAME 'quoted' DESC 'it\\27s here' )"
      );
      expect(at!.desc).to.equal("it's here");
    });

    it('should return null on garbage', () => {
      expect(parseAttributeType('not a definition')).to.equal(null);
      expect(parseAttributeType('')).to.equal(null);
    });
  });

  describe('parseObjectClass', () => {
    it('should parse MUST and MAY lists', () => {
      const oc = parseObjectClass(
        "( 2.5.6.6 NAME 'person' DESC 'RFC2256: a person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY ( userPassword $ telephoneNumber $ seeAlso $ description ) )"
      );
      expect(oc!.names).to.deep.equal(['person']);
      expect(oc!.kind).to.equal('STRUCTURAL');
      expect(oc!.sup).to.deep.equal(['top']);
      expect(oc!.must).to.deep.equal(['sn', 'cn']);
      expect(oc!.may).to.deep.equal([
        'userPassword',
        'telephoneNumber',
        'seeAlso',
        'description',
      ]);
    });

    it('should parse abstract and auxiliary classes', () => {
      const top = parseObjectClass(
        "( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )"
      );
      expect(top!.kind).to.equal('ABSTRACT');
      expect(top!.must).to.deep.equal(['objectClass']);

      const aux = parseObjectClass(
        "( 1.3.6.1.4.1.1466.101.120.142 NAME 'extensibleObject' SUP top AUXILIARY )"
      );
      expect(aux!.kind).to.equal('AUXILIARY');
      expect(aux!.must).to.deep.equal([]);
      expect(aux!.may).to.deep.equal([]);
    });

    it('should default to STRUCTURAL when the kind is omitted', () => {
      const oc = parseObjectClass("( 1.2.3.6 NAME 'implicit' SUP top )");
      expect(oc!.kind).to.equal('STRUCTURAL');
    });

    it('should parse multiple superiors', () => {
      const oc = parseObjectClass(
        "( 1.2.3.7 NAME 'multi' SUP ( person $ organizationalPerson ) STRUCTURAL )"
      );
      expect(oc!.sup).to.deep.equal(['person', 'organizationalPerson']);
    });
  });

  describe('parseSyntax and parseMatchingRule', () => {
    it('should parse a syntax and flag binary ones', () => {
      const text = parseSyntax(
        "( 1.3.6.1.4.1.1466.115.121.1.15 DESC 'Directory String' )"
      );
      expect(text!.desc).to.equal('Directory String');
      expect(text!.binary).to.equal(false);

      const jpeg = parseSyntax("( 1.3.6.1.4.1.1466.115.121.1.28 DESC 'JPEG' )");
      expect(jpeg!.binary).to.equal(true);
    });

    it('should parse a matching rule', () => {
      const mr = parseMatchingRule(
        "( 2.5.13.2 NAME 'caseIgnoreMatch' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )"
      );
      expect(mr!.names).to.deep.equal(['caseIgnoreMatch']);
      expect(mr!.syntax).to.equal('1.3.6.1.4.1.1466.115.121.1.15');
    });
  });

  describe('parseSchema', () => {
    it('should skip unparseable definitions instead of failing', () => {
      const schema = parseSchema({
        objectClasses: [
          "( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )",
          '???',
        ],
        attributeTypes: ["( 2.5.4.3 NAME 'cn' SUP name )"],
        ldapSyntaxes: [],
        matchingRules: undefined,
      });
      expect(schema.objectClasses).to.have.length(1);
      expect(schema.attributeTypes).to.have.length(1);
      expect(schema.syntaxes).to.have.length(0);
      expect(schema.matchingRules).to.have.length(0);
    });
  });

  describe('SchemaIndex', () => {
    const schema = parseSchema({
      objectClasses: [
        "( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )",
        "( 2.5.6.6 NAME 'person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY ( userPassword $ description ) )",
        "( 2.5.6.7 NAME 'organizationalPerson' SUP person STRUCTURAL MAY ( title $ ou ) )",
        "( 2.16.840.1.113730.3.2.2 NAME 'inetOrgPerson' SUP organizationalPerson STRUCTURAL MAY ( uid $ mail $ jpegPhoto $ cn ) )",
      ],
      attributeTypes: [
        "( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )",
        "( 2.5.4.3 NAME ( 'cn' 'commonName' ) SUP name )",
        "( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
        "( 2.5.4.35 NAME 'userPassword' EQUALITY octetStringMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.40{128} )",
        "( 0.9.2342.19200300.100.1.1 NAME ( 'uid' 'userid' ) EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{256} )",
      ],
      ldapSyntaxes: [
        "( 1.3.6.1.4.1.1466.115.121.1.15 DESC 'Directory String' )",
        "( 1.3.6.1.4.1.1466.115.121.1.28 DESC 'JPEG' )",
      ],
      matchingRules: [],
    });
    const index = new SchemaIndex(schema);

    it('should look up by name, alias and OID, case-insensitively', () => {
      expect(index.getObjectClass('PERSON')!.oid).to.equal('2.5.6.6');
      expect(index.getObjectClass('2.5.6.6')!.names).to.deep.equal(['person']);
      expect(index.getAttributeType('commonName')!.oid).to.equal('2.5.4.3');
      expect(index.getAttributeType('userid')!.names).to.contain('uid');
      expect(index.getObjectClass('unknown')).to.equal(undefined);
    });

    it('should ignore attribute options on lookup', () => {
      expect(index.getAttributeType('jpegPhoto;binary')!.oid).to.equal(
        '0.9.2342.19200300.100.1.60'
      );
    });

    it('should resolve the syntax through the SUP chain', () => {
      // cn has no SYNTAX of its own, it inherits the one of `name`
      expect(index.getAttributeSyntax('cn')).to.equal(
        '1.3.6.1.4.1.1466.115.121.1.15'
      );
      expect(index.getAttributeSyntax('jpegPhoto')).to.equal(
        '1.3.6.1.4.1.1466.115.121.1.28'
      );
      expect(index.getAttributeSyntax('unknown')).to.equal(undefined);
    });

    it('should detect binary attributes', () => {
      expect(index.isBinaryAttribute('jpegPhoto')).to.equal(true);
      expect(index.isBinaryAttribute('userPassword')).to.equal(true);
      expect(index.isBinaryAttribute('cn;lang-fr')).to.equal(false);
      expect(index.isBinaryAttribute('cn')).to.equal(false);
      // The `;binary` option makes any attribute binary
      expect(index.isBinaryAttribute('unknown;binary')).to.equal(true);
    });

    it('should collect MUST and MAY through the whole SUP chain', () => {
      const { must, may } = index.resolveAttributes(['inetOrgPerson']);
      expect(must.sort()).to.deep.equal(['cn', 'objectClass', 'sn']);
      expect(may).to.contain('uid');
      expect(may).to.contain('mail');
      expect(may).to.contain('title');
      expect(may).to.contain('description');
      // `cn` is mandatory through `person`, so it must not be listed as optional
      expect(may).to.not.contain('cn');
    });

    it('should merge several object classes and ignore unknown ones', () => {
      const { must, may } = index.resolveAttributes([
        'person',
        'extensibleObject',
      ]);
      expect(must.sort()).to.deep.equal(['cn', 'objectClass', 'sn']);
      expect(may.sort()).to.deep.equal(['description', 'userPassword']);
    });

    it('should not loop on cyclic SUP declarations', () => {
      const cyclic = new SchemaIndex(
        parseSchema({
          objectClasses: [
            "( 1.2.3.1 NAME 'a' SUP b STRUCTURAL MUST x )",
            "( 1.2.3.2 NAME 'b' SUP a STRUCTURAL MUST y )",
          ],
          attributeTypes: [
            "( 1.2.4.1 NAME 'p' SUP q )",
            "( 1.2.4.2 NAME 'q' SUP p )",
          ],
        })
      );
      expect(cyclic.resolveAttributes(['a']).must.sort()).to.deep.equal([
        'x',
        'y',
      ]);
      expect(cyclic.getAttributeSyntax('p')).to.equal(undefined);
    });
  });
});
