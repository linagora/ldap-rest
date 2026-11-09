/**
 * `core/scim` is the name the documentation gives; the plugin itself lives at
 * `core/scim/scim`. The short-name module must expose the same class.
 */
import { expect } from 'chai';
import Scim from '@ldap-rest/scim';
import ScimShort from '@ldap-rest/scim';

describe('SCIM plugin short name', () => {
  it('should expose the plugin from the documented core/scim module', () => {
    expect(ScimShort).to.equal(Scim);
  });
});
