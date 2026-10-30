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
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { validateHeaderValue } from 'http';

import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import type { DM } from '../bin';
import { STATIC_CSP, STATIC_FRAME_OPTIONS } from '../config/args';
import { notFound, serverError } from '../lib/expressFormatedResponses';
import {
  configuredSchemaFiles,
  loadSchemaFileAsync,
  schemaUrl,
  staticName,
} from '../lib/schemaFile';

import { staticOptions, type StaticOptions } from './static.options';

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
  static optionDefinitions = staticOptions;

  name: string = 'static';
  roles: Role[] = ['api', 'configurable'] as const;
  /** The configuration's schema files it serves outside its directory, by URL */
  private configured = new Map<string, string>();
  private readonly settings: StaticOptions;

  constructor(server: DM) {
    super(server);
    this.settings = this.options(staticOptions);
  }

  api(app: Express): void {
    const rep = this.settings.static_path;
    try {
      const stat = fs.statSync(rep);
      if (!stat.isDirectory()) throw new Error(`${rep} isn't a directory`);
      fs.accessSync(rep, fs.constants.R_OK);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Bad directory ${rep}: ${e}`);
    }
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
      this.settings.static_csp,
      STATIC_CSP
    );
    const frameOptions = headerValue(
      '--static-frame-options',
      'X-Frame-Options',
      this.settings.static_frame_options,
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
    const configured = (this.configured = this.configuredSchemas(rep));
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
   * The URL it serves a file at, for another plugin to announce it: under
   * its own name, which a plugin override may have changed, from its
   * directory or among the configuration's schema files it serves. One its
   * routes would not answer with that file is none: a hidden one, which
   * express.static ignores, a schema whose path the schema route refuses,
   * or one whose URL a configured schema holds.
   *
   * @param file the file, as the other plugin reads it
   * @returns its URL, or undefined when this plugin does not serve it
   */
  urlOf(file: string): string | undefined {
    const wanted = resolve(file);
    let real: string;
    try {
      if (!fs.statSync(wanted).isFile()) return undefined;
      real = fs.realpathSync(wanted);
    } catch {
      return undefined;
    }
    const same = (other: string): boolean => {
      if (resolve(other) === wanted) return true;
      try {
        return fs.realpathSync(other) === real;
      } catch {
        return false;
      }
    };
    const prefix = this.servedPath();
    const url = (segments: string[]): string =>
      `${prefix}/${segments.map(encodeURIComponent).join('/')}`;
    for (const [served, path] of this.configured)
      if (same(path)) {
        // A client drops `.` and `..` from a URL, and misses the one it
        // holds: the file may still be served from the directory.
        const segments = served.slice(prefix.length + 1).split('/');
        if (segments.some(segment => ['', '.', '..'].includes(segment)))
          continue;
        return url(segments);
      }
    const rep = this.settings.static_path;
    if (!rep) return undefined;
    // From the resolved paths, then the real ones for a directory reached
    // through a link: no `..` is left to take the URL out of its prefix,
    // and a directory of `/` holds every file.
    const inside = (path: string): boolean =>
      !!path &&
      path !== '..' &&
      !path.startsWith(`..${sep}`) &&
      !isAbsolute(path);
    let root: string;
    try {
      root = fs.realpathSync(rep);
    } catch {
      return undefined;
    }
    const path = [relative(resolve(rep), wanted), relative(root, real)].find(
      inside
    );
    if (!path) return undefined;
    const segments = path.split(sep);
    if (segments.some(segment => segment.startsWith('.'))) return undefined;
    // Matched regardless of case, the schema route reads `schemas/` itself
    if (
      segments[0].toLowerCase() === 'schemas' &&
      segments[0] !== 'schemas' &&
      path.endsWith('.json')
    )
      return undefined;
    if (
      segments[0] === 'schemas' &&
      path.endsWith('.json') &&
      !segments.slice(1).every(segment => /^[\w-]+(\.[\w-]+)*$/.test(segment))
    )
      return undefined;
    if (this.configured.has(`${prefix}/${segments.join('/')}`))
      return undefined;
    return url(segments);
  }

  /**
   * The URL its schema routes serve a schema file at, merged with what it
   * extends and its placeholders replaced, for another plugin to announce
   * it: one of the configuration's schema files it serves, or a file its
   * `schemas/` directory reaches, through a link included. One that
   * express.static would send as it stands, outside `schemas/` or not named
   * `.json`, has none.
   *
   * @param file the schema file, as the other plugin reads it
   * @returns its URL, or undefined when its schema routes do not serve it
   */
  schemaUrlOf(file: string): string | undefined {
    const realOf = (path: string): string | undefined => {
      try {
        return fs.statSync(path).isFile() ? fs.realpathSync(path) : undefined;
      } catch {
        return undefined;
      }
    };
    const real = realOf(file);
    if (!real) return undefined;
    const prefix = this.servedPath();
    const url = (segments: string[]): string =>
      `${prefix}/${segments.map(encodeURIComponent).join('/')}`;
    for (const [served, path] of this.configured)
      if (realOf(path) === real) {
        // A client drops `.` and `..` from a URL, and misses the one it
        // holds: the file may still be served from the directory.
        const segments = served.slice(prefix.length + 1).split('/');
        if (segments.some(segment => ['', '.', '..'].includes(segment)))
          continue;
        return url(segments);
      }
    const rep = this.settings.static_path;
    if (!rep) return undefined;
    const schemasDir = join(rep, 'schemas');
    // What follows a `schemas` directory of its path, as given or real, or
    // the real `schemas/` directory: either may be a link.
    const tails: string[][] = [];
    for (const path of [resolve(file), real]) {
      const parts = path.split(sep);
      parts.forEach((part, index) => {
        if (part === 'schemas') tails.push(parts.slice(index + 1));
      });
    }
    try {
      const inside = relative(fs.realpathSync(schemasDir), real);
      if (
        inside &&
        inside !== '..' &&
        !inside.startsWith(`..${sep}`) &&
        !isAbsolute(inside)
      )
        tails.push(inside.split(sep));
    } catch {
      // no schemas/ directory
    }
    for (const tail of tails) {
      // The names the schema route reads; another is sent as it stands
      if (
        !tail.length ||
        !tail[tail.length - 1].endsWith('.json') ||
        !tail.every(segment => /^[\w-]+(\.[\w-]+)*$/.test(segment))
      )
        continue;
      const segments = ['schemas', ...tail];
      // A configured file of that URL is served there instead
      if (this.configured.has(`${prefix}/${segments.join('/')}`)) continue;
      if (realOf(join(schemasDir, ...tail)) === real) return url(segments);
    }
    return undefined;
  }

  /** The path it serves under, which an earlier plugin may have taken */
  servedPath(): string {
    return `/${staticName(this.config)}`;
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const staticPath = this.servedPath();

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
