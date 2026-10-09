/**
 * A write the directory refuses for what it asks — an attribute its schema
 * does not define, a value of the wrong syntax, an entry missing what its
 * class requires — is the client's mistake: it answers 400 with the
 * directory's diagnostic, not a 500 telling the client to check logs.
 *
 * The fixture schema offers `noSuchQuota`, which the test directory does not
 * define, as the Twake user schema offered `mailQuota`, and leaves `sn`
 * optional though inetOrgPerson requires it.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { isSchemaRefusal } from '../../../src/lib/ldapCodes';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Writes the directory refuses for their content', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  const route = '/api/v1/ldap/refusedPeople';
  const dnOf = (id: string): string => `uid=${id},ou=users,${base}`;

  /** The status and LDAP code of a direct write. */
  const outcome = async (
    write: Promise<unknown>
  ): Promise<{ status: number | 'ok'; code?: number; message?: string }> => {
    try {
      await write;
      return { status: 'ok' };
    } catch (err) {
      const e = err as { statusCode?: number; code?: number; message: string };
      return { status: e.statusCode ?? 500, code: e.code, message: e.message };
    }
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/refusedByDirectory.json',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  beforeEach(async () => {
    await server.ldap.add(dnOf('refused-alice'), {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'refused-alice',
      cn: 'Alice',
      sn: 'Refused',
    });
  });

  afterEach(async () => {
    for (const id of ['refused-alice', 'refused-bob'])
      await server.ldap.delete(dnOf(id)).catch(() => undefined);
  });

  describe('the codes', () => {
    it('should count the schema refusals, and only them', () => {
      for (const code of [17, 18, 19, 21, 34, 64, 65, 67, 69])
        expect(isSchemaRefusal(code), String(code)).to.be.true;
      for (const code of [undefined, 1, 4, 16, 20, 32, 50, 53, 68, 80])
        expect(isSchemaRefusal(code), String(code)).to.be.false;
    });
  });

  describe('on the routes', () => {
    it('should answer 400 naming an attribute the directory does not define', async () => {
      const res = await request
        .put(`${route}/refused-alice`)
        .send({ replace: { noSuchQuota: '1000' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/noSuchQuota/);
      expect(res.body.error).to.match(/attribute type undefined/i);
    });

    it('should leave the entry as it was', async () => {
      await request
        .put(`${route}/refused-alice`)
        .send({ replace: { noSuchQuota: '1000', cn: 'Changed' } })
        .expect(400);
      const res = await request.get(`${route}/refused-alice`).expect(200);
      expect(res.body.cn).to.equal('Alice');
    });

    it('should answer 400 for a value of the wrong syntax', async () => {
      // mail is an IA5String: no letter outside ASCII
      const res = await request
        .put(`${route}/refused-alice`)
        .send({ replace: { mail: 'alicé@example.org' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/mail/);
    });

    it('should answer 400 for a creation missing what the class requires', async () => {
      const res = await request
        .post(route)
        .send({ uid: 'refused-bob', cn: 'Bob' });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/sn/);
    });

    it('should still answer 500 for a failure that is not the request', async () => {
      const modify = server.ldap.modify;
      server.ldap.modify = () => Promise.reject(new Error('connection lost'));
      try {
        const res = await request
          .put(`${route}/refused-alice`)
          .send({ replace: { cn: 'Changed' } });
        expect(res.status).to.equal(500);
        expect(res.body.error).to.equal('check logs');
        expect(JSON.stringify(res.body)).to.not.match(/connection lost/);
      } finally {
        server.ldap.modify = modify;
      }
    });
  });

  describe('in ldapActions', () => {
    it('should keep the LDAP code on the 400', async () => {
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), {
          replace: { noSuchQuota: '1' },
        })
      );
      expect(res.status).to.equal(400);
      expect(res.code).to.equal(17);
      expect(res.message).to.match(/noSuchQuota/);
    });

    it('should answer 400 to an add missing a mandatory attribute', async () => {
      const res = await outcome(
        server.ldap.add(dnOf('refused-bob'), {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'refused-bob',
          cn: 'Bob',
        })
      );
      expect(res).to.include({ status: 400, code: 65 });
    });

    it('should answer 400 to an add naming a value twice', async () => {
      const res = await outcome(
        server.ldap.add(dnOf('refused-bob'), {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'refused-bob',
          cn: ['Bob', 'Bob'],
          sn: 'Refused',
        })
      );
      expect(res).to.include({ status: 400, code: 20 });
    });

    it('should answer 409 to a modify adding a value already there', async () => {
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), { add: { cn: 'Alice' } })
      );
      expect(res).to.include({ status: 409, code: 20 });
    });

    it('should answer 400 to a modify removing the naming value', async () => {
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), {
          delete: { uid: 'refused-alice' },
        })
      );
      // namingViolation from OpenLDAP, notAllowedOnRDN from others
      expect(res.status).to.equal(400);
      expect(res.code).to.be.oneOf([64, 67]);
    });

    it('should keep 409 for an attribute the classes of the entry do not allow', async () => {
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), {
          add: { mailQuotaSize: '1' },
        })
      );
      expect(res).to.include({ status: 409, code: 65 });
    });

    it('should keep 409 for an entry already there', async () => {
      const res = await outcome(
        server.ldap.add(dnOf('refused-alice'), {
          objectClass: ['top', 'inetOrgPerson'],
          uid: 'refused-alice',
          cn: 'Alice',
          sn: 'Refused',
        })
      );
      expect(res).to.include({ status: 409, code: 68 });
    });

    it('should leave other failures without a status', async () => {
      const res = await outcome(
        server.ldap.modify(dnOf('refused-nobody'), { replace: { cn: 'x' } })
      );
      expect(res.status).to.equal(500);
      expect(res.code).to.equal(32);
    });
  });

  describe('on a rename or a move', () => {
    beforeEach(async () => {
      await server.ldap.add(dnOf('refused-bob'), {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'refused-bob',
        cn: 'Bob',
        sn: 'Refused',
      });
    });

    it('should answer 409 naming the new DN when it is taken', async () => {
      for (const write of [
        () => server.ldap.rename(dnOf('refused-alice'), dnOf('refused-bob')),
        () => server.ldap.move(dnOf('refused-alice'), dnOf('refused-bob')),
      ]) {
        const res = await outcome(write());
        expect(res).to.include({ status: 409, code: 68 });
        expect(res.message).to.include(dnOf('refused-bob'));
      }
    });

    it('should answer 400 naming both DNs when the new one is refused', async () => {
      // dc is not an attribute inetOrgPerson allows
      const target = `dc=refused-alice,ou=users,${base}`;
      for (const write of [
        () => server.ldap.rename(dnOf('refused-alice'), target),
        () => server.ldap.move(dnOf('refused-alice'), target),
      ]) {
        const res = await outcome(write());
        expect(res.status).to.equal(400);
        expect(isSchemaRefusal(res.code), String(res.code)).to.be.true;
        expect(res.message).to.include(dnOf('refused-alice'));
        expect(res.message).to.include(target);
      }
    });
  });

  describe('a driver error carrying its code in its text only', () => {
    const ldap = (): Record<string, unknown> =>
      server.ldap as unknown as Record<string, unknown>;
    let saved: Record<string, unknown>;

    /** Every write the directory receives fails with `message`. */
    const failWith = (message: string): void => {
      const fail = (): Promise<never> => Promise.reject(new Error(message));
      ldap().acquireConnection = () =>
        Promise.resolve({
          client: { add: fail, modify: fail, modifyDN: fail },
        });
      ldap().releaseConnection = () => undefined;
    };

    beforeEach(() => {
      saved = {
        acquireConnection: ldap().acquireConnection,
        releaseConnection: ldap().releaseConnection,
      };
    });

    afterEach(() => Object.assign(ldap(), saved));

    it('should still answer 400 to a schema refusal', async () => {
      failWith(
        'UndefinedTypeError: noSuchQuota: attribute type undefined Code: 0x11'
      );
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), {
          replace: { noSuchQuota: '1' },
        })
      );
      expect(res).to.include({ status: 400, code: 17 });
    });

    it('should still answer 409 to a taken DN', async () => {
      failWith('AlreadyExistsError: Entry Already Exists Code: 0x44');
      const res = await outcome(
        server.ldap.rename(dnOf('refused-alice'), dnOf('refused-bob'))
      );
      expect(res).to.include({ status: 409, code: 68 });
    });

    it('should leave an unknown failure without a status', async () => {
      failWith('socket hang up');
      const res = await outcome(
        server.ldap.modify(dnOf('refused-alice'), { replace: { cn: 'x' } })
      );
      expect(res.status).to.equal(500);
      expect(res.code).to.be.undefined;
    });
  });
});
