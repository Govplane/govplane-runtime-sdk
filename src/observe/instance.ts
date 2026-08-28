import { hostname } from 'node:os';

/**
 * Identifies this process within a fleet.
 *
 * Fleet-aware alert conditions need it: without an instance dimension, twenty
 * replicas pool into one series, `max` means "the worst instance in the window"
 * and an automated action can be tripped by a single sick pod.
 *
 * Resolution order is the one that gives a stable, low-cardinality value in the
 * places this actually runs. In Kubernetes `HOSTNAME` is the pod name, which
 * churns on redeploy — that is correct rather than unfortunate, since a
 * replaced pod genuinely is a different instance.
 */
export const resolveInstanceId = (): string | undefined => {
  const { GOVPLANE_INSTANCE_ID, HOSTNAME } = process.env;
  const fromEnv = GOVPLANE_INSTANCE_ID ?? HOSTNAME;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  try {
    const host = hostname();
    return host && host.trim() !== '' ? host.trim() : undefined;
  } catch {
    // Some sandboxes refuse it. Better to omit the tag than to invent one.
    return undefined;
  }
};
