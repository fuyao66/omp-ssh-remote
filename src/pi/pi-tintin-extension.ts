import { installPiRemoteExtension } from "./host-extension.ts";
import { createTintinPiConnectionInheritance } from "./integrations/tintin-subagents.ts";

/**
 * Dedicated Tintin opt-in entry.
 * Root when no inheritance env is present; child when hasSpec/hasRootOwner.
 * Passes inheritance explicitly for host migration; inheritedChild remains
 * available for tests/callers that invoke installPiRemoteExtension directly.
 */
export default async function piTintinRemoteExtension(
  pi: Parameters<typeof installPiRemoteExtension>[0],
): Promise<void> {
  const inheritance = createTintinPiConnectionInheritance();
  // Host will migrate options.inheritance?; cast until then.
  return installPiRemoteExtension(pi, {
    inheritance,
    inheritedChild: inheritance.hasSpec() || inheritance.hasRootOwner(),
  } as { inheritedChild?: boolean });
}
