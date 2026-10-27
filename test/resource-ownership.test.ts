import { describe, expect, test } from "bun:test";
import { resourceOwnershipTarget, type ResourceOwnershipState } from "../src/resource-ownership.ts";
import { resolveRemoteResourceArgs } from "../src/resource-routing.ts";

const state: ResourceOwnershipState = {
  selected: true,
  binding: "current-binding",
  isLocalProcessId: id => id === "bg_1" || id === "Scout",
};
const conflict = "remote-conflict://current-binding/1";
const orders = (left: string, right: string) => [`${left};${right}`, `${right};${left}`];

describe("shared host resource ownership", () => {
  test("process ownership only overrides native process-resource consumers", () => {
    for (const tool of ["read", "write", "grep", "glob"] as const) {
      expect(resourceOwnershipTarget(tool, { path: "proc://bg_1" }, state)).toBe("local");
      expect(resourceOwnershipTarget(tool, { path: "proc://web" }, state)).toBe("remote");
    }
    expect(resourceOwnershipTarget("debug", { action: "terminate", file: "proc://bg_1" }, state)).toBeUndefined();
    expect(resourceOwnershipTarget("lsp", { file: "proc://bg_1" }, state)).toBeUndefined();
  });
  test("bound conflict ownership cannot bypass any local process spelling in either order", () => {
    for (const proc of ["proc://bg_1", "PROC://%62g_1:1-5", "proc://Scout/streams/0", "[proc://bg_1#ABCD]"]) {
      for (const path of orders(conflict, proc)) {
        expect(() => resourceOwnershipTarget("read", { path }, state)).toThrow("Mixed local and remote");
      }
    }
  });

  test("all-remote process aliases and conflicts compose before decoding", () => {
    for (const proc of ["proc://web", "PROC://%77eb:1-5", "PROC:///"]) {
      for (const path of orders(conflict, proc)) {
        expect(resourceOwnershipTarget("read", { path }, state)).toBe("remote");
        expect(resolveRemoteResourceArgs("read", { path }, state.binding).path).toBe(path.replace(conflict, "conflict://1"));
      }
    }
  });

  test("namespace validation wins over process routing and disabled mode", () => {
    for (const selected of [true, false]) {
      for (const proc of ["proc://bg_1", "proc://web"]) {
        for (const path of orders("remote-conflict://old-binding/1", proc)) {
          expect(() => resourceOwnershipTarget("read", { path }, { ...state, selected })).toThrow("stale workspace binding");
        }
      }
    }
    expect(() => resourceOwnershipTarget("read", { path: conflict }, { ...state, selected: false })).toThrow("stale workspace binding");
  });

  test("local mode leaves ordinary resources on the native host", () => {
    const localState = { ...state, selected: false };
    for (const path of ["file", "proc://web;proc://bg_1", "conflict://1", "agent://Scout"]) {
      expect(resourceOwnershipTarget("read", { path }, localState)).toBe("local");
    }
  });

  test("every resource field participates without treating replacement content as an operand", () => {
    expect(() => resourceOwnershipTarget("read", { path: conflict, file: "proc://bg_1" }, state)).toThrow("Mixed local and remote");
    expect(() => resourceOwnershipTarget("read", { paths: ["proc://bg_1", conflict] }, state)).toThrow("Mixed local and remote");
    expect(resourceOwnershipTarget("write", { path: conflict, content: "proc://bg_1" }, state)).toBe("remote");
    expect(resourceOwnershipTarget("write", { path: "xd://resolve", content: conflict }, state)).toBeUndefined();
  });

  test("native edit inspection exposes destinations without guessing path syntax", () => {
    const args = { input: `*** Begin Patch\n[file#AB12]\nMV ${conflict}\n*** End Patch` };
    expect(() => resourceOwnershipTarget("edit", args, state)).toThrow("only read and write");
    expect(() => resourceOwnershipTarget("edit", args, { ...state, selected: false })).toThrow("stale workspace binding");
  });
});
