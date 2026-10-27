import winston from 'winston';

import { Config } from '../bin';
import { currentLogContext } from '../lib/requestContext';

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
 * The request a line is written for, and the plugin's hook writing it; a
 * `plugin` the line names itself is kept.
 */
const withContext = winston.format(info => {
  const context = currentLogContext();
  if (!context) return info;
  if (context.requestId) info.requestId = context.requestId;
  if (context.plugin && info.plugin === undefined) {
    info.plugin = context.plugin;
    info.op = context.op;
  }
  return info;
});

/**
 * @throws when `--logger` names no known logger, or `--logger file` has no
 * file: never a file nobody asked for
 */
export const buildLogger = (config: Config): winston.Logger => {
  // parseConfig keeps an empty DM_LOGGER as '': it means the default
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
      withContext(),
      winston.format.printf(
        ({ timestamp, level, message, requestId, plugin, op }) => {
          const request =
            typeof requestId === 'string' ? ` [${requestId}]` : '';
          const where =
            typeof plugin === 'string'
              ? ` [${plugin}${typeof op === 'string' ? ` ${op}` : ''}]`
              : '';
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          return `${timestamp} [${level}]${request}${where}: ${message}`;
        }
      )
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
