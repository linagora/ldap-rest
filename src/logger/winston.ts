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

const LOGGERS = ['console', 'file'] as const;

/**
 * @throws when `--logger` names no known logger, or `--logger file` has no
 * file: never a silent fallback
 */
export const buildLogger = (config: Config): winston.Logger => {
  // An empty value is unset, as for the other options
  const logger = config.logger || 'console';
  if (!(LOGGERS as readonly string[]).includes(logger))
    throw new Error(
      `Unknown logger "${String(logger)}": --logger takes ${LOGGERS.join(' or ')}`
    );
  if (logger === 'file' && !config.log_file)
    throw new Error(
      '--logger file needs a file: set --log-file (or DM_LOG_FILE)'
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
      logger === 'console'
        ? new winston.transports.Console({
            stderrLevels: ['error', 'warn'],
            format: winston.format.json(),
          })
        : new winston.transports.File({ filename: config.log_file }),
    ],
  });
};
