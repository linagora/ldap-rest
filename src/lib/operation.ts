/**
 * The write a hook is called for
 * @module lib/operation
 */
import { AsyncLocalStorage } from 'async_hooks';

/**
 * The number of the modify, delete or rename under way. Its request and
 * "done" hooks run inside it, so a plugin keeping something from one to the
 * other can key it by operation: a `ldapdeleterequest` hook has no other way
 * to tell two deletes of one DN apart.
 */
const operations = new AsyncLocalStorage<number>();

/**
 * Run a write as operation `op`.
 *
 * @param op the operation number
 * @param write the write, its request and "done" hooks included
 * @returns what the write returns
 */
export function runOperation<T>(
  op: number,
  write: () => Promise<T>
): Promise<T> {
  return operations.run(op, write);
}

/**
 * Run something outside any operation, such as a move a request hook makes:
 * its hooks belong to no request.
 *
 * @param fn what to run
 * @returns what it returns
 */
export function outsideOperation<T>(fn: () => T): T {
  return operations.exit(fn);
}

/**
 * The operation a hook is called for.
 *
 * Inside the request and "done" hooks of a modify, delete or rename, it is
 * that write. Elsewhere it is whatever encloses the call: an add or a search
 * made from a delete's request hook (the trash, a tombstone) sees the
 * delete's number, and the "end" hooks run in their caller's context, so an
 * end subscriber must use the number it is given, not this.
 *
 * @returns the number of the modify, delete or rename the call runs inside,
 * or undefined outside any
 */
export function currentOperation(): number | undefined {
  return operations.getStore();
}
