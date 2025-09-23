import fs from 'fs';
import { join } from 'path';

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
      fs.readFile(join(rep, 'schemas', req.params.name), (err, data) => {
        if (err) {
          return notFound(res, 'Schema not found');
        }
        const str = transformSchemas(data, this.config);
        return res.type('json').send(str);
      });
    });
    app.use(`/${this.config.static_name}`, express.static(rep));
  }
}
