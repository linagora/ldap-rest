import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  const loggers: winston.Logger[] = [];
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-logger-'));
  });

  afterEach(() => {
    for (const logger of loggers.splice(0)) logger.close();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const build = (over: Partial<Config>): winston.Logger => {
    const logger = buildLogger(config(over));
    loggers.push(logger);
    return logger;
  };

  it('logs to the console by default', () => {
    expect(build({}).transports[0]).to.be.instanceOf(
      winston.transports.Console
    );
  });

  it('reads an empty --logger as console', () => {
    expect(
      build({ logger: '' as Config['logger'] }).transports[0]
    ).to.be.instanceOf(winston.transports.Console);
  });

  it('writes --logger file to --log-file', () => {
    const file = path.join(dir, 'dm-test.log');
    const transport = build({ logger: 'file', log_file: file })
      .transports[0] as winston.transports.FileTransportInstance;
    expect(transport).to.be.instanceOf(winston.transports.File);
    expect(path.join(transport.dirname, transport.filename)).to.equal(file);
  });

  it('refuses a logger it does not know', () => {
    expect(() => build({ logger: 'syslog' as Config['logger'] })).to.throw(
      /Unknown logger "syslog": --logger takes console or file/
    );
  });

  it('refuses --logger file without a file', () => {
    expect(() => build({ logger: 'file', log_file: '' })).to.throw(
      /--logger file needs a file: set --log-file \(or DM_LOG_FILE\)/
    );
  });
});
