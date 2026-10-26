import { expect } from 'chai';
import winston from 'winston';

import { buildLogger } from '../../src/logger/winston';
import type { Config } from '../../src/bin';

const config = (over: Partial<Config>): Config =>
  ({
    log_level: 'notice',
    logger: 'console',
    log_file: 'error.log',
    ...over,
  }) as Config;

describe('buildLogger', () => {
  it('logs to the console by default', () => {
    const logger = buildLogger(config({}));
    expect(logger.transports[0]).to.be.instanceOf(winston.transports.Console);
  });

  it('writes --logger file to --log-file', () => {
    const logger = buildLogger(
      config({ logger: 'file', log_file: '/tmp/dm-test.log' })
    );
    const transport = logger
      .transports[0] as winston.transports.FileTransportInstance;
    expect(transport).to.be.instanceOf(winston.transports.File);
    expect(transport.filename).to.equal('dm-test.log');
    expect(transport.dirname).to.equal('/tmp');
  });

  it('refuses a logger it does not know', () => {
    expect(() =>
      buildLogger(config({ logger: 'syslog' as Config['logger'] }))
    ).to.throw(/Unknown logger "syslog": --logger takes console or file/);
  });
});
