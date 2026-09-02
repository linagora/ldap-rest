/**
 * @module plugins/ldap/accountLifecycle
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * The two account operations an administrator performs most often — change an
 * account's state, and reset its password — as first-class endpoints.
 *
 * Both are expressed against semantic roles, never attribute names. An entity
 * gets a `/status` endpoint when its schema declares an `accountStatus`
 * attribute with named `states`, and a `/password` endpoint when it declares a
 * `password` attribute. Which attribute that is, and what "disabled" means in
 * this directory, is schema configuration:
 *
 * ```json
 * "twakeAccountStatus": {
 *   "type": "pointer",
 *   "role": "accountStatus",
 *   "states": {
 *     "enabled":  "cn=active,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com",
 *     "disabled": "cn=disabled,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"
 *   }
 * }
 * ```
 *
 * Changes go through the entity's own modify path, so schema validation,
 * hooks and authorization apply exactly as they do to any other update.
 * @group Plugins
 */
import { randomBytes } from 'crypto';

import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { Schema } from '../../config/schema';
import { roleAttribute } from '../../config/schema';
import type { AttributesList, ModifyRequest } from '../../lib/ldapActions';
import { asyncHandler } from '../../lib/utils';
import { jsonBody } from '../../lib/expressFormatedResponses';
import { BadRequestError, NotFoundError } from '../../lib/errors';

/** The part of a flat entity this plugin drives. */
interface FlatEntity {
  pluralName: string;
  singularName: string;
  schema?: Schema;
  modifyEntry(id: string, changes: ModifyRequest): Promise<boolean>;
}

/** Alphabet of generated passwords: unambiguous, no lookalike characters. */
const PASSWORD_ALPHABET =
  'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%*-_=+';

/**
 * Draw a password from {@link PASSWORD_ALPHABET} with a uniform distribution.
 *
 * Bytes whose value would wrap the alphabet are discarded rather than folded
 * with a modulo, which would make the first characters of the alphabet more
 * likely than the last.
 *
 * @param length number of characters
 * @returns the generated password
 */
export function generatePassword(length = 16): string {
  const max =
    Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= max) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export default class LdapAccountLifecycle extends DmPlugin {
  name = 'ldapAccountLifecycle';
  roles: Role[] = ['api'] as const;

  dependencies = {
    ldapFlatGeneric: 'core/ldap/flatGeneric',
  };

  /**
   * Register the lifecycle endpoints of every flat entity whose schema asks
   * for them.
   *
   * @param app Express application
   */
  api(app: Express): void {
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | { instances?: FlatEntity[] }
      | undefined;
    if (!flat?.instances?.length) {
      this.logger.warn(
        'accountLifecycle: no flat entity is loaded, no endpoint registered'
      );
      return;
    }

    const prefix = `${this.config.api_prefix}/v1/ldap`;
    for (const entity of flat.instances) {
      const statusAttr = roleAttribute(entity.schema, 'accountStatus');
      const states = statusAttr
        ? entity.schema?.attributes[statusAttr]?.states
        : undefined;
      if (statusAttr && states && Object.keys(states).length > 0) {
        /**
         * @openapi
         * summary: Set the lifecycle state of an account
         * description: |
         *   Moves the account to one of the states its schema declares —
         *   `enabled`, `disabled`, or whatever else the deployment defines.
         *   The state names come from the schema, so `GET /config` lists the
         *   ones this directory accepts.
         * tags:
         *   - Entities
         * requestBody:
         *   required: true
         *   content:
         *     application/json:
         *       schema:
         *         type: object
         *         required: [state]
         *         properties:
         *           state:
         *             type: string
         *             description: Name of a state declared by the schema.
         *             example: disabled
         * responses:
         *   '200':
         *     description: State applied.
         *     content:
         *       application/json:
         *         example: { success: true, state: disabled }
         *   '400':
         *     description: Unknown state.
         *     content:
         *       application/json:
         *         schema: { $ref: '#/components/schemas/Error' }
         */
        app.post(
          `${prefix}/${entity.pluralName}/:id/status`,
          asyncHandler(async (req: Request, res: Response) =>
            this.setStatus(entity, statusAttr, states, req, res)
          )
        );
        this.logger.info(
          `accountLifecycle: ${entity.pluralName} states = ${Object.keys(states).join(', ')}`
        );
      }

      const passwordAttr = roleAttribute(entity.schema, 'password');
      if (passwordAttr) {
        /**
         * @openapi
         * summary: Reset the password of an account
         * description: |
         *   Replaces the credential. When the body carries no `password`, one
         *   is generated and returned **once** in the response — it is never
         *   readable afterwards. When the schema declares a `passwordReset`
         *   attribute, `forceChange` (true by default) also flags the account
         *   so the directory asks for a new password at next login.
         * tags:
         *   - Entities
         * requestBody:
         *   content:
         *     application/json:
         *       schema:
         *         type: object
         *         properties:
         *           password:
         *             type: string
         *             description: New password; generated when absent.
         *           forceChange:
         *             type: boolean
         *             default: true
         *             description: Require a change at next login.
         * responses:
         *   '200':
         *     description: Password replaced.
         *     content:
         *       application/json:
         *         example: { success: true, generated: true, password: 'xY3…' }
         */
        app.post(
          `${prefix}/${entity.pluralName}/:id/password`,
          asyncHandler(async (req: Request, res: Response) =>
            this.resetPassword(entity, passwordAttr, req, res)
          )
        );
      }
    }
  }

  /**
   * Apply a named state to an account.
   *
   * @param entity flat entity holding the account
   * @param attribute attribute carrying the state
   * @param states state names declared by the schema
   * @param req Express request
   * @param res Express response
   */
  private async setStatus(
    entity: FlatEntity,
    attribute: string,
    states: NonNullable<Schema['attributes'][string]['states']>,
    req: Request,
    res: Response
  ): Promise<void> {
    const body = jsonBody(req, res, 'state') as { state: string } | false;
    if (!body) return;
    const value = states[body.state];
    if (value === undefined) {
      throw new BadRequestError(
        `Unknown state "${body.state}" for ${entity.singularName}; known states: ${Object.keys(states).join(', ')}`
      );
    }
    const id = decodeURIComponent(req.params.id as string);
    await this.modify(entity, id, { replace: { [attribute]: value } });
    res.json({ success: true, state: body.state });
  }

  /**
   * Replace an account's credential, and flag it for a change at next login
   * when the schema knows how to.
   *
   * @param entity flat entity holding the account
   * @param attribute attribute carrying the credential
   * @param req Express request
   * @param res Express response
   */
  private async resetPassword(
    entity: FlatEntity,
    attribute: string,
    req: Request,
    res: Response
  ): Promise<void> {
    const body = jsonBody(req, res) as
      | { password?: string; forceChange?: boolean }
      | false;
    if (!body) return;

    const generated = !body.password;
    const password = body.password || generatePassword();

    const replace: AttributesList = { [attribute]: password };
    const resetAttr = roleAttribute(entity.schema, 'passwordReset');
    const forceChange = body.forceChange !== false;
    if (resetAttr) {
      const definition = entity.schema?.attributes[resetAttr];
      const states = definition?.states;
      const value = forceChange
        ? (states?.required ?? 'TRUE')
        : (states?.cleared ?? 'FALSE');
      replace[resetAttr] = value;
    }

    const id = decodeURIComponent(req.params.id as string);
    await this.modify(entity, id, { replace });

    // The generated password is shown once, here, and nowhere else: the
    // credential attributes are marked `neverReturn` in the schema precisely
    // so a later read cannot hand it back.
    res.json({
      success: true,
      generated,
      forceChange: Boolean(resetAttr) && forceChange,
      ...(generated ? { password } : {}),
    });
  }

  /**
   * Apply a change through the entity's own modify path, turning a missing
   * entry into a 404 rather than a directory error.
   *
   * @param entity flat entity holding the account
   * @param id identifier or DN of the entry
   * @param changes modification to apply
   */
  private async modify(
    entity: FlatEntity,
    id: string,
    changes: ModifyRequest
  ): Promise<void> {
    try {
      await entity.modifyEntry(id, changes);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 32) {
        throw new NotFoundError(`${entity.singularName} not found`);
      }
      throw err;
    }
  }
}
