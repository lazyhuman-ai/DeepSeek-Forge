import type { StructuredDiff, StructuredDiffHunk } from "../streams/event-types.js";

type DiffRow =
  | { kind: "equal"; text: string; oldLine: number; newLine: number }
  | { kind: "delete"; text: string; oldLine: number }
  | { kind: "insert"; text: string; newLine: number };

const MAX_EXACT_DIFF_CELLS = 1_000_000;
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}

function commonPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index++;
  return index;
}

function commonSuffixLength(a: string[], b: string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let count = 0;
  while (
    count < max &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count++;
  }
  return count;
}

function buildSingleFallbackHunk(
  before: string[],
  after: string[],
  prefix: number,
  suffix: number,
): StructuredDiffHunk[] {
  const beforeChanged = before.slice(prefix, before.length - suffix);
  const afterChanged = after.slice(prefix, after.length - suffix);
  const contextBefore = before.slice(Math.max(0, prefix - 3), prefix);
  const contextAfter = after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + 3));
  const oldStart = Math.max(1, prefix - contextBefore.length + 1);
  const newStart = Math.max(1, prefix - contextBefore.length + 1);
  const lines = [
    ...contextBefore.map((line) => ` ${line}`),
    ...beforeChanged.map((line) => `-${line}`),
    ...afterChanged.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ];
  return [
    {
      oldStart,
      oldLines: contextBefore.length + beforeChanged.length + contextAfter.length,
      newStart,
      newLines: contextBefore.length + afterChanged.length + contextAfter.length,
      lines,
    },
  ];
}

function lineEdits(before: string[], after: string[]): DiffRow[] | null {
  if (before.length * after.length > MAX_EXACT_DIFF_CELLS) return null;
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const diff: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      diff.push({ kind: "equal", text: before[i]!, oldLine, newLine });
      i++;
      j++;
      oldLine++;
      newLine++;
      continue;
    }
    if (j < after.length && (i === before.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      diff.push({ kind: "insert", text: after[j]!, newLine });
      j++;
      newLine++;
      continue;
    }
    if (i < before.length) {
      diff.push({ kind: "delete", text: before[i]!, oldLine });
      i++;
      oldLine++;
    }
  }
  return diff;
}

function rowOldStart(rows: DiffRow[], firstIndex: number): number {
  const first = rows[firstIndex]!;
  if ("oldLine" in first) return first.oldLine;
  for (let i = firstIndex - 1; i >= 0; i--) {
    const row = rows[i]!;
    if ("oldLine" in row) return row.oldLine + 1;
  }
  return 1;
}

function rowNewStart(rows: DiffRow[], firstIndex: number): number {
  const first = rows[firstIndex]!;
  if ("newLine" in first) return first.newLine;
  for (let i = firstIndex - 1; i >= 0; i--) {
    const row = rows[i]!;
    if ("newLine" in row) return row.newLine + 1;
  }
  return 1;
}

function buildHunksFromRows(rows: DiffRow[]): StructuredDiffHunk[] {
  const changeIndexes = rows
    .map((row, index) => row.kind === "equal" ? -1 : index)
    .filter((index) => index >= 0);
  if (changeIndexes.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => {
    const hunkRows = rows.slice(start, end + 1);
    return {
      oldStart: rowOldStart(rows, start),
      oldLines: hunkRows.filter((row) => row.kind !== "insert").length,
      newStart: rowNewStart(rows, start),
      newLines: hunkRows.filter((row) => row.kind !== "delete").length,
      lines: hunkRows.map((row) => {
        if (row.kind === "equal") return ` ${row.text}`;
        if (row.kind === "delete") return `-${row.text}`;
        return `+${row.text}`;
      }),
    };
  });
}

export function buildStructuredDiff(
  filePath: string,
  beforeText: string,
  afterText: string,
  operation: StructuredDiff["operation"] = "updated",
): StructuredDiff {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  if (beforeText === afterText) {
    return {
      filePath,
      operation,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
  }
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const exactRows = lineEdits(before, after);
  const deleted = exactRows
    ? exactRows.filter((row) => row.kind === "delete").length
    : before.length - prefix - suffix;
  const added = exactRows
    ? exactRows.filter((row) => row.kind === "insert").length
    : after.length - prefix - suffix;
  return {
    filePath,
    operation,
    additions: added,
    deletions: deleted,
    hunks: exactRows ? buildHunksFromRows(exactRows) : buildSingleFallbackHunk(before, after, prefix, suffix),
  };
}
