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

import DmPlugin from '../abstract/plugin';
import { notFound } from '../lib/expressFormatedResponses';
import { transformSchemas } from '../lib/utils';

export default class Static extends DmPlugin {
  name: string = 'static';

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
}
