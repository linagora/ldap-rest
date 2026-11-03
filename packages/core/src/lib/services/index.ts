/**
 * Typed services between plugins: a token names the interface a consumer
 * reads and the instance a provider offers, so the compiler checks both.
 *
 * @see docs/plugin-development/services.md
 */

declare const serviceType: unique symbol;

/**
 * What identifies a service: a name for the logs, and the interface it
 * answers. The type is carried by a phantom property and never exists at
 * runtime; the object itself is the registry key.
 */
export interface ServiceToken<T> {
  /** Names the service in the logs */
  readonly name: string;
  /** Type only, never set: carries the interface a consumer reads */
  readonly [serviceType]?: T;
  /**
   * Bind the instance providing this service, as a plugin's `provides`
   * declares. The argument must answer the interface the token names.
   *
   * @param provider the plugin instance providing the service
   * @returns the token and its provider
   */
  with(provider: T): ServiceProvider<T>;
}

/** A token with the instance providing it, as a plugin declares them. */
export interface ServiceProvider<T> {
  readonly token: ServiceToken<T>;
  readonly service: T;
}

/**
 * Declare a service.
 *
 * Declare a token once, in a module both the provider and its consumers
 * import: the object is the registry key, and a second declaration under the
 * same name would be another service. The name only identifies it in the
 * logs.
 *
 * @param name the service name
 * @returns the token, carrying its interface
 */
export const serviceToken = <T>(name: string): ServiceToken<T> => {
  const token: ServiceToken<T> = {
    name,
    with: service => ({ token, service }),
  };
  return token;
};

/** What `DM.services` holds: the provided instance for each token. */
export type ServiceMap = Map<ServiceToken<unknown>, unknown>;

/**
 * The instance provided for a token, when a plugin provides it.
 *
 * A provider always answers something: `undefined` means nobody provides it.
 *
 * @param services the server's registry
 * @param token the service wanted
 * @returns the provided instance, or undefined
 */
export const providedService = <T>(
  services: ReadonlyMap<ServiceToken<unknown>, unknown>,
  token: ServiceToken<T>
): T | undefined => services.get(token) as T | undefined;
