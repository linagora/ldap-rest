import fs from 'fs';

import type { Express } from 'express';
import express from 'express';

import DmPlugin from '../abstract/plugin';

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
      throw new Error(`Bad directory ${rep}: ${e}`);
    }
    app.use(`/${this.config.static_name}`, express.static(rep));
  }
}
