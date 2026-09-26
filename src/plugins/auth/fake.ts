/**
 * @module plugins/auth/fake
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Development authentication: every request is served as the identity given
 * on the command line, without asking for anything.
 * @group Plugins
 */
import type { Response } from 'express';

import AuthBase, { type DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

export default class AuthFake extends AuthBase {
  name = 'authFake';
  roles: Role[] = ['auth'] as const;
  private readonly user: string;

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);
    // The one guard between this plugin and an open directory: the image
    // sets NODE_ENV=production, so it cannot be switched on there.
    if (process.env.NODE_ENV === 'production')
      throw new Error(
        `${this.name}: refused with NODE_ENV=production — it serves every ` +
          'request without authentication'
      );
    this.user = ((this.config.auth_fake_user as string) || '').trim();
    if (!this.user)
      throw new Error(`${this.name}: --auth-fake-user is required`);
  }

  protected knownIdentities(): string[] {
    return [this.user];
  }

  protected identitySource(): string {
    return 'req.user and req.userName: --auth-fake-user';
  }

  afterLoad(): void {
    super.afterLoad();
    this.logger.warn(
      `${this.name}: every request is served as "${this.user}", ` +
        'without authentication'
    );
  }

  authMethod(req: DmRequest, _res: Response, next: () => void): void {
    this.publishIdentity(req, this.user);
    next();
  }
}
