import winston from 'winston';

import { Config } from '../bin';

// Define custom log levels with notice between info and warn (like syslog)
const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    notice: 2,
    info: 3,
    debug: 4,
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    notice: 'cyan',
    info: 'green',
    debug: 'blue',
  },
};

// Add notice method to winston.Logger type
declare module 'winston' {
  interface Logger {
    notice: winston.LeveledLogMethod;
  }
}

export const LOGGERS = ['console', 'file'] as const;

/**
 * @throws when `--logger` names no known logger: any other value wrote
 * `error.log` in the working directory without a word
 */
export const buildLogger = (config: Config): winston.Logger => {
  if (!(LOGGERS as readonly string[]).includes(config.logger))
    throw new Error(
      `Unknown logger "${String(config.logger)}": --logger takes ${LOGGERS.join(' or ')}`
    );
  return winston.createLogger({
    levels: customLevels.levels,
    level: config.log_level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message }) => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        return `${timestamp} [${level}]: ${message}`;
      })
    ),
    transports: [
      config.logger === 'console'
        ? new winston.transports.Console({
            stderrLevels: ['error', 'warn'],
            format: winston.format.json(),
          })
        : new winston.transports.File({ filename: config.log_file }),
    ],
  });
};
