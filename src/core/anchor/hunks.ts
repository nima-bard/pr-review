export interface LineHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkHeaders(patch: string): LineHunk[] {
  const hunks: LineHunk[] = [];
  for (const line of patch.split('\n')) {
    const m = HEADER.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

export type ShiftResult = { kind: 'mapped'; line: number; delta: number } | { kind: 'inHunk'; predictedLine: number };

/**
 * Maps a 1-based line through git -U0 hunks (ordered). git puts a pure insertion (oldLines 0)
 * after old line `oldStart`; a pure deletion (newLines 0) has `newStart` = the new line before
 * the removed block.
 */
export function shiftLine(hunks: readonly LineHunk[], line: number): ShiftResult {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldLines === 0) {
      if (line > h.oldStart) {
        delta += h.newLines;
        continue;
      }
      break;
    }
    if (line < h.oldStart) break;
    const oldEnd = h.oldStart + h.oldLines - 1;
    if (line <= oldEnd) {
      const predictedLine = h.newLines === 0 ? h.newStart + 1 : h.newStart + Math.min(line - h.oldStart, h.newLines - 1);
      return { kind: 'inHunk', predictedLine: Math.max(1, predictedLine) };
    }
    delta += h.newLines - h.oldLines;
  }
  return { kind: 'mapped', line: line + delta, delta };
}

/** Line ranges of the new side touched by hunks (for "locally modified" checks). */
export function touchedNewLines(hunks: readonly LineHunk[], start: number, end: number): boolean {
  return hunks.some((h) => {
    if (h.newLines === 0) return h.newStart >= start - 1 && h.newStart <= end;
    const hEnd = h.newStart + h.newLines - 1;
    return h.newStart <= end && hEnd >= start;
  });
}
