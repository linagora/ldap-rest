import { outboundRequestDuration } from '../../src/lib/metrics';

/** How many calls to `target` the outbound histogram holds under `status` */
export const outboundCalls = async (
  target: string,
  status: string
): Promise<number> =>
  (await outboundRequestDuration.get()).values.find(
    v =>
      v.metricName === 'ldap_rest_outbound_request_duration_seconds_count' &&
      v.labels.target === target &&
      v.labels.status === status
  )?.value ?? 0;
