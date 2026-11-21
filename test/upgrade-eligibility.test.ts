import { expect, test } from "bun:test";
import { upgradeBlockers, type EligibilityInput } from "../scripts/upgrade.ts";
import type { UpgradeAssessment } from "../scripts/upgrade-assess.ts";

const assessment: UpgradeAssessment = {
  baseline: "19.0.0", target: "19.0.1", anchorFailures: 0, missing: [], changed: [], breaking: [],
  changelogFound: true, bunRequirement: ">=1.4.4",
};
const input: EligibilityInput = {
  baseline: assessment.baseline, target: assessment.target, assessment, gatePassed: true, unexpectedChanges: [], bunVersion: "1.4.4",
  contracts: [
    { id: "review-me", native: ["tools/read.ts", "../../pi-utils/src/worker-host.ts"], review: "Check local execution." },
    { id: "no-review", native: ["tools/edit.ts"] },
    { id: "blank-review", native: ["tools/bash.ts"], review: "  " },
  ],
};
const nativeRead: UpgradeAssessment["missing"][number] = { pkg: "pi-coding-agent", file: "src/tools/read.ts", reasons: ["contract review-me"] };
const codes = (patch: Partial<EligibilityInput>) => upgradeBlockers({ ...input, ...patch }).map(blocker => blocker.code);
const assess = (patch: Partial<UpgradeAssessment>) => codes({ assessment: { ...assessment, ...patch } });

test("a passing release allows changed files without a manual review requirement", () => {
  expect(assess({ changed: [
    { ...nativeRead, file: "src/tools/edit.ts" },
    { ...nativeRead, file: "src/tools/bash.ts" },
    { ...nativeRead, pkg: "pi-utils" }, // Same path in a different package is not an intersection.
  ] })).toEqual([]);
});

test("a failed or skipped release gate blocks release", () => expect(codes({ gatePassed: false })).toEqual(["gate"]));
test("a non-mechanical diff blocks release", () => expect(codes({ unexpectedChanges: ["src/extension.ts"] })).toEqual(["diff"]));
test("no assessment blocks release", () => expect(codes({ assessment: undefined })).toEqual(["assessment"]));
test("an assessment for a different version range blocks release", () => expect(assess({ baseline: "19.0.1" })).toEqual(["assessment-range"]));
test("a failed adaptation anchor blocks release", () => expect(assess({ anchorFailures: 1 })).toEqual(["anchors"]));
test("a missing native dependency blocks release", () => expect(assess({ missing: [nativeRead] })).toEqual(["missing"]));
test("a changelog breaking change blocks release", () => expect(assess({ breaking: ["19.0.1: removed an API"] })).toEqual(["breaking"]));
test("an absent changelog blocks release independently of breaking entries", () => expect(assess({ changelogFound: false })).toEqual(["changelog"]));
test("an unmet Bun range blocks release", () => expect(assess({ bunRequirement: ">=1.5.0 <2" })).toEqual(["bun"]));
test("changed native files with manual review block release, including sibling packages", () => {
  expect(assess({ changed: [nativeRead] })).toEqual(["review"]);
  expect(assess({ changed: [{ ...nativeRead, pkg: "pi-utils", file: "src/worker-host.ts" }] })).toEqual(["review"]);
});
