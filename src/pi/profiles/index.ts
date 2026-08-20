import type { PiRuntimeProfile } from "../profile.ts";
import { PI_AFT_PROFILE } from "./pi-aft.ts";

const PROFILES = new Map<string, PiRuntimeProfile>([
  [PI_AFT_PROFILE.id, PI_AFT_PROFILE],
]);

export const DEFAULT_PI_PROFILE = PI_AFT_PROFILE;

export function getPiRuntimeProfile(id: string): PiRuntimeProfile {
  const profile = PROFILES.get(id);
  if (!profile) throw new Error(`Unknown Pi remote runtime profile: ${id}`);
  return profile;
}

export function listPiRuntimeProfiles(): readonly PiRuntimeProfile[] {
  return [...PROFILES.values()];
}
