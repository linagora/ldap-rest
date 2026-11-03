/**
 * Fallback ambient declaration for `lemonldap-ng-handler`.
 *
 * It is an optional dependency (see package.json's `optionalDependencies`)
 * and in turn depends on the native `re2` module. `re2`'s `engines`
 * constraint means it — and so `lemonldap-ng-handler` with it — is missing
 * from node_modules on some Node versions the project still supports: no
 * single `re2` version satisfies every supported Node version at once.
 *
 * Without this file, `tsc` fails with "Cannot find module
 * 'lemonldap-ng-handler'" whenever the package happens to be absent, which
 * breaks the build for the whole project over one optional plugin. This
 * declares only what src/plugins/auth/llng.ts uses.
 *
 * An ambient module declaration takes precedence over the resolved package,
 * so `tsc` checks against this file even when `lemonldap-ng-handler` is
 * installed: the package's own types are never consulted. Each signature
 * here must stay one the real module accepts, and nothing else checks it:
 * the plugin's tests replace the module with a stand-in.
 */
declare module 'lemonldap-ng-handler' {
  import type { Response } from 'express';

  import type { DmRequest } from '../lib/auth/base';

  export function init(args: {
    configStorage?: { confFile?: string; [key: string]: unknown };
    type?: string;
  }): Promise<unknown>;

  export function run(req: DmRequest, res: Response, next: () => void): void;
}
