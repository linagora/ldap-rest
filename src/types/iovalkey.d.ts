/**
 * Fallback ambient declaration for `iovalkey`.
 *
 * It is an optional dependency (see package.json's `optionalDependencies`) —
 * installed when it can be, never needed at runtime by a deployment that
 * keeps its records elsewhere. It ships its own types, so with the package
 * absent `tsc` fails with "Cannot find module 'iovalkey'", which breaks the
 * build of the whole project over one optional backend. This declares only
 * what this repository uses.
 *
 * An ambient module declaration takes precedence over the resolved package,
 * so `tsc` checks against this file even when `iovalkey` is installed: the
 * package's own types are never consulted. Each signature here must stay
 * one the real client accepts; the valkey store tests, run against a real
 * server in CI, are what catch a drift.
 */
declare module 'iovalkey' {
  export class Valkey {
    constructor(
      url: string,
      options?: {
        lazyConnect?: boolean;
        enableOfflineQueue?: boolean;
        maxRetriesPerRequest?: number;
        commandTimeout?: number;
      }
    );

    connect(): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): void;
    on(event: 'error', listener: (err: unknown) => void): this;
    on(event: 'ready', listener: () => void): this;
    get(key: string): Promise<string | null>;
    set(
      key: string,
      value: string,
      expiryMode: 'PX',
      time: number
    ): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
    exists(...keys: string[]): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    pttl(key: string): Promise<number>;
  }
}
