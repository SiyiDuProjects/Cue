import { diffLines } from "diff";
export type DiffLine = { kind: "same" | "added" | "removed"; text: string; before?: number; after?: number };

export function codeDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const lines: DiffLine[] = [];
  let start = 0, aEnd = a.length, bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) {
    lines.push({ kind: "same", text: a[start], before: start + 1, after: start + 1 });
    start++;
  }
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  // Terminate every logical line so jsdiff preserves our final blank-line
  // display without treating a missing newline as a replacement of that line.
  const oldRegion = aEnd > start ? `${a.slice(start, aEnd).join("\n")}\n` : "";
  const newRegion = bEnd > start ? `${b.slice(start, bEnd).join("\n")}\n` : "";
  const changes = diffLines(oldRegion, newRegion, { maxEditLength: 1_024 });
  if (!changes) {
    // A very large rewrite exceeds the edit budget. Keep its content visible
    // and retain verified unchanged context outside the rewritten region.
    for (let i = start; i < aEnd; i++) lines.push({ kind: "removed", text: a[i], before: i + 1 });
    for (let j = start; j < bEnd; j++) lines.push({ kind: "added", text: b[j], after: j + 1 });
  } else {
    let i = start, j = start;
    for (const change of changes) {
      for (const text of change.value.slice(0, -1).split("\n")) {
        if (change.removed) lines.push({ kind: "removed", text, before: ++i });
        else if (change.added) lines.push({ kind: "added", text, after: ++j });
        else lines.push({ kind: "same", text, before: ++i, after: ++j });
      }
    }
  }
  while (aEnd < a.length) {
    lines.push({ kind: "same", text: a[aEnd], before: ++aEnd, after: ++bEnd });
  }
  return lines;
}
