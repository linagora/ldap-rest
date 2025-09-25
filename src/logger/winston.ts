import winston from 'winston';

import { Config } from '../bin';

export const buildLogger = (config: Config): winston.Logger => {
  return winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message }) => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        return `${timestamp} [${level}]: ${message}`;
      })
    ),
    transports: [
      config.logger === 'console'
        ? new winston.transports.Console()
        : new winston.transports.File({ filename: 'error.log' }),
    ],
  });
};
