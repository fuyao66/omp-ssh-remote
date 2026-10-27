import { expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isProcessListingPath, mergeProcessListings, processExecutionTarget } from "../src/omp/process-routing.ts";

const local = (id: string) => id === "bg_1" || id === "Scout";
test("process resource lists route every URI, including selectors and streams", () => {
  for (const path of ["proc://bg_1/streams/0", "proc://bg_1:1-10;proc://Scout"]) {
    expect(processExecutionTarget("grep", { path }, local)).toBe("local");
  }
  expect(processExecutionTarget("grep", { path: "proc://web;proc://api:1-10" }, local)).toBe("remote");
  expect(processExecutionTarget("read", { path: "proc://" }, local)).toBe("remote");
  expect(processExecutionTarget("read", { path: "file.txt" }, local)).toBeUndefined();
});
test("native proc URI identity handles scheme case and decoded ids without confusing roots", () => {
  for (const path of ["PROC://bg_1", "proc://%62g_1", "PROC://%53cout:1-10", "proc://bg_1/"]) {
    expect(processExecutionTarget("read", { path }, local)).toBe("local");
    expect(isProcessListingPath(path)).toBe(false);
  }
  for (const path of ["PROC://web", "proc://%77eb:1-10"]) {
    expect(processExecutionTarget("read", { path }, local)).toBe("remote");
    expect(isProcessListingPath(path)).toBe(false);
  }
  for (const path of ["proc:/", "proc:////", "proc:///bg_1", "proc://?q=x", "proc://#part", "proc://web", "proc://bg_1/streams", "proc://;proc://web"]) {
    expect(isProcessListingPath(path)).toBe(false);
  }
});

test("root aliases selected for dual-domain merging are actual native ReadTool listings", async () => {
  const reader = new ReadTool({
    cwd: process.cwd(), settings: Settings.isolated({ "launch.enabled": false }), hasUI: false,
    asyncJobManager: new AsyncJobManager({ onJobComplete() {} }),
    getAgentId: () => "Main", getSessionId: () => "proc-aliases",
    getSessionFile: () => null, getSessionSpawns: () => "",
  });
  for (const path of ["proc://", "proc:///", "PROC://", "PROC:///", "proc:///:raw"]) {
    const result = await reader.execute("native-root", { path });
    expect(result.isError).not.toBe(true);
    expect(result.details?.proc).toMatchObject({ jobs: expect.any(Array), agents: expect.any(Array), daemons: expect.any(Array) });
    expect(isProcessListingPath(path)).toBe(true);
    expect(processExecutionTarget("read", { path }, local)).toBe("remote");
  }
});

test("mixed process ownership cannot send later resources to the first resource's host", () => {
  for (const path of ["proc://bg_1;proc://web", "proc://web;proc://bg_1", "proc://bg_1;/tmp/remote.txt", "proc://web;agent://Scout", "PROC://%62g_1;proc://%77eb", "PROC:///;proc://bg_1", "proc://bg_1;PROC:///"]) {
    expect(() => processExecutionTarget("grep", { path }, local)).toThrow(/Mixed local and remote/);
  }
});
test("merged process listings retain native renderer data and source errors", () => {
  const localResult = { content: [{ type: "text" as const, text: "bg_1 running" }], details: { proc: { jobs: [{ id: "bg_1" }], agents: [{ id: "Scout" }], daemons: [] } } };
  const remoteResult = { content: [{ type: "text" as const, text: "web ready" }], details: { proc: { jobs: [], agents: [], daemons: [{ name: "web" }] } } };
  const merged = mergeProcessListings(localResult, remoteResult);
  expect(merged.details).toMatchObject({ proc: { jobs: [{ id: "bg_1" }], agents: [{ id: "Scout" }], daemons: [{ name: "web" }] } });
  expect(merged.isError).not.toBe(true);
  expect(mergeProcessListings(localResult, { ...remoteResult, isError: true }).isError).toBe(true);
});
