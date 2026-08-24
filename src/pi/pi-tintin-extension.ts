import { installPiRemoteExtension } from "./host-extension.ts";

export default async function piTintinRemoteExtension(
  pi: Parameters<typeof installPiRemoteExtension>[0],
): Promise<void> {
  return installPiRemoteExtension(pi, { inheritedChild: true });
}
