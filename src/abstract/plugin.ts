import { DM } from '../bin';
import { Hooks } from '../hooks';

export default abstract class DmPlugin {
  server: DM;

  hooks?: Hooks;

  abstract name: string;

  constructor(server: DM) {
    this.server = server;
  }
}
