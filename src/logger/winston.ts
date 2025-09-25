import winston from 'winston';

import { Config } from '../bin';

export const buildLogger = (config: Config): winston.Logger => {
  return winston.createLogger({
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
