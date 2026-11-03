/**
 * A server with every option declared, as the monolith always provided.
 *
 * The umbrella's default template carries the core options only: the command
 * line composes the plugins it names. A test constructs its server directly,
 * so it takes the complete set instead of naming every plugin in `argv`.
 */
import { DM as UmbrellaDM } from '../../src/bin';
import configArgs from '../../src/options.full';

export class DM extends UmbrellaDM {
  constructor() {
    super(configArgs);
  }
}
