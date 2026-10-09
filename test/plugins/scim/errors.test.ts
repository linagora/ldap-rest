import { expect } from 'chai';

import { scimErrorFromException } from '../../../src/plugins/scim/errors';
import {
  BadRequestError,
  ConflictError,
  HttpError,
} from '../../../src/lib/errors';

const withCode = <T extends Error>(err: T, code: number): T =>
  Object.assign(err, { code });

describe('SCIM errors from LDAP refusals', () => {
  it('should name a schema refusal answered 400 by ldapActions an invalid value', () => {
    const body = scimErrorFromException(
      withCode(new BadRequestError('mailQuota: attribute type undefined'), 17)
    );
    expect(body).to.include({ status: '400', scimType: 'invalidValue' });
    expect(body.detail).to.match(/mailQuota/);
  });

  it('should translate a bare schema refusal the same way', () => {
    const body = scimErrorFromException(
      withCode(new Error('mail: value #0 invalid per syntax'), 21)
    );
    expect(body).to.include({ status: '400', scimType: 'invalidValue' });
  });

  it('should leave the other HTTP errors as they are', () => {
    expect(
      scimErrorFromException(withCode(new ConflictError('held'), 65))
    ).to.not.have.property('scimType');
    expect(
      scimErrorFromException(new BadRequestError('bad'))
    ).to.not.have.property('scimType');
    expect(scimErrorFromException(new HttpError('down', 503)).status).to.equal(
      '503'
    );
  });

  it('should keep a failure that is not a refusal a 500', () => {
    const body = scimErrorFromException(withCode(new Error('other'), 80));
    expect(body.status).to.equal('500');
  });
});
