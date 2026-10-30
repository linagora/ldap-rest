/**
 * The hooks of the server, typed by `Hooks`, with one calling convention per
 * kind.
 *
 * The three kinds are told apart by what their subscriber answers:
 * chained hooks get a value and pass it — possibly changed — along the
 * chain; notified hooks answer nothing, are not waited for, and their
 * failures are logged; several hooks answer a value each.
 *
 * @see docs/plugin-development/hooks.md
 */
import type { Hooks } from '../hooks';

import { getLogger } from './expressFormatedResponses';
import { hookFailures } from './metrics';
import { outsideRequest, runAsPlugin } from './requestContext';

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type HookFn = Function;

/** A promise, or the value itself */
type Settled<T> = T extends Promise<infer P> ? P : T;

/** Whether `F` answers nothing: `void`, or a promise of it */
export type AnswersVoid<F> = [
  Settled<F extends (...args: never[]) => infer R ? R : never>,
] extends [void | undefined]
  ? true
  : false;

/** The values of `Hooks` a chain threads: the ones whose answer is a value */
export type ChainedName = {
  [K in keyof Hooks]-?: AnswersVoid<NonNullable<Hooks[K]>> extends true
    ? never
    : K;
}[keyof Hooks];

/** The `Hooks` a notification fires: the ones whose subscriber answers nothing */
export type NotifiedName = Exclude<keyof Hooks, ChainedName>;

/** A chained hook is declared with the value it threads */
export type ChainedNameOf<K extends keyof Hooks> = K extends ChainedName
  ? K
  : never;

/** The arguments a hook expects */
export type Args<K extends keyof Hooks> =
  NonNullable<Hooks[K]> extends (...args: infer A) => unknown ? A : never;

/** What a chained hook threads */
export type ChainedValue<K extends keyof Hooks> =
  NonNullable<Hooks[K]> extends (arg: infer A) => unknown ? A : never;

const describeThrown = (e: unknown): string => {
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
};

/**
 * Which plugin registered a hook function, and under which hook name.
 *
 * Beside the hook arrays rather than inside them: those are plain lists of
 * functions shared with whatever walks them, and a registry keyed on the
 * function leaves them as they are.
 */
const hookOwners = new WeakMap<HookFn, { plugin: string; hook: string }>();

/**
 * Record the plugin a hook function belongs to.
 *
 * @param fn the registered function
 * @param plugin the plugin's instance name
 * @param hook the hook it is registered under
 */
export const recordHookOwner = (
  fn: HookFn,
  plugin: string,
  hook: string
): void => {
  hookOwners.set(fn, { plugin, hook });
};

/**
 * The plugin a hook function belongs to, and the hook it is registered
 * under, when `registerPlugin` registered it.
 *
 * @param fn a hook function
 * @returns its plugin's instance name and hook name, or undefined
 */
export const hookOwner = (
  fn: HookFn
): { plugin: string; hook: string } | undefined => hookOwners.get(fn);

/**
 * Where a failing hook comes from, for the report.
 *
 * @param hook the hook function
 * @returns ` in <plugin> (<hook>)` when `registerPlugin` recorded it, the
 *          function's own name otherwise, or nothing for an anonymous one
 */
const hookLabel = (hook: HookFn): string => {
  const owner = hookOwner(hook);
  if (owner) return ` in ${owner.plugin} (${owner.hook})`;
  return hook.name ? ` in ${hook.name}` : '';
};

/**
 * Run a hook under its plugin's name and its own, for the lines it logs.
 *
 * @param hook the registered function
 * @param fn its run
 * @returns what `fn` returns
 */
export const runAsHookOwner = <T>(hook: HookFn, fn: () => T): T => {
  const owner = hookOwner(hook);
  return runAsPlugin(owner?.plugin, owner?.hook, fn);
};

/**
 * Whether a hook's failure is an authorization plugin's refusal, by the
 * marker its message carries: a plain `Error` wrapping it keeps the message
 * only. Its message names the branch, so the client is told `AUTHZ_REFUSED`
 * instead.
 */
export const isAuthzRefusal = (err: unknown): boolean =>
  /\[authz-forbidden\]/.test(String((err as Error)?.message ?? ''));

/**
 * Whether an error is a refusal: an authorization plugin's, or any 403.
 */
const isRefusal = (err: unknown): boolean =>
  (err as { statusCode?: number })?.statusCode === 403 || isAuthzRefusal(err);

/** Report a failing notified hook, and swallow it: its write happened */
const report = (hook: HookFn, e: unknown): void => {
  // The logger is looked up when the hook fails, not when this module was
  // evaluated: `setLogger` runs in the `DM` constructor, and this module is
  // loaded before it through `ldapActions`, so a captured logger is
  // `undefined` here and the report would throw `Cannot read properties of
  // undefined` instead of naming the hook's error.
  //
  // The Error goes as the second argument, which is where winston keeps its
  // stack; a thrown value of any other kind is dropped there — measured with
  // the repository's own logger, `throw 'x'` printed
  // `{"level":"error","message":"Hook error"}` and nothing else — so it goes
  // into the message instead.
  const where = hookLabel(hook);
  const owner = hookOwner(hook);
  hookFailures.inc({
    hook: owner?.hook ?? (hook.name || 'anonymous'),
    plugin: owner?.plugin ?? 'none',
  });
  if (e instanceof Error) {
    getLogger()?.error(`Hook error${where}`, e);
  } else {
    getLogger()?.error(`Hook error${where}: ${describeThrown(e)}`);
  }
};

/**
 * A point in time where no notification started so far is still running.
 * Mutable, and shared by reference with `withConfig` views.
 */
interface Tracked {
  pending: Set<Promise<void>>;
}

/**
 * A hook's list, as `server.hooks` spells it: `undefined` when nothing is
 * subscribed, a function for one subscriber, a list for several, and
 * anything else when a test writes a list through the hook and walks it.
 */
export type HookValue<K extends keyof Hooks = keyof Hooks> =
  | Hooks[K]
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function[]
  | undefined;

/** The functions a subscriber value holds, one or many */
export const asHooks = <K extends keyof Hooks>(
  value: HookValue<K>
): HookFn[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * How a flat entity raises its own hooks, see `abstract/ldapFlat.ts`: the
 * prefix it names them under, added to the suffix of each. They are not
 * `Hooks`' own, see {@link FlatHookPrefix}.
 */
export interface FlatHookBus {
  /** Thread a value through `{prefix}{suffix}`, as {@link HookBus.chain} */
  chain<T>(suffix: string, value: T): Promise<T>;
  /** Notify `{prefix}{suffix}`, as {@link HookBus.notify} */
  notify(suffix: string, ...args: unknown[]): void;
}

export default class HookBus implements FlatHookBus {
  /**
   * What `server.hooks` holds, shared by reference. A plugin reaching it
   * directly is not told by its type whether the hook exists, nor how it
   * is called; this bus is.
   */
  private readonly hooks: { [K in keyof Hooks]?: HookValue<K> };

  private readonly tracked: Tracked = { pending: new Set() };

  /**
   * @param hooks the server's hook lists, shared by reference
   */
  constructor(hooks: { [K in keyof Hooks]?: HookValue<K> }) {
    this.hooks = hooks;
  }

  /** Whether anything is subscribed to a hook */
  has(name: keyof Hooks): boolean {
    return asHooks(this.hooks[name]).length > 0;
  }

  /**
   * The subscribers of a hook, in the order they run.
   *
   * @param name the hook
   * @returns its subscribers, empty when nothing subscribed
   */
  subscribers(name: keyof Hooks): readonly HookFn[] {
    return [...asHooks(this.hooks[name])];
  }

  /**
   * Subscribe a function to a hook, or forget its subscribers when given
   * none, as a plugin declaring `hooks` would.
   *
   * @param name the hook
   * @param fn what to run, none to unsubscribe every subscriber
   */
  set<K extends keyof Hooks>(name: K, ...fn: NonNullable<Hooks[K]>[]): void {
    this.store(name, fn as unknown as HookFn[]);
  }

  /**
   * Add a subscriber to a hook, after the ones already there.
   *
   * @param name the hook
   * @param fn what to run
   */
  subscribe<K extends keyof Hooks>(name: K, fn: NonNullable<Hooks[K]>): void {
    this.store(name, [...asHooks(this.hooks[name]), fn as unknown as HookFn]);
  }

  /**
   * Put a subscriber at a given place in a hook's list, as
   * `registerPlugin` does for an authorization hook.
   *
   * @param name the hook
   * @param fn what to run
   * @param at its place, the end when past it
   */
  insert<K extends keyof Hooks>(
    name: K,
    fn: NonNullable<Hooks[K]>,
    at: number
  ): void {
    const list = asHooks(this.hooks[name]);
    list.splice(at, 0, fn as unknown as HookFn);
    this.store(name, list);
  }

  /**
   * Remove a subscriber from a hook, wherever it sits.
   *
   * @param name the hook
   * @param fn the subscriber
   */
  unsubscribe<K extends keyof Hooks>(name: K, fn: NonNullable<Hooks[K]>): void {
    const own = fn as unknown as HookFn;
    this.store(
      name,
      asHooks(this.hooks[name]).filter(hook => hook !== own)
    );
  }

  /**
   * Move a subscriber to the end of its hook's list, keeping it registered,
   * for a plugin that must run after every other one.
   *
   * @param name the hook
   * @param hook the subscriber
   * @returns whether it was subscribed to the hook
   */
  toLast(name: keyof Hooks, hook: HookFn): boolean {
    const list = asHooks(this.hooks[name]);
    const at = list.indexOf(hook);
    if (at < 0) return false;
    this.store(name, [...list.slice(0, at), ...list.slice(at + 1), hook]);
    return true;
  }

  /**
   * Thread a value through every subscriber of a chained hook, each getting
   * what the one before answered. The first failure stops the chain and
   * travels up: a refusal is a refusal, and the caller must not go on as if
   * the chain had said yes.
   *
   * Hooks run outside the request being served: what a hook reads or writes
   * to validate, complete or keep track of an operation is the server's
   * (#385). The request is in the arguments of the hooks that judge, which
   * judge by it; a hook acting as the caller names it.
   *
   * @param name the hook
   * @param value the value to thread
   * @returns the last value in the chain
   */
  async chain<K extends keyof Hooks>(
    name: ChainedNameOf<K>,
    value: ChainedValue<K>
  ): Promise<ChainedValue<K>> {
    let args = value;
    for (const hook of asHooks(this.hooks[name])) {
      if (!hook) continue;
      args = await runAsHookOwner(hook, async () => {
        try {
          return await outsideRequest(() =>
            (hook as (a: typeof args) => typeof args | Promise<typeof args>)(
              args
            )
          );
        } catch (err) {
          // A hook pushed onto the list directly, as a test does, has no
          // owner on record. Its refusal is still said, with what can be said
          // of it.
          if (isRefusal(err)) {
            const owner = hookOwner(hook);
            getLogger()?.warn(
              `${
                owner
                  ? `${owner.plugin} refused ${owner.hook}`
                  : `a hook no plugin registered (${hook.name || 'anonymous'}) refused`
              }: ${(err as Error).message}`
            );
          }
          throw err;
        }
      });
    }
    return args;
  }

  /**
   * Notify every subscriber of a hook, one after the other, outside the
   * request that caused it: they are told what happened, and was judged, and
   * react as the server — synchronizing, publishing, keeping invariants —
   * whoever asked.
   *
   * Not awaited, and not failed: the write the subscribers react to is done,
   * and a subscriber's failure is logged and goes no further. `settled`
   * waits for them.
   *
   * @param name the hook
   * @param args what its subscribers are told
   */
  notify<K extends NotifiedName>(name: K, ...args: Args<K>): void {
    void this.fire(name, args);
  }

  /**
   * Run every subscriber of a hook and let their failures go to the caller,
   * for the rare hook whose subscribers are part of the answer: a logout
   * token reaches the provider only once what it closes is recorded, so the
   * failure has to reach the library, which answers 400 and lets the
   * provider retry.
   *
   * Every subscriber runs even when one fails, one after the other as
   * `notify` runs them, and the first failure is raised once they all have:
   * stopping at the first would cost the others their turn — a session the
   * provider considers closed would keep working against the store that
   * would have killed it.
   *
   * @param name the hook
   * @param args what its subscribers are told
   */
  async notifyStrict<K extends NotifiedName>(
    name: K,
    ...args: Args<K>
  ): Promise<void> {
    let failure: unknown;
    for (const hook of this.subscribers(name)) {
      await runAsHookOwner(hook, async () => {
        try {
          await outsideRequest(() =>
            (hook as (...a: Args<K>) => unknown)(...args)
          );
        } catch (err: unknown) {
          failure ??= err;
        }
      });
    }
    // Rethrown as it came: a subscriber may throw anything, and the caller
    // is the library that answered the provider
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (failure !== undefined) throw failure;
  }

  /**
   * Notify, then wait for the subscribers: a caller that has to know the
   * consequences have run, a test instead of a sleep.
   *
   * @param name the hook
   * @param args what its subscribers are told
   * @returns once they have returned
   */
  async notifyAndWait<K extends NotifiedName>(
    name: K,
    ...args: Args<K>
  ): Promise<void> {
    await this.fire(name, args);
  }

  /**
   * Run every hook the server holds and answer what each gives, in order.
   * For the hooks nothing decided the answer of: `hello` is a demo of one.
   *
   * @param name the hook
   * @param args what its subscribers are given
   * @returns one answer per subscriber
   */
  async call<K extends keyof Hooks>(
    name: K,
    ...args: Args<K>
  ): Promise<unknown[]> {
    const answers: unknown[] = [];
    for (const hook of asHooks(this.hooks[name])) {
      if (!hook) continue;
      answers.push(
        await runAsHookOwner(hook, () =>
          outsideRequest(() => (hook as (...a: Args<K>) => unknown)(...args))
        )
      );
    }
    return answers;
  }

  /**
   * A view raising `{prefix}{suffix}` hooks, for an entity whose hooks are
   * named dynamically.
   *
   * @param prefix the entity's prefix
   * @returns the bus, raising its hooks
   */
  prefixed(prefix: string): FlatHookBus {
    return {
      chain: async <T>(suffix: string, value: T): Promise<T> =>
        this.chain(
          `${prefix}${suffix}` as ChainedName,
          value as never
        ) as Promise<T>,
      notify: (suffix: string, ...args: unknown[]) =>
        // Typed by `FlatHookPrefix`, which `Hooks` does not index by
        (this.notify as (n: string, ...a: unknown[]) => void)(
          `${prefix}${suffix}`,
          ...args
        ),
    };
  }

  /**
   * Resolves when every notification started so far has run, the ones
   * started while waiting included.
   */
  async settled(): Promise<void> {
    while (this.tracked.pending.size > 0) {
      await Promise.all([...this.tracked.pending]);
    }
  }

  /**
   * Write a hook's subscribers the way `server.hooks` spells them: no entry
   * when nothing is subscribed, the function itself for one subscriber.
   */
  private store(name: keyof Hooks, list: HookFn[]): void {
    const storage = this.hooks as Record<string, unknown>;
    if (list.length === 0) delete storage[name];
    else storage[name] = list.length === 1 ? list[0] : list;
  }

  private fire<K extends keyof Hooks>(name: K, args: Args<K>): Promise<void> {
    const running = (async () => {
      for (const hook of asHooks(this.hooks[name])) {
        if (!hook) continue;
        await runAsHookOwner(hook, async () => {
          try {
            await outsideRequest(() =>
              (hook as (...a: Args<K>) => unknown)(...args)
            );
          } catch (e: unknown) {
            report(hook, e);
          }
        });
      }
    })();
    const { pending } = this.tracked;
    pending.add(running);
    void running.finally(() => pending.delete(running));
    return running;
  }
}
