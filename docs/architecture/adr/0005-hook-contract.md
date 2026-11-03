# 0005 — Hook contract

## Context

Plugins have to talk to each other without importing each other. A refusal
has to be able to stop a write; a notification has to be able to run after the
write, without holding the request open or turning a subscriber's failure into
the caller's failure. One kind of hook cannot do both.

## Decision

There are two kinds, told apart by what a subscriber answers, and a third
notification mode:

- **Chained** (`chain(name, value)`). The value goes from one subscriber to
  the next; the last answer is the result. A subscriber that throws stops the
  chain and the error travels to the caller: a refusal is a refusal. Several
  arguments are passed as one tuple.
- **Notified** (`notify(name, ...args)`). Subscribers run one after the other,
  outside the request that caused the write, and are not awaited. A failing
  subscriber is logged with its plugin and hook, counted in the hook failure
  metrics, and the next one still runs.
- **Awaited notification** (`notifyAndWait`). As `notify`, but the caller waits
  for the subscribers. A failure is still logged and swallowed.
- **Strict notification** (`notifyStrict`) for the rare failure that is part
  of the answer. Every subscriber runs; the first failure is raised once they
  all returned.

Every hook is declared in `packages/core/src/hooks.ts` with its arguments and its answer. A
plugin subscribing to an undeclared hook does not compile, and `npm run
check:hooks` keeps the documentation in step. Notified hooks take their
arguments one by one; chained hooks take one value, a tuple when there are
several.

The request hooks of authorization plugins run first, in load order. The
other hooks run in plugin load order.

## Consequences

- A notified hook cannot refuse a write; a plugin that needs to refuse
  subscribes to the request hook instead.
- A chained subscriber must answer the value it was given, changed or not: an
  `undefined` answer becomes the next subscriber's input.
- A subscriber of a notified hook written `([dn, entry], ctx) => …` compiles
  without annotation — its parameter takes the declared type, a `string`, and
  a string can be destructured — and then reads the first character of the
  DN. The documentation repeats the shape of each hook for this reason.
- A "done" hook fires once the operation is over, including a modify that had
  nothing to apply; a write refused by a request hook or by the directory
  never reaches it. The "end" hook fires all the same, once the done
  subscribers returned. Keying state by the operation number is what tells
  two writes of one DN apart.

See [hooks](../../plugin-development/hooks.md) and `packages/core/src/lib/hookBus.ts`.
