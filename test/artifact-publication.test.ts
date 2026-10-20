import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { createRemoteArtifacts, resolveRemoteArtifacts, type RemoteArtifacts } from "../src/omp/artifacts.ts";

const namespaces: RemoteArtifacts[] = [];
afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(artifacts => artifacts.dispose()));
});

async function createArtifacts(): Promise<RemoteArtifacts> {
  const artifacts = await createRemoteArtifacts({ sweep: false });
  namespaces.push(artifacts);
  return artifacts;
}

function truncation(id: string, overrides: Partial<NonNullable<OutputMeta["truncation"]>> = {}): NonNullable<OutputMeta["truncation"]> {
  return {
    direction: "head", truncatedBy: "lines", totalLines: 20, totalBytes: 2000,
    outputLines: 2, outputBytes: 200, shownRange: { start: 1, end: 2 },
    nextOffset: 3, artifactId: id, ...overrides,
  };
}

function textContent(value: unknown): string[] {
  const result = value as { content: { type: string; text?: string }[] };
  return result.content.filter(block => block.type === "text").map(block => block.text!);
}

interface TextResult {
  content: { type: string; text: string }[];
  details: { meta: OutputMeta };
}

function textResult(meta: OutputMeta, body = "application output"): TextResult {
  return { content: [{ type: "text", text: body + formatOutputNotice(meta) }], details: { meta } };
}

describe("remote artifact publication", () => {
  test("preserves rich application values, printed anchors, code, output, and arbitrary artifactId/meta fields", async () => {
    const artifacts = await createArtifacts();
    const application = {
      artifactId: "customer-field",
      nested: { artifactId: "123", literal: "artifact://12345", meta: { truncation: { artifactId: "456" } } },
      items: [{ artifactId: "array-field" }],
    };
    const views = [
      { text: "JSON anchor artifact://12345", view: { kind: "json", value: application } },
      { text: "table artifact://67890", view: {
        kind: "table", columns: [{ head: "artifact://12345", key: "artifactId" }],
        rows: [["customer-field", "artifact://67890"]],
      } },
      { text: "markdown anchor", view: { kind: "markdown", text: "# Literal\n[record](artifact://12345)\nartifact://67890" } },
    ];
    const body = "literal artifact://12345; suffix artifact://67890abc; embedded remote-artifact://24680";
    const input = {
      content: [{ type: "text", text: body }],
      details: {
        cells: [{ code: `print(${JSON.stringify(application)})`, output: views.map(view => view.text).join("\n"), views, meta: application.nested.meta }],
        application, artifactId: "12345", nested: { meta: { truncation: { artifactId: "12345" } } },
      },
      meta: { truncation: { artifactId: "12345" } },
    };
    const snapshot = structuredClone(input);
    const published = artifacts.publish(input, "eval") as typeof input;
    expect(published).toEqual(snapshot);
    expect(input).toEqual(snapshot);
    expect(published.details.cells).toBe(input.details.cells);
    expect(published.details.application).toBe(application);
    expect(artifacts.publish(published, "eval")).toEqual(published);
  });

  test("adapts only owned numeric ID slots, preserves metadata, and changes only the exact native notice suffix", async () => {
    const artifacts = await createArtifacts();
    const meta = {
      truncation: { ...truncation("12"), nested: { artifactId: "application-id", uri: "artifact://13" } },
      source: { type: "internal" as const, value: "artifact://12" },
      diagnostics: { summary: "one", messages: ["literal artifact://13"] },
      pagedSource: true as const,
      artifactId: "application-meta-id", extra: { artifactId: "application-id" },
      limits: { resultLimit: { reached: 4 }, extra: { artifactId: "application-id" } },
    };
    const body = "  literal artifact://12\n\n";
    const input = textResult(meta, body);
    const original = structuredClone(input);
    const published = artifacts.publish(input) as typeof input;
    const { artifactId: _id, ...keptTruncation } = meta.truncation;
    const expectedMeta = { ...meta, truncation: keptTruncation, source: { ...meta.source, value: `remote-artifact://${artifacts.namespace}/12` } };
    expect(published.details.meta).toEqual(expectedMeta);
    expect(textContent(published)).toEqual([
      body + formatOutputNotice(expectedMeta),
      `Read remote-artifact://${artifacts.namespace}/12 for full output`,
    ]);
    expect(input).toEqual(original);
    expect(artifacts.publish(published)).toEqual(published);
  });

  test("does not rewrite near-matches, notices inside application text, or text blocks other than the native final block", async () => {
    const artifacts = await createArtifacts();
    const meta = { truncation: truncation("21") };
    const notice = formatOutputNotice(meta);
    const input = {
      content: [
        { type: "text", text: "earlier" + notice },
        { type: "text", text: "literal artifact://21" + notice + " not the generated suffix\n" },
        { type: "image", data: "unchanged" },
      ],
      details: { meta },
    };
    const published = artifacts.publish(input) as typeof input;
    expect(published.content.slice(0, 3)).toEqual(input.content);
    expect(textContent(published).at(-1)).toBe(`Read remote-artifact://${artifacts.namespace}/21 for full output`);
    expect(artifacts.publish(published)).toEqual(published);
  });

  test("preserves partial-line and head/tail-sample semantics and capture failures", async () => {
    const artifacts = await createArtifacts();
    const meta: OutputMeta = {
      truncation: truncation("30", {
        truncatedBy: "bytes", partialLine: true, artifactElidedBytes: 4096,
        maxBytes: 200, shownRange: { start: 9, end: 9 },
      }),
      artifactError: "write",
    };
    const input = textResult(meta);
    const published = artifacts.publish(input) as typeof input;
    const { artifactId: _id, ...expectedTruncation } = meta.truncation!;
    expect(published.details.meta.truncation).toEqual(expectedTruncation);
    expect(published.details.meta.truncation).not.toHaveProperty("artifactId");
    expect(published.details.meta.artifactError).toBe("write");
    const text = textContent(published).join("\n");
    expect(text).toContain("Showing line 9 (partial");
    expect(text).toContain("head/tail sample");
    expect(text).toContain("from its middle was not saved");
    expect(text).toContain("Full output was not saved completely (artifact write failed)");
    expect(text).not.toContain("for full output");
    expect(artifacts.publish(published)).toEqual(published);
  });

  test("distinguishes complete aggregate reports from sampled reports and retains provenance", async () => {
    const artifacts = await createArtifacts();
    for (const sampled of [false, true]) {
      const meta: OutputMeta = {
        truncation: truncation(sampled ? "42" : "41", sampled ? { artifactElidedBytes: 1024 } : {}),
        source: { type: "report", value: "grep aggregate; source captures may be incomplete" },
      };
      const published = artifacts.publish(textResult(meta));
      const text = textContent(published).join("\n");
      expect(text).toContain(meta.source!.value);
      expect(text).toContain(`remote-artifact://${artifacts.namespace}/${sampled ? "42" : "41"}`);
      if (sampled) {
        expect(text).toContain("head/tail sample");
        expect(text).not.toContain("for full report");
        expect(text).not.toContain("for full output");
      } else {
        expect(text).toContain("for full report");
        expect(text).not.toContain("head/tail sample");
      }
      expect(artifacts.publish(published)).toEqual(published);
    }
  });

  test("column-only complete captures use canonical remote raw-line selectors without duplicate recovery notices", async () => {
    const artifacts = await createArtifacts();
    const meta: OutputMeta = { limits: { columnTruncated: {
      maxColumn: 80, unit: "bytes", artifactId: "50", lines: { first: 7, last: 11 },
    } } };
    const published = artifacts.publish(textResult(meta)) as TextResult;
    const uri = `remote-artifact://${artifacts.namespace}/50`;
    expect(published.details.meta.limits?.columnTruncated).toEqual({
      maxColumn: 80, unit: "bytes", lines: { first: 7, last: 11 }, selectorBase: uri,
    });
    expect(textContent(published)).toHaveLength(1);
    expect(textContent(published)[0]).toContain(`Use ${uri}:raw:7-7 to read line 7 whole`);
    expect(textContent(published)[0]).toContain("cut lines run to line 11");
    expect(textContent(published)[0]!.split(uri)).toHaveLength(2);
    expect(artifacts.publish(published)).toEqual(published);

    // A result without its generated notice still receives the complete recovery hint.
    const withoutNotice = artifacts.publish({ content: [{ type: "text", text: "body" }], details: { meta } });
    expect(textContent(withoutNotice)).toHaveLength(2);
    expect(textContent(withoutNotice)[0]).toBe("body");
    expect(textContent(withoutNotice)[1]).toContain(`Use ${uri}:raw:7-7 to read line 7 whole`);
    expect(textContent(withoutNotice)[1]).toContain("cut lines run to line 11");
    expect(textContent(withoutNotice)[1]!.split(uri)).toHaveLength(2);
  });

  test("column-only sampled artifacts never acquire original-line selectors into their renumbered sample", async () => {
    const artifacts = await createArtifacts();
    const meta: OutputMeta = { limits: { columnTruncated: {
      maxColumn: 80, artifactId: "60", artifactElidedBytes: 8192,
      lines: { first: 100, last: 200 }, selectorBase: "artifact://60",
    } } };
    const published = artifacts.publish(textResult(meta)) as TextResult;
    expect(published.details.meta.limits?.columnTruncated).toEqual({
      maxColumn: 80, artifactElidedBytes: 8192, lines: { first: 100, last: 200 },
    });
    const text = textContent(published).join("\n");
    expect(text).toContain(`Read remote-artifact://${artifacts.namespace}/60 for a head/tail sample`);
    expect(text).not.toContain(":raw:");
    expect(text).not.toContain("for full output");
    expect(artifacts.publish(published)).toEqual(published);

    const noLines: OutputMeta = { limits: { columnTruncated: { maxColumn: 80, artifactId: "61" } } };
    const complete = artifacts.publish(textResult(noLines));
    expect(textContent(complete).join("\n")).toContain(`Read remote-artifact://${artifacts.namespace}/61 for full output`);
  });

  test("maps only whole native URIs in typed source/selector metadata and preserves already-remote and unknown fields", async () => {
    const artifacts = await createArtifacts();
    for (const uri of ["artifact://70", "literal artifact://70", "artifact://70suffix", "artifact://70:raw:1-1", "remote-artifact://12345", "remote-artifact://other/70"]) {
      const meta = {
        source: { type: "internal" as const, value: uri },
        limits: { columnTruncated: { maxColumn: 80, lines: { first: 1, last: 1 }, selectorBase: uri } },
        unknown: { source: { type: "internal", value: "artifact://70" }, artifactId: "70" },
      };
      const input = { content: [{ type: "text", text: `literal ${uri}` }], details: { meta, applicationUri: "artifact://70" } };
      const published = artifacts.publish(input) as typeof input;
      const expected = uri === "artifact://70" ? `remote-artifact://${artifacts.namespace}/70` : uri;
      expect(published.details.meta.source.value).toBe(expected);
      expect(published.details.meta.limits.columnTruncated.selectorBase).toBe(expected);
      expect(published.details.meta.unknown).toEqual(meta.unknown);
      expect(published.details.applicationUri).toBe("artifact://70");
      expect(published.content).toEqual(input.content);
      expect(artifacts.publish(published)).toEqual(published);
    }
  });

  test("adapts verified Edit per-file metadata only, preserving diffs, snapshots, and nested application metadata", async () => {
    const artifacts = await createArtifacts();
    const input = {
      content: [{ type: "text", text: "edit artifact://80; application text" }],
      details: {
        diff: "combined artifact://80", oldText: "artifact://80", newText: "artifact://81",
        perFileResults: [
          { path: "a.ts", diff: "-artifact://80\n+artifact://81", oldText: "artifact://80", meta: { truncation: truncation("80") } },
          { path: "b.ts", diff: "literal artifact://81", meta: { truncation: truncation("81", { artifactElidedBytes: 2048 }) } },
          { path: "not-a-native-result", meta: { truncation: truncation("82") } },
        ],
        application: { perFileResults: [{ path: "c.ts", diff: "data", meta: { truncation: { artifactId: "83" } } }] },
      },
    };
    const original = structuredClone(input);
    expect(artifacts.publish(input, "eval")).toEqual(input);
    const published = artifacts.publish(input, "edit") as typeof input;
    for (const index of [0, 1]) expect(published.details.perFileResults[index]!.meta.truncation).not.toHaveProperty("artifactId");
    expect(published.details.perFileResults.map(file => file.diff)).toEqual(input.details.perFileResults.map(file => file.diff));
    expect(published.details.perFileResults[0]!.oldText).toBe(input.details.perFileResults[0]!.oldText);
    expect(published.details.perFileResults[2]).toEqual(input.details.perFileResults[2]);
    expect(published.details.application).toEqual(input.details.application);
    expect(published.details.oldText).toBe(input.details.oldText);
    expect(published.details.newText).toBe(input.details.newText);
    expect(textContent(published)[0]).toBe(input.content[0]!.text);
    const recovery = textContent(published)[1]!;
    expect(recovery).toContain(`Read remote-artifact://${artifacts.namespace}/80 for full output`);
    expect(recovery).toContain(`Read remote-artifact://${artifacts.namespace}/81 for a head/tail sample`);
    expect(recovery).not.toContain("/82");
    expect(input).toEqual(original);
    expect(artifacts.publish(published, "edit")).toEqual(published);
  });

  test("adapts only Bash's exact generated raw footer and preserves every surrounding byte", async () => {
    const artifacts = await createArtifacts();
    const meta = { truncation: truncation("90") };
    const prefix = "  literal artifact://90\n[raw output: artifact://91]\nnot a footer\r\n\t\n";
    const body = prefix + "[raw output: artifact://90] \t\r\n";
    const input = textResult(meta, body);
    const published = artifacts.publish(input, "bash") as typeof input;
    const uri = `remote-artifact://${artifacts.namespace}/90`;
    const { artifactId: _id, ...adaptedTruncation } = meta.truncation;
    expect(textContent(published)).toEqual([
      prefix + `[raw output: ${uri}] \t\r\n` + formatOutputNotice({ truncation: adaptedTruncation }),
    ]);
    expect(artifacts.publish(published, "bash")).toEqual(published);
    expect(textContent(artifacts.publish({ content: [{ type: "text", text: body }] }, "eval"))).toEqual([body]);
    for (const text of [
      "prefix [raw output: artifact://90]", "[raw output: artifact://90]\nmore output",
      "[raw output: artifact://90suffix]", "[raw output: remote-artifact://existing/90]",
    ]) {
      expect(textContent(artifacts.publish({ content: [{ type: "text", text }] }, "bash"))).toEqual([text]);
    }
  });

  test("Bash raw footers retain head/tail-sample warnings from either owned metadata slot", async () => {
    const artifacts = await createArtifacts();
    const id = "92";
    const uri = `remote-artifact://${artifacts.namespace}/${id}`;
    const metadata: OutputMeta[] = [
      { truncation: truncation(id, { artifactElidedBytes: 4096 }) },
      { limits: { columnTruncated: { maxColumn: 80, artifactId: id, artifactElidedBytes: 4096 } } },
    ];
    const prefix = "  literal artifact://92\n";
    for (const meta of metadata) {
      const input = textResult(meta, prefix + `[raw output: artifact://${id}] \t\r\n`);
      const original = structuredClone(input);
      const published = artifacts.publish(input, "bash") as TextResult;
      const content = textContent(published);
      expect(content).toHaveLength(2);
      expect(content[0]).toBe(prefix + `[raw output: ${uri}] \t\r\n` + formatOutputNotice(published.details.meta));
      expect(content[1]).toContain(`Read ${uri} for a head/tail sample`);
      expect(content[1]).toContain("from its middle was not saved");
      expect(content.join("\n")).not.toContain("for full output");
      const sample = published.details.meta.truncation ?? published.details.meta.limits?.columnTruncated;
      expect(sample).not.toHaveProperty("artifactId");
      expect(sample?.artifactElidedBytes).toBe(4096);
      expect(input).toEqual(original);
      expect(artifacts.publish(published, "bash")).toEqual(published);
      expect(artifacts.publish(artifacts.publish(published, "bash"), "bash")).toEqual(published);
    }
  });

  test("deduplicates shared owned recovery IDs without treating literal remote URIs as generated references", async () => {
    const artifacts = await createArtifacts();
    const uri = `remote-artifact://${artifacts.namespace}/95`;
    const meta: OutputMeta = { truncation: truncation("95"), limits: { columnTruncated: { maxColumn: 80, artifactId: "95" } } };
    const input = { content: [{ type: "text", text: `application literal ${uri}` }], details: { meta } };
    const published = artifacts.publish(input);
    expect(textContent(published)).toEqual([input.content[0]!.text, `Read ${uri} for full output`]);
    expect(artifacts.publish(published)).toEqual(published);
  });

  test("published recovery references resolve to the actual remote artifact bytes", async () => {
    const artifacts = await createArtifacts();
    const path = join(artifacts.manager.dir, "99.eval.log");
    const bytes = "exact recovered output\n😀\nartifact://literal";
    await writeFile(path, bytes);
    const published = artifacts.publish(textResult({ truncation: truncation("99") }));
    const reference = /remote-artifact:\/\/[^\s]+/.exec(textContent(published).at(-1)!)![0];
    const resolved = await resolveRemoteArtifacts(reference);
    expect(resolved).toBe(path);
    expect(await readFile(resolved as string, "utf8")).toBe(bytes);
  });
});
