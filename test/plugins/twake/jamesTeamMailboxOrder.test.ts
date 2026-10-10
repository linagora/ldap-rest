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
      .put(`/domains/test.org/team-mailboxes/${mail}`)
      .delay(100)
      .reply(204, () => {
        events.push('created');
      });
    for (const member of ['a@test.org', 'b@test.org']) {
      nock(url)
        .put(`/domains/test.org/team-mailboxes/${mail}/members/${member}`)
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
});
