/**
 * @module core/static
 * Serve static files and JSON schemas
 *
 * This plugin serves static files from a specified directory.
 * It provides access to JSON schemas if stored in a "schemas" subdirectory
 * and modify them on-the-fly to replace __FOO_BAR__ by --foo-bar value.
 *
 * This permits to share the same schemas between server and JS embedded in web pages.
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import fs from 'fs';
import { join, resolve } from 'path';

import type { Express } from 'express';
import express from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { notFound } from '../lib/expressFormatedResponses';
import { transformSchemas } from '../lib/utils';

/**
 * @openapi-component
 * LdapSchema:
 *   type: object
 *   description: |
 *     A JSON schema file served from the `schemas/` sub-directory of the
 *     static path.  These schemas describe LDAP entity types (users, groups,
 *     organizations, …) and are consumed by browser-embedded editors to
 *     render attribute forms and validate input before submission.
 *
 *     The server replaces `__FOO_BAR__` placeholders on the fly with the
 *     value of the corresponding `--foo-bar` CLI option so that a single
 *     schema file can be shared between server-side validation and
 *     client-side rendering.
 *   additionalProperties: true
 *   example:
 *     entity:
 *       name: standardUser
 *       mainAttribute: uid
 *       objectClass: [top, inetOrgPerson]
 *       singularName: user
 *       pluralName: users
 *       base: ou=users,dc=example,dc=com
 *     strict: true
 *     attributes:
 *       uid:
 *         type: string
 *         required: true
 *         role: identifier
 *       cn:
 *         type: string
 *         required: true
 */
export default class Static extends DmPlugin {
  name: string = 'static';
  roles: Role[] = ['api', 'configurable'] as const;

  api(app: Express): void {
    const rep = this.config.static_path;
    if (!rep) throw new Error('--static-path is not defined');
    try {
      const stat = fs.statSync(rep);
      if (!stat.isDirectory()) throw new Error(`${rep} isn't a directory`);
      fs.accessSync(rep, fs.constants.R_OK);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Bad directory ${rep}: ${e}`);
    }
    /**
     * @openapi
     * summary: Get JSON schema by name
     * description: |
     *   Returns a JSON schema file from the top-level `schemas/` directory
     *   of the configured static path.  The `:name` segment must match
     *   `[\w-]+\.json` (alphanumerics, hyphens, `.json` extension).
     *
     *   Schema files may contain `__FOO_BAR__` placeholders that are
     *   substituted at serve-time with the value of the corresponding
     *   `--foo-bar` server option, allowing the same file to be used for
     *   both server-side validation and browser-side form rendering.
     * responses:
     *   '200':
     *     description: JSON schema file.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/LdapSchema' }
     *         example:
     *           entity:
     *             name: standardUser
     *             mainAttribute: uid
     *             objectClass: [top, inetOrgPerson]
     *             base: ou=users,dc=example,dc=com
     *           strict: true
     *           attributes:
     *             uid: { type: string, required: true, role: identifier }
     *             cn: { type: string, required: true }
     *   '400':
     *     description: Invalid schema name (must match `[\w-]+\.json`).
     *   '404':
     *     description: Schema file not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(`/${this.config.static_name}/schemas/:name`, (req, res) => {
      if (!/^[\w-]+\.json$/.test(req.params.name)) {
        return res.status(400).send('Invalid schema name');
      }
      const schemaPath = resolve(join(rep, 'schemas', req.params.name));
      const schemasDir = resolve(join(rep, 'schemas'));
      // Prevent path traversal by ensuring resolved path is within schemas directory
      if (!schemaPath.startsWith(schemasDir + '/')) {
        return res.status(403).send('Access denied');
      }
      fs.readFile(schemaPath, (err, data) => {
        if (err) {
          return notFound(res, 'Schema not found');
        }
        const str = transformSchemas(data, this.config);
        res.type('json').send(str);
      });
    });
    /**
     * @openapi
     * summary: Get JSON schema from subdirectory
     * description: |
     *   Returns a JSON schema from a named sub-directory of `schemas/`.
     *   Both `:dir` (alphanumerics and hyphens) and `:name` (`[\w-]+\.json`)
     *   are validated before the file-system path is resolved, and the
     *   resolved path is checked against the schemas root to prevent
     *   path-traversal attacks.
     *
     *   Available sub-directories depend on the static path configured at
     *   startup.  Typical deployments include `standard`, `twake`, `ad`,
     *   `scim`, and `obm`.
     * responses:
     *   '200':
     *     description: JSON schema file from the sub-directory.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/LdapSchema' }
     *         example:
     *           entity:
     *             name: twakeUser
     *             mainAttribute: uid
     *             objectClass: [top, inetOrgPerson, twakePerson]
     *             base: ou=users,dc=example,dc=com
     *           strict: false
     *           attributes:
     *             uid: { type: string, required: true, role: identifier }
     *             mail: { type: string, required: true }
     *   '400':
     *     description: Invalid directory or schema name.
     *   '404':
     *     description: Schema file not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(`/${this.config.static_name}/schemas/:dir/:name`, (req, res) => {
      if (
        !/^[\w-]+$/.test(req.params.dir) ||
        !/^[\w-]+\.json$/.test(req.params.name)
      ) {
        return res.status(400).send('Invalid schema name');
      }
      const schemaPath = resolve(
        join(rep, 'schemas', req.params.dir, req.params.name)
      );
      const schemasDir = resolve(join(rep, 'schemas'));
      // Prevent path traversal by ensuring resolved path is within schemas directory
      if (!schemaPath.startsWith(schemasDir + '/')) {
        return res.status(403).send('Access denied');
      }
      fs.readFile(schemaPath, (err, data) => {
        if (err) {
          return notFound(res, 'Schema not found');
        }
        const str = transformSchemas(data, this.config);
        res.type('json').send(str);
      });
    });
    app.use(`/${this.config.static_name}`, express.static(rep));
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const staticName = this.config.static_name || 'static';
    const staticPath = `/${staticName}`;

    return {
      enabled: true,
      staticPath,
      endpoints: {
        schema: `${staticPath}/schemas/:name`,
        schemaInSubdir: `${staticPath}/schemas/:dir/:name`,
        files: `${staticPath}/*`,
      },
    };
  }
}
