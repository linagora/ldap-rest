import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import winston from 'winston';

import { buildLogger } from '../../src/logger/winston';
import { runAsPlugin, runWithLogContext } from '../../src/lib/requestContext';
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

  it('writes the request, the plugin and the hook before the message', async () => {
    const file = path.join(dir, 'dm-fields.log');
    const logger = build({ logger: 'file', log_file: file, log_level: 'info' });
    runWithLogContext({ requestId: 'R1' }, () => {
      logger.info('serving');
      runAsPlugin('james', 'ldapadddone', () => logger.info('in the hook'));
    });
    logger.info({ message: 'named', plugin: 'drive' });
    logger.warn({
      message: 'failed',
      plugin: 'rabbitmq',
      error: 'Error: broker down',
    });
    logger.warn({ message: 'failed too', error: new Error('down') });
    const circular: Record<string, unknown> = { code: 406 };
    circular.self = circular;
    logger.warn({ message: 'failed again', error: circular });
    await new Promise<void>(resolve => logger.on('finish', resolve).end());
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map(l => l.replace(/^\S+ /, ''))).to.deep.equal([
      '[info] [R1]: serving',
      '[info] [R1] [james ldapadddone]: in the hook',
      '[info] [drive]: named',
      '[warn] [rabbitmq]: failed (Error: broker down)',
      '[warn]: failed too (Error: down)',
      '[warn]: failed again (<ref *1> { code: 406, self: [Circular *1] })',
    ]);
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
