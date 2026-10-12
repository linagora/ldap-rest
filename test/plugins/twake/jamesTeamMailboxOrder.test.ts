import { expect } from 'chai';
import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';

/**
 * TMail answers 404 to the addition of a member to a team mailbox that does
 * not exist yet: the creation has to be over before any member is added.
 */
describe('James Plugin - team mailbox creation order', () => {
  const url = 'http://james.order.test:8000';
  const dn = 'cn=team,ou=groups,dc=example,dc=com';
  const mail = 'team@test.org';

  before(() => {
    nock.disableNetConnect();
  });

  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('adds the members only once the team mailbox is created', async () => {
    const dm = new DM();
    await dm.ready;
    dm.config.james_webadmin_url = url;
    const james = new James(dm);
    const internal = james as unknown as {
      getMemberEmails: (members: string[]) => Promise<string[]>;
      createTeamMailbox: (
        dn: string,
        attributes: Record<string, unknown>,
        mail: string
      ) => Promise<void>;
    };
    internal.getMemberEmails = () =>
      Promise.resolve(['a@test.org', 'b@test.org']);

    const events: string[] = [];
    nock(url)
      .put('/domains/test.org/team-mailboxes/team')
      .delay(100)
      .reply(204, () => {
        events.push('created');
      });
    for (const member of ['a@test.org', 'b@test.org']) {
      nock(url)
        .put(`/domains/test.org/team-mailboxes/team/members/${member}`)
        .reply(204, () => {
          events.push(`member ${member}`);
        });
    }

    await internal.createTeamMailbox(
      dn,
      { member: ['uid=a,ou=users', 'uid=b,ou=users'] },
      mail
    );

    expect(events).to.have.length(3);
    expect(events[0]).to.equal('created');
    expect(events.slice(1)).to.have.members([
      'member a@test.org',
      'member b@test.org',
    ]);
  });

  describe('name', () => {
    let james: James;
    let errors: unknown[];
    const create = (address: string) =>
      (
        james as unknown as {
          createTeamMailbox: (
            dn: string,
            attributes: Record<string, unknown>,
            mail: string
          ) => Promise<void>;
        }
      ).createTeamMailbox(dn, {}, address);

    beforeEach(async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.james_webadmin_url = url;
      james = new James(dm);
      errors = [];
      james.logger = {
        ...james.logger,
        info: () => undefined,
        error: (entry: unknown) => errors.push(entry),
      } as typeof james.logger;
    });

    it('names the team mailbox by the local part, escaped', async () => {
      // `#` would end the path, the rest taken for a fragment
      const scope = nock(url)
        .put('/domains/test.org/team-mailboxes/%23support')
        .reply(204);
      await create('#support@test.org');
      expect(scope.isDone()).to.be.true;
      expect(errors).to.deep.equal([]);
    });

    it('refuses an address TMail cannot name a team mailbox after', async () => {
      // nock lets no request through: a call would fail the test
      await create('sales.team@test.org');
      await create('no-domain');
      expect(errors).to.have.length(2);
    });
  });
});
