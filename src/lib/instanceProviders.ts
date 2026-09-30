/**
 * @module lib/instanceProviders
 *
 * The two places a workplace instance can be created: the Cloudery, which
 * answers at once and builds the instance afterwards, and the cozy-stack
 * admin API, which builds it before answering.
 */
import fetch, { type RequestInit, type Response } from 'node-fetch';

import { BadGatewayError, ConflictError, GatewayTimeoutError } from './errors';

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
   * The instance at this request's address, if any. One that belongs to
   * another account is a conflict, not an answer.
   */
  find(
    request: InstanceRequest,
    at?: string
  ): Promise<FoundInstance | undefined>;
  /** The address this request's instance gets. */
  address(request: InstanceRequest): string;
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
  constructor(
    protected readonly domain: string,
    protected readonly timeout: number
  ) {}

  address(request: InstanceRequest): string {
    return `${request.id}.${this.domain}`.toLowerCase();
  }

  protected async call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeout),
      });
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
    // node-fetch names the timeout AbortError; the only signal is ours
    return ['AbortError', 'TimeoutError'].includes((err as Error).name)
      ? new GatewayTimeoutError(
          `${new URL(url).host} did not answer within ${this.timeout} ms`
        )
      : err;
  }
}

export class ClouderyProvider extends HttpProvider implements InstanceProvider {
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
        internal_email?: string;
        oidc?: string;
        instantiated_at?: string | null;
      }[];
    }>(res);
    const found = items?.[0];
    if (!found) return undefined;
    // Only the fields the instance holds are compared
    if (
      (found.internal_email &&
        found.internal_email.toLowerCase() !== request.email.toLowerCase()) ||
      (found.oidc && found.oidc !== request.id)
    )
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
    if (
      found.email?.toLowerCase() !== request.email.toLowerCase() ||
      found.oidc_id !== (request.oidc ?? request.id)
    )
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
  ): Promise<
    | { email?: string; oidc_id?: string; onboarding_finished?: boolean }
    | undefined
  > {
    const res = await this.call(
      `${this.url}/instances/${encodeURIComponent(fqdn)}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw await refused('cozy-stack instance read failed', res);
    const { data } = await this.json<{
      data?: {
        attributes?: {
          email?: string;
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
