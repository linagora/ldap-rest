import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A LemonLDAP::NG configuration on disk the real `lemonldap-ng-handler` can
 * start from: a File configuration and File sessions, one virtual host.
 */

export const llngVhost = 'api.example.com';
export const llngCookie = 'lemonldap';

export interface LlngHandler {
  grant(
    req: { headers: Record<string, string> },
    uri: string,
    session: Record<string, unknown>
  ): Promise<boolean>;
}

export interface LlngModule {
  init(args: { configStorage: { confFile: string } }): Promise<LlngHandler>;
  shutdown(): Promise<void>;
}

export interface LlngFixture {
  /** The lemonldap-ng.ini to start the handler from */
  ini: string;
  /** Store a session and return the cookie that presents it */
  session(id: string, attributes: Record<string, unknown>): string;
  remove(): void;
}

/**
 * The handler module, or undefined where the optional dependency is not
 * installed: it is absent on runtimes its native re2 does not build for.
 */
export async function loadLlng(): Promise<LlngModule | undefined> {
  try {
    return (await import('lemonldap-ng-handler')) as unknown as LlngModule;
  } catch (err) {
    if (/Cannot find (package|module) 'lemonldap-ng-handler'/.test(String(err)))
      return undefined;
    throw err;
  }
}

export function llngFixture(
  locationRules: Record<string, string>
): LlngFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-llng-'));
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(
    path.join(dir, 'lmConf-1.json'),
    JSON.stringify({
      cfgNum: 1,
      cookieName: llngCookie,
      domain: 'example.com',
      portal: 'https://auth.example.com/',
      globalStorage: 'Apache::Session::File',
      globalStorageOptions: { Directory: sessions },
      whatToTrace: 'uid',
      locationRules: { [llngVhost]: locationRules },
      exportedHeaders: { [llngVhost]: {} },
    })
  );
  const ini = path.join(dir, 'lemonldap-ng.ini');
  fs.writeFileSync(
    ini,
    `[configuration]\ntype = File\ndirName = ${dir}\n\n` +
      `[node-handler]\nnodeVhosts = ${llngVhost}\n`
  );
  return {
    ini,
    session: (id, attributes): string => {
      fs.writeFileSync(
        path.join(sessions, id),
        JSON.stringify({
          _session_id: id,
          _utime: Math.floor(Date.now() / 1000),
          ...attributes,
        })
      );
      return `${llngCookie}=${id}`;
    },
    remove: (): void => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
