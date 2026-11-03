/**
 * A core-only embedder gets no shipped schema directory and no server version
 * until it names them: only the umbrella knows where it keeps them once both
 * are installed under `node_modules`.
 *
 * The defaults are checked in a child process, because the test setup imports
 * the umbrella options, which inject both.
 */
import { spawn } from 'child_process';
import path from 'path';

import { readVersion } from '@ldap-rest/core/lib/version';
import { expect } from 'chai';

const child = path.join(__dirname, 'fixtures', 'coreOnlyChild.ts');

const runChild = (): Promise<{
  shippedSchemasPath: string;
  schemaError: string;
}> =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    proc.on('error', reject);
    proc.on('exit', code => {
      if (code !== 0)
        reject(new Error(`core-only child exited with ${String(code)}`));
      else
        resolve(
          JSON.parse(output) as {
            shippedSchemasPath: string;
            schemaError: string;
          }
        );
    });
  });

describe('core-only defaults', () => {
  it('has no shipped schema directory until the host names one', async () => {
    const result = await runChild();
    expect(result.shippedSchemasPath).to.equal('');
    expect(result.schemaError).to.match(/no schema directory is configured/);
  });

  it('leaves the version unknown when no ldap-rest package is above', () => {
    // Deep enough that the walk stops before the repository's own package.json
    const start = path.join(__dirname, 'fixtures', 'coreOnly', 'a', 'b', 'c');
    expect(readVersion(start)).to.equal(undefined);
  });
});
