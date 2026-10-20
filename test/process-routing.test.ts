import { expect, test } from "bun:test";
import { mergeProcessListings, processExecutionTarget } from "../src/omp/process-routing.ts";

const local = (id: string) => id === "bg_1" || id === "Scout";
test("process resource lists route every URI, including selectors and streams", () => {
  for (const path of ["proc://bg_1/streams/0", "proc://bg_1:1-10;proc://Scout"]) {
    expect(processExecutionTarget("grep", { path }, local)).toBe("local");
  }
  expect(processExecutionTarget("grep", { path: "proc://web;proc://api:1-10" }, local)).toBe("remote");
  expect(processExecutionTarget("read", { path: "proc://" }, local)).toBeUndefined();
  expect(processExecutionTarget("read", { path: "file.txt" }, local)).toBeUndefined();
});
test("mixed process ownership cannot send later resources to the first resource's host", () => {
  for (const path of ["proc://bg_1;proc://web", "proc://web;proc://bg_1", "proc://bg_1;/tmp/remote.txt", "proc://web;agent://Scout"]) {
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
