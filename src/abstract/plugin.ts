import { Config, DM } from '../bin';
import { Hooks } from '../hooks';

export default abstract class DmPlugin {
  server: DM;
  config: Config;

  hooks?: Hooks;

  abstract name: string;

  constructor(server: DM) {
    this.server = server;
    this.config = server.config;
  }
}
