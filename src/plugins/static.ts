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
 *
 * Its responses carry `--static-csp` (by default `frame-ancestors 'self'`)
 * and `--static-frame-options` (`SAMEORIGIN`), so that no other origin
 * frames the applications it serves; `off` sends none. A redirect or a 404
 * Express answers itself has its own `Content-Security-Policy:
 * default-src 'none'` instead, and keeps `X-Frame-Options` when it is sent.
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import fs from 'fs';
import { join, resolve } from 'path';
import { validateHeaderValue } from 'http';

import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { STATIC_CSP, STATIC_FRAME_OPTIONS } from '../config/args';
import { notFound, serverError } from '../lib/expressFormatedResponses';
import {
  configuredSchemaFiles,
  loadSchemaFileAsync,
  schemaUrl,
  staticName,
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
 * A header's value from its option: `off` (or `false`, in a plugin's JSON
 * override) sends none, and an empty one is the default, as a compose file
 * expands an unset `${VAR:-}` to one, which would otherwise drop the
 * protection unseen. A policy written on several lines is joined into one,
 * and one a header cannot hold is refused at startup: refused at each
 * request, it made every file a 500 of a server that looked healthy.
 *
 * @param option the option, as its error names it
 * @param header the header it sets
 * @param value what the configuration holds
 * @param fallback the default
 * @returns the value to send, or undefined for none
 */
const headerValue = (
  option: string,
  header: string,
  value: unknown,
  fallback: string
): string | undefined => {
  if (value === false) return undefined;
  if (value !== undefined && value !== null && typeof value !== 'string')
    throw new Error(`${option}: a text is expected, or false for none`);
  const given = (typeof value === 'string' ? value : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!given) return fallback;
  if (given.toLowerCase() === 'off') return undefined;
  try {
    validateHeaderValue(header, given);
  } catch {
    throw new Error(`${option}: "${given}" cannot be sent as ${header}`);
  }
  return given;
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
    const given: unknown = this.config.static_name;
    if (given !== undefined && given !== null && typeof given !== 'string')
      throw new Error('--static-name: a text is expected, such as static');
    const name = staticName(this.config);
    // Each segment a path that Express matches as written: no `.` or `..`,
    // none empty, none holding its route syntax (`:`, `*`, braces…) or what
    // a URL would have to encode, a letter outside ASCII included: sent
    // encoded, it never matched.
    if (
      name
        .split('/')
        .some(
          segment =>
            !segment ||
            /^\.+$/.test(segment) ||
            /[^\x21-\x7e]|[:*?+!()[\]{}\\#%"<>|^`]/.test(segment)
        )
    )
      throw new Error(
        `--static-name: "${name}" is not a path to serve under, such as static`
      );
    const prefix = `/${name}`;
    const serve = this.schemaServer(rep);
    // The pages served here are applications, an administration console
    // among them: no other origin, another sub-domain or port included, may
    // frame one signed in.
    const csp = headerValue(
      '--static-csp',
      'Content-Security-Policy',
      this.config.static_csp,
      STATIC_CSP
    );
    const frameOptions = headerValue(
      '--static-frame-options',
      'X-Frame-Options',
      this.config.static_frame_options,
      STATIC_FRAME_OPTIONS
    );
    app.use(prefix, (_req, res, next) => {
      if (csp) res.setHeader('Content-Security-Policy', csp);
      if (frameOptions) res.setHeader('X-Frame-Options', frameOptions);
      next();
    });
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
    app.get(`${prefix}/schemas/:name`, (req, res, next) =>
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
    app.get(`${prefix}/schemas/:dir/:name`, (req, res, next) =>
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
    app.get(`${prefix}/schemas/*path`, (req, res, next) =>
      serve(req.params.path as unknown as string[], req, res, next)
    );
    app.use(prefix, express.static(rep));
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
    const staticPath = `/${staticName(this.config)}`;

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
