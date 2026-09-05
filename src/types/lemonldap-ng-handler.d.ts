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
 * declares only what src/plugins/auth/llng.ts uses. `skipLibCheck` (set in
 * tsconfig.json) is what lets this declaration coexist with the package's
 * real, more complete types when it is installed, instead of conflicting
 * with them.
 */
declare module 'lemonldap-ng-handler' {
  import type { Response } from 'express';

  import type { DmRequest } from '../lib/auth/base';

  export function run(req: DmRequest, res: Response, next: () => void): void;
}
