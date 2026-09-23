/**
 * @module plugins/bcl/ldap
 *
 * Back-Channel Logout tombstones kept in the directory itself.
 *
 * One entry per killed session, under a branch of its own, in the shape
 * `Apache::Session::Browseable::LDAP` uses for the same job: an
 * `applicationProcess` whose `cn` identifies the record and whose
 * `description` carries its content. Here the content is a single number, the
 * moment the session it kills would have ended anyway.
 *
 * The key a logout token gives — `<issuer>|sid|<value>` — is a URL with
 * separators an RDN would have to escape, and of no bounded length. It is
 * hashed into the `cn` instead, and kept verbatim in `description` beside the
 * deadline, so an operator reading the branch can still tell what an entry is
 * about.
 *
 * @group Plugins
 */
import { createHash } from 'node:crypto';

import DmPlugin from '../../abstract/plugin';
import BclStore from '../../lib/bcl/store';
import type { DM } from '../../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';
import type { SearchResult } from '../../lib/ldapActions';

class LdapBclStore extends BclStore {
  name = 'bcl/ldap';
  private server: DM;
  private base: string;
  private objectClass: string;

  constructor(server: DM, base: string, retention: number) {
    super(server.logger, retention);
    this.server = server;
    this.base = base;
    this.objectClass =
      (server.config.bcl_ldap_object_class as string) || 'applicationProcess';
  }

  /** `cn` of the entry holding `key`. Hashed: the key is a URL, not an RDN. */
  private dn(key: string): string {
    const cn = createHash('sha256').update(key).digest('hex');
    return `cn=${cn},${this.base}`;
  }

  /** `description` holds the deadline and the key it stands for. */
  private static encode(key: string, deadline: number): string {
    return `${deadline} ${key}`;
  }

  private static decode(value: unknown): number | null {
    const ms = parseInt(String(value).split(' ')[0], 10);
    return Number.isFinite(ms) ? ms : null;
  }

  protected async read(key: string): Promise<number | null> {
    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['description'] },
        this.dn(key)
      )) as SearchResult;
      const entry = res.searchEntries?.[0];
      if (!entry) return null;
      return LdapBclStore.decode(entry.description);
    } catch (err) {
      // "No such entry" is the common case and not an error: nobody logged
      // out. Anything else means the store could not be consulted, which is
      // enforcement stopping — said out loud rather than read as "alive".
      // 32 is noSuchObject, carried onto the wrapped error the same way.
      if ((err as { code?: number })?.code !== 32)
        this.logger.warn(
          `${this.name}: cannot read a tombstone, enforcement is blind: ${String(err)}`
        );
      return null;
    }
  }

  protected async write(key: string, deadline: number): Promise<void> {
    const dn = this.dn(key);
    const description = LdapBclStore.encode(key, deadline);
    try {
      await this.server.ldap.add(dn, {
        objectClass: ['top', this.objectClass],
        cn: dn.slice(3, dn.indexOf(',')),
        description,
      });
    } catch (err) {
      // Already there is the ordinary case: a second logout token for the
      // same session, or the same one delivered twice. The later deadline
      // wins, and a failure to write it is a failure to record — raised, so
      // the provider is told 400 and retries, rather than told 204 about a
      // logout nothing kept.
      // Read the code, not the sentence: `ldapActions` carries the LDAP
      // result code onto the error it wraps, and a reword of its message is
      // the one change a test cannot warn about from a distance. 68 is
      // entryAlreadyExists.
      const already = (err as { code?: number })?.code === 68;
      if (!already) {
        this.logger.warn(`${this.name}: cannot record ${dn}: ${String(err)}`);
        throw err;
      }
      await this.server.ldap.modify(dn, { replace: { description } });
    }
  }

  protected async remove(key: string): Promise<void> {
    await this.server.ldap.delete(this.dn(key)).catch(() => undefined);
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let gone = 0;
    const res = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'one',
        filter: `(objectClass=${this.objectClass})`,
        attributes: ['description'],
      },
      this.base
    )) as SearchResult;
    for (const entry of res.searchEntries || []) {
      const deadline = LdapBclStore.decode(entry.description);
      // A record nothing can be read from is dropped too: it cannot expire on
      // its own, and it would sit there forever.
      if (deadline !== null && deadline > now) continue;
      await this.server.ldap.delete(String(entry.dn)).catch(() => undefined);
      gone++;
    }
    return gone;
  }
}

export default class BclLdap extends DmPlugin {
  name = 'bclLdap';
  store: LdapBclStore;

  constructor(server: DM) {
    super(server);
    const base = server.config.bcl_ldap_base as string;
    if (!base) {
      throw new Error(
        'bcl/ldap needs --bcl-ldap-base: the branch it writes its tombstones ' +
          'to. It holds nothing but those, so it belongs outside the branches ' +
          'the directory serves.'
      );
    }
    this.store = new LdapBclStore(
      server,
      base,
      (server.config.bcl_retention as number) || 604800
    );
    this.store.startSweeping((server.config.bcl_sweep_interval as number) || 0);
  }

  hooks = {
    oidclogouttoken: async (token: OidcLogoutToken): Promise<void> => {
      await this.store.record(token);
    },

    oidclogin: async (claims: OidcSessionClaims): Promise<void> => {
      await this.store.forget(claims);
    },

    oidcsessionvalid: async ([claims, valid]: [
      OidcSessionClaims,
      boolean,
    ]): Promise<[OidcSessionClaims, boolean]> => {
      // A verdict already given stands: a refusal is never turned back into
      // an acceptance by a later subscriber.
      if (!valid) return [claims, valid];
      return [claims, !(await this.store.isRevoked(claims))];
    },
  };
}
