import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { askImageQuestion, resolveImageQuestionModel } from "@oh-my-pi/pi-coding-agent/utils/image-question";
import type { HostImageQuestionHandler } from "../client.ts";
import { imageQuestionModelMetadata, type ImageQuestionModel } from "../protocol.ts";

/** A query is only a candidate: native ReadTool decides whether it is image Q&A or jq. */
export function prepareHostImageQuestion(
  path: unknown,
  session: ToolSession,
  assertCurrent: () => void,
  completeImpl?: Parameters<typeof askImageQuestion>[5],
): {
  imageQuestionModel?: ImageQuestionModel;
  onImageQuestion?: HostImageQuestionHandler;
  resolutionError?: unknown;
} {
  if (typeof path !== "string" || !/[?&]q=/.test(path)) return {};
  try {
    const resolved = resolveImageQuestionModel(session);
    return {
      imageQuestionModel: imageQuestionModelMetadata(resolved.model),
      onImageQuestion: async (request, signal) => {
        assertCurrent();
        signal.throwIfAborted();
        const result = await askImageQuestion(session, resolved, {
          data: request.data, mimeType: request.mimeType, resolvedPath: "", textNote: "",
          bytes: Buffer.from(request.data, "base64").byteLength,
        }, request.question, signal, completeImpl);
        signal.throwIfAborted();
        assertCurrent();
        return result.text;
      },
    };
  } catch (resolutionError) {
    return { resolutionError };
  }
}

/** Replace only the unarmed worker's image resolver failure, never JSON or loading errors. */
export function imageQuestionFailure(error: unknown, resolutionError: unknown): unknown {
  return resolutionError !== undefined && error instanceof Error &&
    error.message.includes("Model registry is unavailable for image questions.") ? resolutionError : error;
}
