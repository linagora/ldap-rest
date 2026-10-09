/**
 * @module core/static
 * Serve static files and JSON schemas
 *
 * This plugin serves static files from a specified directory.
 * It provides access to JSON schemas if stored in a "schemas" subdirectory
 * and modify them on-the-fly to replace __FOO_BAR__ by --foo-bar value and
 * to merge the schemas they extend. The schema files of the configuration
 * are served at the URL the plugins advertise for them, even when they are
 * outside of that directory.
 *
 * This permits to share the same schemas between server and JS embedded in web pages.
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import fs from 'fs';
import { join, resolve } from 'path';

import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { notFound, serverError } from '../lib/expressFormatedResponses';
import {
  configuredSchemaFiles,
  loadSchemaFileAsync,
  schemaUrl,
} from '../lib/schemaFile';

/**
 * The path of a request as the configuration writes it: `schemaUrl` puts
 * a file path in the URL as it is, and the client percent-encodes it
 */
const decodedPath = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

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
 *     client-side rendering. A schema that `extends` another is served
 *     merged with it.
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
    const serve = this.schemaServer(rep);
    /**
     * @openapi
     * summary: Get JSON schema by name
     * description: |
     *   Returns a JSON schema file from the top-level `schemas/` directory
     *   of the configured static path.  The `:name` segment must be made of
     *   alphanumerics and hyphens, in parts joined by single dots, with a
     *   `.json` extension; a name without that extension is served as a
     *   plain static file.
     *
     *   Schema files may contain `__FOO_BAR__` placeholders that are
     *   substituted at serve-time with the value of the corresponding
     *   `--foo-bar` server option, allowing the same file to be used for
     *   both server-side validation and browser-side form rendering. A
     *   schema that `extends` another is served merged with it, and a
     *   schema file of the configuration is served at the `schemaUrl` the
     *   configuration API gives for it, wherever the file is.
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
     *     description: Invalid schema name.
     *   '404':
     *     description: Schema file not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '500':
     *     description: A schema it extends is missing or invalid.
     */
    app.get(`/${this.config.static_name}/schemas/:name`, (req, res, next) =>
      serve([req.params.name], req, res, next)
    );
    /**
     * @openapi
     * summary: Get JSON schema from subdirectory
     * description: |
     *   Returns a JSON schema from a named sub-directory of `schemas/`.
     *   `:dir` and `:name` follow the rules of the top-level route, and are
     *   validated before the file-system path is resolved, and the
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
     *   '500':
     *     description: A schema it extends is missing or invalid.
     */
    app.get(
      `/${this.config.static_name}/schemas/:dir/:name`,
      (req, res, next) =>
        serve([req.params.dir, req.params.name], req, res, next)
    );
    /**
     * @openapi
     * path: /static/schemas/{dir}/{subdir}/{name}
     * summary: Get JSON schema from a nested subdirectory
     * description: |
     *   Returns a JSON schema from a sub-directory of `schemas/` at any
     *   depth, such as `/static/schemas/twake/nomenclature/twakeTitle.json`,
     *   with the rules of the other schema routes for every segment.
     * parameters:
     *   - { name: dir, in: path, required: true, schema: { type: string } }
     *   - name: subdir
     *     in: path
     *     required: true
     *     description: One or more directories, separated by slashes.
     *     schema: { type: string }
     *   - { name: name, in: path, required: true, schema: { type: string } }
     * responses:
     *   '200':
     *     description: JSON schema file from the sub-directory.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/LdapSchema' }
     *   '400':
     *     description: Invalid directory or schema name.
     *   '404':
     *     description: Schema file not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '500':
     *     description: A schema it extends is missing or invalid.
     */
    app.get(`/${this.config.static_name}/schemas/*path`, (req, res, next) =>
      serve(req.params.path as unknown as string[], req, res, next)
    );
    app.use(`/${this.config.static_name}`, express.static(rep));
  }

  /**
   * The handler of the schema routes
   *
   * @param rep static directory
   * @returns a handler taking the path segments after `schemas/`, decoded
   */
  private schemaServer(
    rep: string
  ): (
    segments: string[],
    req: Request,
    res: Response,
    next: NextFunction
  ) => void {
    const configured = this.configuredSchemas(rep);
    const schemasDir = resolve(join(rep, 'schemas'));
    return (segments, req, res, next) => {
      const file = configured.get(decodedPath(req.path));
      if (file) return this.sendSchema(file, res);
      if (!segments[segments.length - 1].endsWith('.json')) return next();
      // Parts joined by single dots: no segment can be `.` or `..`
      if (!segments.every(segment => /^[\w-]+(\.[\w-]+)*$/.test(segment))) {
        res.status(400).send('Invalid schema name');
        return;
      }
      const schemaPath = resolve(join(schemasDir, ...segments));
      if (!schemaPath.startsWith(schemasDir + '/')) {
        res.status(403).send('Access denied');
        return;
      }
      this.sendSchema(schemaPath, res);
    };
  }

  /**
   * Schema files of the configuration that their URL would not reach under
   * the static directory, by URL
   */
  private configuredSchemas(rep: string): Map<string, string> {
    const byUrl = new Map<string, string>();
    for (const file of configuredSchemaFiles(this.config)) {
      const url = schemaUrl(this.config, file);
      if (!url) continue;
      const underStatic = join(rep, url.substring(url.indexOf('/schemas/')));
      if (resolve(underStatic) === resolve(file)) continue;
      const other = byUrl.get(url);
      if (other && resolve(other) !== resolve(file))
        this.logger.warn(
          `${file} is not served: ${other} already has its URL ${url}`
        );
      else byUrl.set(url, file);
    }
    return byUrl;
  }

  private sendSchema(file: string, res: Response): void {
    loadSchemaFileAsync(file, { config: this.config }).then(
      schema => res.type('json').send(JSON.stringify(schema)),
      (err: Error & { code?: string }) => {
        if (err.code) return notFound(res, 'Schema not found');
        serverError(res, err);
      }
    );
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
