/**
 * @module plugins/auth/token
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Token-based authentication plugin
 * @group Plugins
 */
import type { Response } from 'express';

import { unauthorized } from '../../lib/expressFormatedResponses';
import AuthBase, { type DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

export default class AuthToken extends AuthBase {
  name = 'authToken';
  roles: Role[] = ['auth'] as const;
  private tokenMap: Map<string, string> = new Map(); // token -> name

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);

    // Parse tokens and build token map
    const tokens = this.config.auth_token as string[];
    if (tokens && Array.isArray(tokens)) {
      tokens.forEach((tokenEntry, index) => {
        if (tokenEntry.includes(':')) {
          // Format: "token:name"
          const [token, name] = tokenEntry.split(':', 2);
          this.tokenMap.set(token.trim(), name.trim());
        } else {
          // Legacy format: just token, use index as name
          this.tokenMap.set(tokenEntry.trim(), `token ${index}`);
        }
      });
    }
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    let token = req.headers['authorization'];

    if (!token || !/^Bearer .+/.test(token)) {
      this.logger.warn('Missing or invalid Authorization header');
      return unauthorized(res);
    }
    token = token.split(' ')[1];

    const userName = this.tokenMap.get(token);
    if (!userName) {
      // Mask token in logs to prevent credential exposure
      const maskedToken =
        token.length > 8 ? `${token.substring(0, 8)}...` : '***';
      this.logger.warn(`Unauthorized token: ${maskedToken}`);
      return unauthorized(res);
    }

    req.user = userName;
    next();
  }
}
