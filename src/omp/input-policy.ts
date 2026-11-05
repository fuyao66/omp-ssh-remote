import type { ExtensionContext, InputEvent, InputEventResult } from "@oh-my-pi/pi-coding-agent";
import { extractFileMentions } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { resolveReadPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { parseLoopArgs } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgBareSlashCommands } from "@oh-my-pi/pi-coding-agent/modes/settings";

const HOST_COMMAND_ALTERNATIVES: Readonly<Record<string, string>> = {
  "/git": "Use Git commands through remote bash instead.",
  "/security": "Use remote read and bash to inspect the remote project instead.",
  "/wt": "Use git worktree through remote bash instead.",
  "/move": "Use remote bash to move remote project files instead.",
  "/add-dir": "Use remote read with explicit remote paths instead.",
  "/remove-dir": "Use explicit remote paths rather than changing local directory context.",
  "/review": "Use git diff through remote bash, then remote read to review the changes.",
  "/annotate": "Use remote read to inspect source files instead.",
};

// Native has no pure consumption predicate: dispatch runs the handler and
// inspects its result (builtin-registry.ts:169-196; acp-builtins.ts:63-69).
// Only exempt the source-audited /switch: builtin-modes.ts:470-505 never
// returns a residual prompt; usage() also consumes input (helpers/parse.ts:70-72).
const CONSUMED_MENTION_BUILTINS: ReadonlySet<string> = new Set(["switch"]);

/** Match native resolveMentionPath without reading or materializing host contents. */
async function hasHostFileMention(text: string, cwd: string): Promise<boolean> {
  for (const mention of extractFileMentions(text)) {
    try {
      await Bun.file(resolveReadPath(mention, cwd)).stat();
      return true;
    } catch { /* Native ignores mentions that do not resolve to an existing entry. */ }
  }
  return false;
}

/** Guard native input paths that bypass the remote workspace tool wrappers. */
export async function remoteInputPolicy(
  selected: boolean,
  event: InputEvent,
  ctx: ExtensionContext,
): Promise<InputEventResult | undefined> {
  if (!selected) return;

  let text = event.text.trimStart();
  if (event.source === "interactive" && !event.images?.length && event.text && !event.text.startsWith("/") && !/\s/.test(event.text)) {
    const settings = findScopedSettings();
    if (settings && cfgBareSlashCommands.get(settings)) {
      const folded = event.text.toLowerCase();
      const token = lookupBuiltinSlashCommand(event.text) ? event.text : folded;
      if (lookupBuiltinSlashCommand(token) || token === "review" || token === "annotate") text = `/${token}`;
    }
  }
  const parsed = parseSlashCommand(text);
  const builtin = parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
  // Bundled /review and /annotate are custom commands, not registry entries;
  // unlike builtins, their command names do not accept a colon separator.
  const command = builtin ? `/${builtin.name}` : text.split(/\s+/, 1)[0]!;
  const alternative = Object.hasOwn(HOST_COMMAND_ALTERNATIVES, command)
    ? HOST_COMMAND_ALTERNATIVES[command] : undefined;
  const loop = builtin?.name === "loop" && parsed ? parseLoopArgs(parsed.args) : undefined;
  const consumed = builtin && CONSUMED_MENTION_BUILTINS.has(builtin.name) &&
    (!parsed?.args.length || builtin.allowArgs) && event.source !== "extension";
  let reason: string | undefined;
  if (alternative) {
    reason = `${command} would act on the local machine while bound to remote. ${alternative} Use /remote-exit before running it locally.`;
  } else if (loop && typeof loop !== "string" && loop.condition) {
    reason = "/loop would act on the local machine while bound to remote: --until and --while conditions execute in the native local shell. Run conditions through remote bash, or use /loop without a shell condition.";
  } else if (!consumed && await hasHostFileMention(event.text, ctx.sessionManager.getCwd())) {
    reason = "@path file mentions would act on the local machine while bound to remote. Drop @ and use remote read with the path instead.";
  }
  if (!reason) return;
  ctx.ui.notify(reason, "warning");
  return { handled: true };
}
