import { expect } from 'chai';

import {
  AuthzRefusedError,
  ForbiddenError,
  NotFoundError,
  errorChain,
  isAuthzRefusal,
  statusCodeOf,
} from '../../src/lib/errors';

const wrapping = (err: unknown): Error =>
  new Error(`wrapped: ${String(err)}`, { cause: err });

describe('error chain', () => {
  it('reads the status of the first error that names one', () => {
    // A layer translating what it caught keeps its own status, whatever the
    // status of the error it wraps.
    const translated = Object.assign(new ForbiddenError('hidden'), {
      cause: new NotFoundError('gone'),
    });
    expect(statusCodeOf(wrapping(translated))).to.equal(403);
  });

  it('reads a `status` when no error names a `statusCode`', () => {
    // Express's router sets `status` alone on a malformed path parameter
    const err = Object.assign(new URIError("Failed to decode param '%FF'"), {
      status: 400,
    });
    expect(statusCodeOf(wrapping(err))).to.equal(400);
  });

  it('ignores a `status` outside the HTTP error range', () => {
    const err = Object.assign(new Error('odd'), { status: 200 });
    expect(statusCodeOf(err)).to.equal(500);
  });

  it('reads a refusal through a wrapper and a renamed subclass', () => {
    class Renamed extends AuthzRefusedError {
      constructor() {
        super('refused');
        (this as { name: string }).name = 'Renamed';
      }
    }
    expect(isAuthzRefusal(wrapping(new Renamed()))).to.equal(true);
    expect(isAuthzRefusal(wrapping(new ForbiddenError('plain')))).to.equal(
      false
    );
  });

  it('stops on a loop of causes', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(errorChain(first)).to.deep.equal([first, second]);
  });
});
