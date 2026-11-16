export type FetchRequest = globalThis.Request;

/** The path and query of a request nock hands to a reply function or a listener. */
export const pathOf = (request: FetchRequest): string => {
  const { pathname, search } = new URL(request.url);
  return pathname + search;
};

/** The body of such a request, parsed when it is JSON. */
export const bodyOf = async (request: FetchRequest): Promise<unknown> => {
  const text = await request.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/**
 * A reply function giving `[status, body?]` after `ms`, headers included:
 * nock's delay() only holds the end of the body back.
 */
export const answerAfter =
  (ms: number, ...result: unknown[]) =>
  (): Promise<unknown[]> =>
    new Promise(resolve => setTimeout(() => resolve(result), ms));
