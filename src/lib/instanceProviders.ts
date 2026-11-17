/**
 * @module lib/instanceProviders
 *
 * The two places a workplace instance can be created: the Cloudery, which
 * answers at once and builds the instance afterwards, and the cozy-stack
 * admin API, which builds it before answering.
 */
import {
  BadGatewayError,
  ConflictError,
  GatewayTimeoutError,
} from './errors.js';
import { timedOutbound } from './metrics.js';

/** The longest slug the Cloudery takes. */
export const CLOUDERY_SLUG_MAX_LENGTH = 30;

/**
 * The longest slug given to cozy-stack: a DNS label's (RFC 1035). No longer
 * one can be an address, so an instance cozy-stack already holds keeps its
 * own; the Cloudery's 30 would move the longer ones.
 */
export const COZY_SLUG_MAX_LENGTH = 63;

/**
 * Reduce a name to what the provider takes in a slug; the Cloudery refused
 * `_` or `@` with "Slug is invalid", and a slug longer than
 * {@link CLOUDERY_SLUG_MAX_LENGTH}. `-` is kept, except at either end where
 * no host name takes it: an instance already created with one would
 * otherwise change address. Without `dashes`, none is kept: a Cloudery taking
 * `/\A[a-z0-9]{0,30}\z/` only, and cozy-stack serving apps at
 * `<slug>-<app>.<domain>` (flat subdomains), refuse a `-` in an instance's
 * first label. Distinct uids can reduce to one slug, so a creation first
 * checks that an instance already there is the account's own.
 *
 * @param value uid, or the slug template filled in
 * @param rules.maxLength the provider's longest slug
 * @param rules.dashes whether `-` is kept inside the slug
 * @returns the slug, empty when nothing of `value` is kept
 */
export const instanceSlug = (
  value: string,
  { maxLength, dashes = true }: { maxLength: number; dashes?: boolean }
): string => {
  const slug = value
    .toLowerCase()
    .replace(dashes ? /[^a-z0-9-]/g : /[^a-z0-9]/g, '');
  let start = 0;
  while (start < slug.length && slug[start] === '-') start++;
  // Cut first: a cut slug may end on a dash too
  let end = Math.min(slug.length, start + maxLength);
  while (end > start && slug[end - 1] === '-') end--;
  return slug.slice(start, end);
};

/**
 * The `n`th form of a slug another account holds: the slug with `n` at its
 * end, shortened so that the whole still fits `maxLength`.
 *
 * @param slug the account's slug
 * @param n 2 for the first number, 3 for the next…
 * @param maxLength the provider's longest slug
 */
export const numberedSlug = (
  slug: string,
  n: number,
  maxLength: number
): string => {
  const suffix = String(n);
  return slug.slice(0, maxLength - suffix.length) + suffix;
};

/**
 * The account's Matrix ID, from its mail, for cozy-stack to store as is. A
 * value cozy-stack's `IsMatrixID` would refuse is not sent, nor one whose
 * local part holds a `:`, which a Matrix ID reads as the start of its server.
 *
 * @returns `@local:domain` lowercased, undefined for a malformed mail
 */
export const matrixId = (mail: string): string | undefined => {
  const at = mail.lastIndexOf('@');
  const local = mail.slice(0, at);
  const domain = mail.slice(at + 1);
  const id = `@${local}:${domain}`.toLowerCase();
  if (
    at < 1 ||
    !domain ||
    local.includes(':') ||
    /\s/.test(id) ||
    Buffer.byteLength(id) > 255
  )
    return undefined;
  return id;
};

export interface InstanceRequest {
  /** Slug of the instance, and its OIDC id unless `oidc` says otherwise */
  id: string;
  oidc?: string;
  email: string;
  publicName: string;
  locale: string;
  phone?: string;
  orgId?: string;
  orgDomain?: string;
  offer?: string;
}

export interface FoundInstance {
  fqdn: string;
  /** Built and usable, not only accepted */
  ready: boolean;
}

export interface InstanceProvider {
  /**
   * Ask for an instance. Answers the address when the instance already
   * exists by then; otherwise it comes later, with `workplace.created`.
   */
  create(request: InstanceRequest): Promise<string | undefined>;
  /**
   * The instance at this request's address, if any. One whose OIDC id is
   * another is a conflict, not an answer. The email is not compared: the
   * account's mail is the one that counts, and which account an instance
   * belongs to is the directory's to say.
   */
  find(
    request: InstanceRequest,
    at?: string
  ): Promise<FoundInstance | undefined>;
  /** The address this request's instance gets. */
  address(request: InstanceRequest): string;
  /** The longest slug this provider takes */
  readonly slugMaxLength: number;
}

const MAX_BODY = 500;

async function refused(what: string, res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).slice(0, MAX_BODY);
  return new BadGatewayError(
    `${what}: HTTP ${res.status}${body ? ` ${body}` : ''}`
  );
}

/**
 * HTTP with a deadline per call: these calls sit inside the add request.
 * The deadline covers the answer's body too.
 */
abstract class HttpProvider {
  /** The `target` label of this provider's calls in the outbound metrics */
  protected abstract readonly target: string;

  constructor(
    protected readonly domain: string,
    protected readonly timeout: number
  ) {}

  address(request: InstanceRequest): string {
    return `${request.id}.${this.domain}`.toLowerCase();
  }

  protected async call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await timedOutbound(this.target, () =>
        fetch(url, { ...init, signal: AbortSignal.timeout(this.timeout) })
      );
    } catch (err) {
      throw this.timedOut(err, url);
    }
  }

  protected async json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw this.timedOut(err, res.url);
    }
  }

  private timedOut(err: unknown, url: string): unknown {
    // The deadline is the only signal fetch is given. Node 22 answers a
    // TimeoutError at every stage; AbortError covers the runtimes that name
    // an abort of the body so
    return ['AbortError', 'TimeoutError'].includes(
      (err as { name?: string }).name ?? ''
    )
      ? new GatewayTimeoutError(
          `${new URL(url).host} did not answer within ${this.timeout} ms`
        )
      : err;
  }
}

export class ClouderyProvider extends HttpProvider implements InstanceProvider {
  protected readonly target = 'cloudery';
  readonly slugMaxLength = CLOUDERY_SLUG_MAX_LENGTH;

  constructor(
    private readonly url: string,
    private readonly token: string,
    domain: string,
    private readonly offer: string,
    timeout: number
  ) {
    super(domain, timeout);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async create(request: InstanceRequest): Promise<undefined> {
    const res = await this.call(`${this.url}/api/v1/instances`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        email: request.email,
        internal_email: request.email,
        publicName: request.publicName,
        public_name: request.publicName,
        locale: request.locale,
        oidc: request.id,
        slug: request.id,
        phone: request.phone || '',
        offer: request.offer || this.offer,
        domain: this.domain,
        skip_email_validation: true,
        ...(request.orgId ? { org_id: request.orgId } : {}),
        ...(request.orgDomain ? { org_domain: request.orgDomain } : {}),
      }),
    });
    if (!res.ok) throw await refused('Cloudery refused the instance', res);
    return undefined;
  }

  async find(
    request: InstanceRequest,
    at?: string
  ): Promise<FoundInstance | undefined> {
    const fqdn = (at ?? this.address(request)).toLowerCase();
    const url = new URL(`${this.url}/api/v2/instances`);
    url.searchParams.set('fqdn', fqdn);
    url.searchParams.set('limit', '1');
    const res = await this.call(url.toString(), { headers: this.headers() });
    if (!res.ok) throw await refused('Cloudery instance search failed', res);
    const { items } = await this.json<{
      items?: {
        fqdn: string;
        oidc?: string;
        instantiated_at?: string | null;
      }[];
    }>(res);
    const found = items?.[0];
    if (!found) return undefined;
    // Only an OIDC id the instance holds is compared
    if (found.oidc && found.oidc !== request.id)
      throw new ConflictError(
        `${fqdn} already exists and belongs to another user`
      );
    return { fqdn: found.fqdn, ready: Boolean(found.instantiated_at) };
  }

  async createOrganization(org: {
    id: string;
    name: string;
    domain: string;
  }): Promise<void> {
    const res = await this.call(`${this.url}/api/v2/organizations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ldap_branch: org.id,
        name: org.name,
        custom_domain: org.domain,
      }),
    });
    // An organization created by an earlier attempt is the one wanted
    if (!res.ok && res.status !== 409)
      throw await refused('Cloudery refused the organization', res);
  }

  /** The Cloudery takes a member's user.created once its organization is linked */
  async linkOrganization(id: string, fqdn: string): Promise<void> {
    const res = await this.call(
      `${this.url}/api/v2/organizations/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ instance_fqdn: fqdn }),
      }
    );
    if (!res.ok)
      throw await refused('Cloudery refused to link the organization', res);
  }
}

export class CozyStackProvider
  extends HttpProvider
  implements InstanceProvider
{
  protected readonly target = 'cozy-stack';
  readonly slugMaxLength = COZY_SLUG_MAX_LENGTH;
  private readonly auth: string;

  constructor(
    private readonly url: string,
    user: string,
    passphrase: string,
    domain: string,
    private readonly context: string,
    private readonly apps: string,
    timeout: number
  ) {
    super(domain, timeout);
    this.auth = `Basic ${Buffer.from(`${user}:${passphrase}`).toString('base64')}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: this.auth, Accept: 'application/json' };
  }

  async create(request: InstanceRequest): Promise<string> {
    const fqdn = this.address(request);
    const params = new URLSearchParams({
      Domain: fqdn,
      Email: request.email,
      PublicName: request.publicName,
      Locale: request.locale,
      // The OP's `sub`, or the OIDC callback refuses the login
      OIDCID: request.oidc ?? request.id,
    });
    if (request.phone) params.set('Phone', request.phone);
    if (request.orgId) params.set('OrgID', request.orgId);
    if (request.orgDomain) params.set('OrgDomain', request.orgDomain);
    if (this.context) params.set('ContextName', this.context);
    if (this.apps) params.set('Apps', this.apps);
    const res = await this.call(`${this.url}/instances?${params.toString()}`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.status === 409) {
      if (!(await this.find(request)))
        throw new ConflictError(`${fqdn} already exists`);
      return fqdn;
    }
    if (!res.ok) throw await refused('cozy-stack refused the instance', res);
    await this.finishOnboarding(fqdn);
    return fqdn;
  }

  /** Also finishes the onboarding of an instance left unfinished. */
  async find(
    request: InstanceRequest,
    at?: string
  ): Promise<FoundInstance | undefined> {
    const fqdn = (at ?? this.address(request)).toLowerCase();
    const found = await this.read(fqdn);
    if (!found) return undefined;
    // Strict here: an instance cozy-stack holds with no owner is not ours
    if (found.oidc_id !== (request.oidc ?? request.id))
      throw new ConflictError(
        `${fqdn} already exists and belongs to another user`
      );
    if (!found.onboarding_finished) await this.finishOnboarding(fqdn);
    return { fqdn, ready: true };
  }

  /**
   * Destroy the instance of a deleted account, the entry being gone: one
   * another OIDC id owns is left alone.
   */
  async destroy(id: string, oidc: string): Promise<void> {
    const fqdn = this.address({ id } as InstanceRequest);
    const found = await this.read(fqdn);
    if (!found) return;
    if (found.oidc_id !== oidc)
      throw new ConflictError(`${fqdn} belongs to another user, left in place`);
    const res = await this.call(
      `${this.url}/instances/${encodeURIComponent(fqdn)}`,
      { method: 'DELETE', headers: this.headers() }
    );
    if (!res.ok && res.status !== 404)
      throw await refused('cozy-stack refused to destroy the instance', res);
  }

  private async read(
    fqdn: string
  ): Promise<{ oidc_id?: string; onboarding_finished?: boolean } | undefined> {
    const res = await this.call(
      `${this.url}/instances/${encodeURIComponent(fqdn)}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw await refused('cozy-stack instance read failed', res);
    const { data } = await this.json<{
      data?: {
        attributes?: {
          oidc_id?: string;
          onboarding_finished?: boolean;
        };
      };
    }>(res);
    return data?.attributes ?? {};
  }

  /** Without it, the first login lands on the setup wizard. */
  private async finishOnboarding(fqdn: string): Promise<void> {
    const res = await this.call(
      `${this.url}/instances/${encodeURIComponent(fqdn)}?OnboardingFinished=true`,
      { method: 'PATCH', headers: this.headers() }
    );
    if (!res.ok)
      throw await refused('cozy-stack refused to finish onboarding', res);
  }
}
