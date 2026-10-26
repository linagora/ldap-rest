/**
 * A SIGTERM listener replaces Node's default action, which is to exit. The
 * one the shutdown installs must end the process once the callbacks are
 * done, whatever they do. Checked on a real child process, as
 * `process.emit` applies no default action.
 */
import { expect } from 'chai';
import { spawn } from 'child_process';
import path from 'path';

const child = path.join(__dirname, '..', 'fixtures', 'shutdownChild.ts');

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
  ms: number;
}

const run = (mode: string, signal: 'SIGTERM' | 'SIGINT'): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines: string[] = [];
    let sent: number | undefined;
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(line);
        if (line === 'ready') {
          sent = Date.now();
          proc.kill(signal);
        }
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code, exitSignal) =>
      resolve({
        code,
        signal: exitSignal,
        lines,
        ms: sent === undefined ? -1 : Date.now() - sent,
      })
    );
  });

describe('Process shutdown', function () {
  this.timeout(30000);

  it('closes, then ends the process by the signal it got', async () => {
    const out = await run('closes', 'SIGTERM');
    expect(out.lines).to.deep.equal(['ready', 'closing', 'closed']);
    expect(out.signal).to.equal('SIGTERM');
  });

  it('does the same on SIGINT', async () => {
    const out = await run('closes', 'SIGINT');
    expect(out.lines).to.include('closed');
    expect(out.signal).to.equal('SIGINT');
  });

  it('ends the process when a callback throws', async () => {
    const out = await run('throws', 'SIGTERM');
    expect(out.lines).to.deep.equal(['ready', 'closing']);
    expect(out.signal).to.equal('SIGTERM');
  });

  it('ends the process after the timeout when a callback hangs', async () => {
    const out = await run('hangs', 'SIGTERM');
    expect(out.lines).to.deep.equal(['ready', 'closing']);
    expect(out.signal).to.equal('SIGTERM');
    expect(out.ms).to.be.within(250, 5000);
  });

  it('runs a callback registered during the shutdown', async () => {
    const out = await run('late', 'SIGTERM');
    expect(out.lines).to.deep.equal(['ready', 'closing', 'closed', 'late']);
    expect(out.signal).to.equal('SIGTERM');
  });

  it('leaves the decision to another listener of the signal', async () => {
    const out = await run('host', 'SIGTERM');
    expect(out.lines).to.deep.equal(['ready', 'closing', 'closed']);
    expect(out.signal).to.equal(null);
    expect(out.code).to.equal(7);
  });
});
