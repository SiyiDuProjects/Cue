import assert from "node:assert/strict";
import test from "node:test";
import { codeDiff } from "../src/codeWorkspaceState";

test("line comparison preserves both full documents, including blank lines and duplicates", () => {
  const cases = [["", "a\n"], ["a\nb\na\n", "a\nx\na\n"], ["one", ""], ["same", "same"]];
  for (const [before, after] of cases) {
    const diff = codeDiff(before, after);
    assert.equal(diff.filter((line) => line.kind !== "added").map((line) => line.text).join("\n"), before);
    assert.equal(diff.filter((line) => line.kind !== "removed").map((line) => line.text).join("\n"), after);
  }
  assert.deepEqual(codeDiff("a\nb\nc", "a\nx\nc").map((line) => line.kind), ["same", "removed", "added", "same"]);
});

function assertDiffContents(before: string, after: string, diff: ReturnType<typeof codeDiff>) {
  const original = diff.filter((line) => line.kind !== "added");
  const proposed = diff.filter((line) => line.kind !== "removed");
  assert.equal(original.map((line) => line.text).join("\n"), before);
  assert.equal(proposed.map((line) => line.text).join("\n"), after);
  assert.deepEqual(original.map((line) => line.before), original.map((_, index) => index + 1));
  assert.deepEqual(proposed.map((line) => line.after), proposed.map((_, index) => index + 1));
}

test("a small replacement in a long file highlights only the changed lines", () => {
  const original = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`);
  const proposed = [...original];
  proposed[4_999] = "updated line";
  const diff = codeDiff(original.join("\n"), proposed.join("\n"));
  assert.deepEqual(diff.filter((line) => line.kind !== "same"), [
    { kind: "removed", text: "line 5000", before: 5_000 },
    { kind: "added", text: "updated line", after: 5_000 },
  ]);
  assertDiffContents(original.join("\n"), proposed.join("\n"), diff);
  assert.equal(codeDiff(original.join("\n"), original.join("\n")).every((line) => line.kind === "same"), true);
});

test("distant changes in a long file retain the unchanged code between them", () => {
  const original = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`);
  const proposed = [...original];
  proposed[99] = "first update";
  proposed[9_899] = "second update";
  const before = original.join("\n"), after = proposed.join("\n");
  const diff = codeDiff(before, after);
  assert.deepEqual(diff.filter((line) => line.kind !== "same"), [
    { kind: "removed", text: "line 100", before: 100 },
    { kind: "added", text: "first update", after: 100 },
    { kind: "removed", text: "line 9900", before: 9_900 },
    { kind: "added", text: "second update", after: 9_900 },
  ]);
  assert.equal(diff.filter((line) => line.kind === "same").length, 9_998);
  assertDiffContents(before, after, diff);
});

test("comparison preserves indentation, line endings and trailing blank lines exactly", () => {
  for (const [before, after] of [
    ["", "\n"], ["\n", ""], ["a", "a\n"], ["a\n", "a"],
    ["a\n\n", "a\n"], ["    return value", "  return value"],
    ["a\r\nb\r\n", "a\r\nnew\r\nb\r\n"],
  ]) {
    assertDiffContents(before, after, codeDiff(before, after));
  }
  assert.deepEqual(codeDiff("    return value", "  return value").map((line) => line.kind), ["removed", "added"]);
});

test("long-file insertions and deletions preserve both sets of line numbers", () => {
  const original = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`);
  for (const position of [0, 500, original.length]) {
    const proposed = [...original.slice(0, position), "", "added line", ...original.slice(position)];
    const before = original.join("\n"), after = proposed.join("\n");
    const inserted = codeDiff(before, after);
    assert.equal(inserted.filter((line) => line.kind === "added").length, 2);
    assert.equal(inserted.some((line) => line.kind === "removed"), false);
    assertDiffContents(before, after, inserted);
    const deleted = codeDiff(after, before);
    assert.equal(deleted.filter((line) => line.kind === "removed").length, 2);
    assert.equal(deleted.some((line) => line.kind === "added"), false);
    assertDiffContents(after, before, deleted);
  }
});

test("bounded fallback preserves unchanged context and every line of a large rewrite", () => {
  const before = ["header", ...Array.from({ length: 2_000 }, (_, index) => `old ${index}`), "footer"].join("\n");
  const after = ["header", ...Array.from({ length: 2_000 }, (_, index) => `new ${index}`), "footer"].join("\n");
  const diff = codeDiff(before, after);
  assert.deepEqual(diff.filter((line) => line.kind === "same").map((line) => line.text), ["header", "footer"]);
  assert.equal(diff.length, 4_002);
  assertDiffContents(before, after, diff);
});
