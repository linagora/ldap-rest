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

export const buildLogger = (config: Config): winston.Logger => {
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
        : new winston.transports.File({ filename: 'error.log' }),
    ],
  });
};
