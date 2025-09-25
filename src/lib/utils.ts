/**
 * @file src/lib/utils.ts
 * @description Utility functions
 * @author Xavier Guimard <xguimard@linagora.com>
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import type { Config } from '../bin';

import { getLogger } from './expressFormatedResponses';

const logger = getLogger();

// launchHooks launches hooks asynchroniously, errors are reported and ignored
export const launchHooks = async (
  hooks: Function[] | undefined,
  ...args: unknown[]
): Promise<void> => {
  if (hooks) {
    for (const hook of hooks) {
      if (hook)
        await hook(...args).catch((e: unknown) =>
          logger.error('Hook error', e)
        );
    }
  }
};

// launchHooksChained give the uniq argument (may be an array if you need to pas more than one arg)
// to each hook and collect the changes if any
// Any error stops the process
export const launchHooksChained = async <T>(
  hooks: Function[] | undefined,
  args: T
): Promise<T> => {
  if (hooks) {
    for (const hook of hooks) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      if (hook) args = await hook(args);
    }
  }
  return args;
};

export const transformSchemas = (
  schemas: string | Buffer,
  config: Config
): string => {
  const str = schemas.toString().replace(/__(\S+)__/g, (_, prm) => {
    if (!prm || typeof prm !== 'string') return _;
    const key: string = prm.trim().toLowerCase();
    if (config[key]) {
      if (typeof config[key] !== 'object') return config[key] as string;
      return JSON.stringify(config[key]);
    }
    return _;
  });
  return str;
};
