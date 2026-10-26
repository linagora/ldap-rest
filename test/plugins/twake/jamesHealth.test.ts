import { expect } from 'chai';
import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';

describe('James Plugin - health', () => {
  const url = 'http://james.health.test:8000';
  let james: James;

  before(() => {
    nock.disableNetConnect();
  });

  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    const dm = new DM();
    await dm.ready;
    dm.config.james_webadmin_url = url;
    dm.config.james_webadmin_token = 'secret';
    james = new James(dm);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('is ok when James says so, with the token', async () => {
    const scope = nock(url, { reqheaders: { authorization: 'Bearer secret' } })
      .get('/healthcheck')
      .reply(200, { status: 'healthy' });
    expect(await james.health()).to.equal('ok');
    expect(scope.isDone()).to.equal(true);
  });

  it('is degraded when James says so', async () => {
    nock(url).get('/healthcheck').reply(503, { status: 'unhealthy' });
    expect(await james.health()).to.equal('degraded');
  });

  it('is degraded when James does not answer', async () => {
    nock(url).get('/healthcheck').replyWithError('connection refused');
    expect(await james.health()).to.equal('degraded');
  });
});
