import { expect } from 'chai';

import {
  assertProjection,
  projectList,
  projectResource,
} from '../../../src/plugins/scim/projection';
import { ScimError } from '../../../src/plugins/scim/errors';

const user = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  id: 'alice',
  externalId: '701984',
  userName: 'alice',
  name: { familyName: 'Doe', givenName: 'Alice', formatted: 'Alice Doe' },
  displayName: 'Alice D.',
  active: true,
  emails: [
    { value: 'alice@example.com', type: 'work', primary: true },
    { value: 'a@corp.com', type: 'home' },
  ],
  meta: { resourceType: 'User', location: 'https://x/scim/v2/Users/alice' },
};

describe('SCIM attribute projection (RFC 7644 section 3.9)', () => {
  it('returns the resource untouched with no parameter', () => {
    expect(projectResource(user, {})).to.equal(user);
  });

  describe('attributes', () => {
    it('keeps only what was asked, plus the always-returned ones', () => {
      const out = projectResource(user, { attributes: ['userName'] });
      expect(Object.keys(out).sort()).to.deep.equal([
        'id',
        'schemas',
        'userName',
      ]);
    });

    it('narrows a complex attribute to a sub-attribute', () => {
      const out = projectResource(user, {
        attributes: ['name.familyName'],
      });
      expect(out.name).to.deep.equal({ familyName: 'Doe' });
    });

    it('narrows every value of a multi-valued attribute', () => {
      const out = projectResource(user, { attributes: ['emails.value'] });
      expect(out.emails).to.deep.equal([
        { value: 'alice@example.com' },
        { value: 'a@corp.com' },
      ]);
    });

    it('omits an attribute the narrowing empties', () => {
      // `name` holds no middleName here; answering `name: {}` would claim it
      // is present and empty.
      const out = projectResource(user, { attributes: ['name.middleName'] });
      expect(out).to.not.have.property('name');
      expect(Object.keys(out).sort()).to.deep.equal(['id', 'schemas']);
    });

    it('omits a multi-valued attribute left with nothing', () => {
      const out = projectResource(user, { attributes: ['emails.nosuch'] });
      expect(out).to.not.have.property('emails');
    });

    it('keeps an attribute that still has something', () => {
      const out = projectResource(user, {
        attributes: ['name.middleName', 'name.familyName'],
      });
      expect(out.name).to.deep.equal({ familyName: 'Doe' });
    });

    it('a whole attribute wins over its own sub-attributes', () => {
      const out = projectResource(user, {
        attributes: ['name', 'name.givenName'],
      });
      expect(out.name).to.deep.equal(user.name);
    });

    it('is case-insensitive, as SCIM attribute names are', () => {
      const out = projectResource(user, { attributes: ['USERNAME'] });
      expect(out.userName).to.equal('alice');
    });

    it('strips a core schema URN prefix', () => {
      const out = projectResource(user, {
        attributes: ['urn:ietf:params:scim:schemas:core:2.0:User:displayName'],
      });
      expect(out.displayName).to.equal('Alice D.');
    });

    it('ignores an attribute the resource does not carry', () => {
      const out = projectResource(user, {
        attributes: ['userName', 'nickName'],
      });
      expect(out).to.not.have.property('nickName');
      expect(out.userName).to.equal('alice');
    });

    it('drops meta, whose returned characteristic is default', () => {
      const out = projectResource(user, { attributes: ['userName'] });
      expect(out).to.not.have.property('meta');
      // …unless it is asked for.
      expect(projectResource(user, { attributes: ['meta'] })).to.have.property(
        'meta'
      );
    });
  });

  describe('excludedAttributes', () => {
    it('drops what was named and keeps the rest', () => {
      const out = projectResource(user, {
        excludedAttributes: ['emails', 'name'],
      });
      expect(out).to.not.have.property('emails');
      expect(out).to.not.have.property('name');
      expect(out.userName).to.equal('alice');
      expect(out.meta).to.deep.equal(user.meta);
    });

    it('drops a sub-attribute without dropping its parent', () => {
      const out = projectResource(user, {
        excludedAttributes: ['name.formatted'],
      });
      expect(out.name).to.deep.equal({
        familyName: 'Doe',
        givenName: 'Alice',
      });
    });

    it('drops a sub-attribute from every value of a multi-valued one', () => {
      const out = projectResource(user, {
        excludedAttributes: ['emails.type'],
      });
      expect(out.emails).to.deep.equal([
        { value: 'alice@example.com', primary: true },
        { value: 'a@corp.com' },
      ]);
    });

    it('omits an attribute whose sub-attributes are all excluded', () => {
      const out = projectResource(user, {
        excludedAttributes: [
          'name.familyName',
          'name.givenName',
          'name.formatted',
        ],
      });
      expect(out).to.not.have.property('name');
      // The rest of the resource is untouched.
      expect(out.userName).to.equal('alice');
    });

    it('cannot drop id or schemas, whose returned is always', () => {
      const out = projectResource(user, {
        excludedAttributes: ['id', 'schemas', 'userName'],
      });
      expect(out.id).to.equal('alice');
      expect(out.schemas).to.deep.equal(user.schemas);
      expect(out).to.not.have.property('userName');
    });
  });

  describe('the two together', () => {
    it('is refused: they are mutually exclusive', () => {
      try {
        assertProjection({
          attributes: ['userName'],
          excludedAttributes: ['emails'],
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ScimError);
        expect((err as ScimError).scimType).to.equal('invalidValue');
        expect((err as ScimError).statusCode).to.equal(400);
      }
    });

    it('accepts either one alone, or neither', () => {
      expect(() =>
        assertProjection({ attributes: ['userName'] })
      ).to.not.throw();
      expect(() =>
        assertProjection({ excludedAttributes: ['emails'] })
      ).to.not.throw();
      expect(() => assertProjection({})).to.not.throw();
    });
  });

  describe('projectList', () => {
    it('projects every resource of the envelope', () => {
      const list: { totalResults: number; Resources: (typeof user)[] } = {
        totalResults: 1,
        Resources: [user],
      };
      const out = projectList(list, { attributes: ['userName'] });
      expect(out.totalResults).to.equal(1);
      expect(Object.keys(out.Resources[0]).sort()).to.deep.equal([
        'id',
        'schemas',
        'userName',
      ]);
    });

    it('leaves the envelope untouched with no parameter', () => {
      const list = { Resources: [user] };
      expect(projectList(list, {})).to.equal(list);
    });
  });
});
