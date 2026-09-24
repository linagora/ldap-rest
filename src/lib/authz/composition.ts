/**
 * @module lib/authz/composition
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * How authorization plugins loaded together compose, and the configurations
 * where that composition is nobody's decision.
 *
 * Every plugin judging LDAP operations registers the same hooks, and
 * `launchHooksChained` runs them all: two of them compose as an AND, the
 * first refusal winning. That is a sound rule when it is meant. It is a
 * refusal nobody can explain when it is not — `authzPerBranch` beside
 * `authzDynamic` judges a machine token by a branch configuration written
 * for administrators, finds no key for the tenant, and refuses a write the
 * token's own ACLs grant. So a plugin says whose requests it judges
 * (`--authz-for`), and the server refuses to start when two of them judge
 * the same ones without `--authz-combine`.
 * @group Libraries
 */
import type DmPlugin from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Config } from '../../config/args';
import type { DmRequest } from '../auth/base';

/**
 * The hooks an LDAP operation is judged in: refused from, or — for
 * `ldapsearchfilter` — narrowed to what the caller may see. Two plugins on
 * the last one compose as an intersection, which is the same AND.
 */
export const LDAP_JUDGING_HOOKS = [
  'ldapsearchrequest',
  'ldapaddrequest',
  'ldapmodifyrequest',
  'ldapdeleterequest',
  'ldaprenamerequest',
  'ldapsearchfilter',
] as const;

/** Every authenticated request, whatever authenticated it. */
export const EVERYONE = 'everyone';

/** The requests a plugin judges: named authenticators', or everyone's. */
export type Population = string[] | typeof EVERYONE;

/** An authentication plugin, as far as composition is concerned. */
interface Authenticator {
  name: string;
  pathPrefixes: string[];
}

/**
 * `authz_for` as parsed, per configuration object.
 *
 * `servesRequest` reads it on every LDAP hook of every judge; parsing once
 * also means the only call that can throw is the plugin's constructor,
 * which names the plugin — not a request, naming the option.
 */
const parsedAuthzFor = new WeakMap<object, string[] | undefined>();

/**
 * The authentication plugins an authorization plugin judges the requests of.
 *
 * @param config the plugin's configuration
 * @param who the plugin, for the message
 * @returns their instance names, or undefined for every one of them
 * @throws Error when the option is not a list of names
 */
export function authzFor(config: Config, who: string): string[] | undefined {
  if (parsedAuthzFor.has(config)) return parsedAuthzFor.get(config);
  const names = parseAuthzFor(config, who);
  parsedAuthzFor.set(config, names);
  return names;
}

function parseAuthzFor(config: Config, who: string): string[] | undefined {
  const raw = config.authz_for as unknown;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  const names: string[] = [];
  for (const entry of list) {
    // Overrides are raw JSON, so an entry can be anything. Dropping one would
    // shrink the population, and a plugin judging fewer requests than its
    // configuration reads is the failure this option must not introduce.
    if (typeof entry !== 'string' || entry.trim() === '')
      throw new Error(
        `${who}: authz_for must list authentication plugin names, got ` +
          JSON.stringify(entry)
      );
    names.push(entry.trim());
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Whether a plugin configured with `config` judges this request.
 *
 * A request no authenticator vouched for — the list absent, or empty while
 * something set `req.user` anyway — is judged: skipping is only for a
 * request that *someone else's* authenticator vouched for, and inferring
 * that from an absence would turn a gap into an open door.
 *
 * @param req the request, or undefined for an operation outside one
 * @param config the plugin's configuration
 * @returns false only when every authenticator that vouched is another's
 */
export function servesRequest(
  req: DmRequest | undefined,
  config: Config
): boolean {
  const scope = authzFor(config, 'authz_for');
  if (!scope) return true;
  const vouched = req?.authenticators;
  if (!vouched || vouched.length === 0) return true;
  return vouched.some(name => scope.includes(name));
}

/**
 * Whether two authenticators can both vouch for one request.
 *
 * The dispatcher runs the plugins claiming the longest matching prefix, all
 * of them, so two plugins run together exactly when they claim the same
 * prefix — or when neither claims any, on the paths nobody else does. A
 * prefix nested in another's is not shared: the longer one wins on its
 * paths, and the shorter one alone runs on the rest.
 *
 * @param a an authenticator
 * @param b another one
 * @returns true when a request can carry both stamps
 */
export function runTogether(a: Authenticator, b: Authenticator): boolean {
  if (a.pathPrefixes.length === 0 && b.pathPrefixes.length === 0) return true;
  return a.pathPrefixes.some(prefix => b.pathPrefixes.includes(prefix));
}

/** A plugin that judges LDAP operations, and whose. */
export interface Judge {
  plugin: DmPlugin;
  hooks: string[];
  population: Population;
}

/**
 * The plugins judging LDAP operations.
 *
 * A plugin that authenticates as well — `authzDynamic` — judges its own
 * requests and no others: its hooks read the token it verified, and a request
 * without one passes them untouched. The others judge the population
 * `--authz-for` gives them, everyone by default.
 *
 * @param server the server, once every plugin is loaded
 * @returns one entry per judging plugin, in registration order
 */
export function ldapJudges(server: DM): Judge[] {
  const judges: Judge[] = [];
  for (const plugin of Object.values(server.loadedPlugins)) {
    if (!plugin.roles?.includes('authz')) continue;
    const hooks = LDAP_JUDGING_HOOKS.filter(hook =>
      Boolean((plugin.hooks as Record<string, unknown> | undefined)?.[hook])
    );
    if (hooks.length === 0) continue;
    const population: Population = plugin.roles.includes('auth')
      ? [plugin.name]
      : (authzFor(plugin.config, plugin.name) ?? EVERYONE);
    judges.push({ plugin, hooks, population });
  }
  return judges;
}

/**
 * Whether two populations can share a request, and how.
 *
 * @param a a population
 * @param b another one
 * @param authenticators the loaded authentication plugins
 * @returns `same` when one authenticator is in both, `together` when a
 *          request can be vouched for by one of each, undefined otherwise
 */
export function overlap(
  a: Population,
  b: Population,
  authenticators: Authenticator[]
): 'same' | 'together' | undefined {
  if (a === EVERYONE || b === EVERYONE) return 'same';
  if (a.some(name => b.includes(name))) return 'same';
  const byName = (name: string): Authenticator | undefined =>
    authenticators.find(plugin => plugin.name === name);
  for (const x of a)
    for (const y of b) {
      const ax = byName(x);
      const by = byName(y);
      if (ax && by && runTogether(ax, by)) return 'together';
    }
  return undefined;
}

/**
 * Say a population in words, for the log.
 *
 * `everyone` names the authenticators it takes in: the accident this module
 * is about is a branch model judging an authenticator nobody wrote it for,
 * and a line saying "every request" would not show it.
 *
 * @param population the population
 * @param authenticators the loaded authentication plugins
 * @returns a phrase
 */
export function describePopulation(
  population: Population,
  authenticators: Authenticator[]
): string {
  if (population !== EVERYONE)
    return `requests authenticated by ${population.join(', ')}`;
  return authenticators.length > 0
    ? `every authenticated request (${authenticators.map(p => p.name).join(', ')})`
    : 'every authenticated request';
}

/**
 * Whether a plugin authenticates, as far as the dispatcher is concerned.
 *
 * @param plugin a plugin
 * @returns true when it claims paths to authenticate
 */
function isAuthenticator(plugin: DmPlugin): plugin is DmPlugin & Authenticator {
  return (
    Boolean(plugin.roles?.includes('auth')) &&
    Array.isArray((plugin as Partial<Authenticator>).pathPrefixes)
  );
}

/**
 * Refuse the compositions nobody decided, and say the others.
 *
 * - an `authz_for` naming no loaded authentication plugin is refused: the
 *   plugin would judge nobody, which reads as a working configuration;
 * - an `authz_for` of its own on a plugin that authenticates is said: it
 *   judges the requests it vouched for, and the option is inert there;
 * - two plugins judging the LDAP operations of the same authenticator's
 *   requests are refused unless `--authz-combine` makes the AND deliberate;
 * - two judging authenticators that run on the same prefix — a request
 *   carrying both credentials is judged by both — are said, not refused:
 *   asking for two credentials is already a decision;
 * - every judge is named with the hooks it takes part in and whose requests
 *   it judges.
 *
 * `authzPerRoute` gates URLs and registers no LDAP hook, so it is never part
 * of the AND this refuses: route plus branch is a documented combination,
 * and each side judges identities it can name.
 *
 * Run once every plugin of the configuration is loaded, over all of them;
 * and for a plugin registered after that — a server assembled by hand —
 * over what that one plugin adds, before it is registered. What it adds is
 * judged against what is already there, so an authorization plugin naming
 * authenticators is registered after them.
 *
 * @param server the server
 * @param candidate a plugin about to be registered, present in
 *        `server.loadedPlugins`; only what concerns it is checked
 * @throws Error naming the plugins when the composition is ambiguous
 */
export function assertAuthzComposition(server: DM, candidate?: DmPlugin): void {
  const authenticators: Authenticator[] = [...server.authenticators];
  if (
    candidate &&
    isAuthenticator(candidate) &&
    !authenticators.some(plugin => plugin.name === candidate.name)
  )
    authenticators.push(candidate);
  const names = authenticators.map(plugin => plugin.name);
  const concerns = (plugin: DmPlugin): boolean =>
    !candidate || plugin === candidate;
  const plugins = Object.values(server.loadedPlugins).filter(concerns);

  for (const plugin of plugins) {
    if (!plugin.roles?.includes('authz')) continue;
    if (plugin.roles.includes('auth')) {
      // Inert by design, and silent is how a typo in it would read as
      // working. A value inherited from the server-wide option is not this
      // plugin's: it was written for the others.
      const own = plugin.config.authz_for as unknown;
      const shared = server.config.authz_for as unknown;
      if (
        own !== undefined &&
        JSON.stringify(own) !== JSON.stringify(shared) &&
        JSON.stringify(own) !== '[]'
      )
        server.logger.warn(
          `${plugin.name}: authz_for is ignored here. This plugin judges ` +
            'the requests it authenticates itself, and no others'
        );
      continue;
    }
    const scope = authzFor(plugin.config, plugin.name);
    const unknown = (scope ?? []).filter(name => !names.includes(name));
    if (unknown.length > 0)
      throw new Error(
        `${plugin.name}: authz_for names ${unknown.join(', ')}, which ` +
          `${unknown.length > 1 ? 'are not loaded authentication plugins' : 'is not a loaded authentication plugin'}` +
          ` (loaded: ${names.join(', ') || 'none'}). It would judge no ` +
          'request of theirs.' +
          (candidate
            ? ' Register the authentication plugins before the ' +
              'authorization plugins that name them.'
            : '')
      );
  }

  const judges = ldapJudges(server);
  for (const judge of judges)
    if (concerns(judge.plugin))
      server.logger.info(
        `${judge.plugin.name} judges ${judge.hooks.join(', ')} for ` +
          describePopulation(judge.population, authenticators)
      );

  const combine = Boolean(server.config.authz_combine);
  const conflicts: string[] = [];
  for (let i = 0; i < judges.length; i++)
    for (let j = i + 1; j < judges.length; j++) {
      const a = judges[i];
      const b = judges[j];
      if (!concerns(a.plugin) && !concerns(b.plugin)) continue;
      const shared = overlap(a.population, b.population, authenticators);
      if (!shared) continue;
      const pair = `${a.plugin.name} and ${b.plugin.name}`;
      if (shared === 'together') {
        server.logger.warn(
          `${pair} judge the requests of authenticators that run on the ` +
            'same paths: a request carrying both credentials is judged by ' +
            'both, and the first refusal wins'
        );
      } else if (combine) {
        server.logger.warn(
          `${pair} both judge the LDAP operations of the same requests, and ` +
            'compose as an AND (--authz-combine): the first refusal wins'
        );
      } else {
        conflicts.push(pair);
      }
    }
  if (conflicts.length > 0)
    throw new Error(
      `${conflicts.join('; ')} both judge the LDAP operations of the same ` +
        'requests, and would compose as an AND: the first refusal wins, and ' +
        'the 403 does not say whose it was. Give each an authz_for naming ' +
        'the authentication plugins it serves, so that no request is judged ' +
        'by both, or set --authz-combine to make the AND deliberate.'
    );

  for (const plugin of plugins) plugin.assertComposition?.();
}
