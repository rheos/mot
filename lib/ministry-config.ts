// mot/lib/ministry-config.ts
//
// Boot-time validator for the Ministry Source Adapter config (config/ministry-adapters.ts).
// Wired into instrumentation.ts after migrate_db() — a misconfigured adapter fails the app
// at boot, not silently at runtime (AC-7). Validates against the live lib/enums.ts enums so
// the config can never reference a ministry/severity the rest of the system doesn't know.

import { Ministry } from './enums';
import type { MinistrySourceAdapter } from '../config/ministry-adapters';

// Ministries whose adapters must never feed full email bodies to the classifier
// (EC-P2-7, FR-P2-7): education = co-parent/school comms; commerce + plenty = financial.
const SENSITIVE_MINISTRIES = new Set<string>(['education', 'commerce', 'plenty']);

export function validateMinistryConfig(adapters: MinistrySourceAdapter[]): void {
  const validMinistries = new Set<string>(Object.values(Ministry));
  for (const adapter of adapters) {
    const id = adapter.sourceId;
    if (!validMinistries.has(adapter.ministry)) {
      throw new Error(
        `validateMinistryConfig: unknown ministry "${adapter.ministry}" in adapter "${id}"`,
      );
    }
    if (!adapter.cadence) {
      throw new Error(`validateMinistryConfig: missing cadence in adapter "${id}"`);
    }
    if (!adapter.classifierInput) {
      throw new Error(`validateMinistryConfig: missing classifierInput in adapter "${id}"`);
    }
    for (const tt of adapter.ticketTypes) {
      if (!tt || tt.includes(':')) {
        throw new Error(
          `validateMinistryConfig: invalid ticketType "${tt}" (empty or contains colon) in adapter "${id}"`,
        );
      }
    }
    if (SENSITIVE_MINISTRIES.has(adapter.ministry) && adapter.classifierInput !== 'metadata-only') {
      throw new Error(
        `validateMinistryConfig: adapter "${id}" has sensitive ministry "${adapter.ministry}" ` +
          `but classifierInput="${adapter.classifierInput}"; must be "metadata-only" (EC-P2-7)`,
      );
    }
  }
}
