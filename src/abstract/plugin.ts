import { Config, DM } from '../bin';
import { Hooks } from '../hooks';

export default abstract class DmPlugin {
  server: DM;
  config: Config;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  registeredHooks: { [K in keyof Hooks]?: Function[] } = {};

  hooks?: Hooks;

  abstract name: string;

  constructor(server: DM) {
    this.server = server;
    this.config = server.config;
    this.registeredHooks = server.hooks;
  }
}
