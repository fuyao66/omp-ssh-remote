const resultKey = "PI_TINTIN_SMOKE_CHILD_STATE";

type ToolExecutionEnd = {
  toolName: string;
  result: unknown;
  isError: boolean;
};

type PiExtension = {
  getAllTools(): Array<{ name: string; sourceInfo?: unknown }>;
  on(event: "tool_execution_end", handler: (event: ToolExecutionEnd) => void): void;
};

export default async function tintinRemoteVerifier(
  pi: PiExtension,
): Promise<void> {
  const bashResults: ToolExecutionEnd[] = [];
  const publish = (): void => {
    const bash = pi.getAllTools().find((tool) => tool.name === "bash");
    process.env[resultKey] = JSON.stringify({
      bashResults,
      bashSource: bash?.sourceInfo,
    });
  };

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "bash") return;
    bashResults.push(event);
    publish();
  });
}
