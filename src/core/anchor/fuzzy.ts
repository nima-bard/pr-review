import type { DiffSide } from './types';

export interface HunkLine {
  num: number;
  text: string;
}

export interface AnchorText {
  target: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface FuzzyConfig {
  radius: number;
  ambiguityMargin: number;
}

export interface FuzzyHit {
  line: number;
  score: number;
  ambiguous: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The lines of a GitHub diff_hunk snapshot that exist on the given side, with their line numbers. */
export function parseHunkSide(diffHunk: string, side: DiffSide): HunkLine[] {
  const lines = diffHunk.split('\n');
  const header = lines[0] !== undefined ? HUNK_HEADER.exec(lines[0]) : null;
  if (!header) return [];
  let left = parseInt(header[1]!, 10);
  let right = parseInt(header[3]!, 10);
  const result: HunkLine[] = [];
  for (const raw of lines.slice(1)) {
    if (raw.startsWith('\\')) continue;
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    if (marker === '+') {
      if (side === 'RIGHT') result.push({ num: right, text });
      right++;
    } else if (marker === '-') {
      if (side === 'LEFT') result.push({ num: left, text });
      left++;
    } else {
      result.push({ num: side === 'RIGHT' ? right : left, text });
      left++;
      right++;
    }
  }
  return result;
}

/** Context from the full blob: GitHub hunks end at the commented line, so they carry no context after it. */
export function anchorFromLines(lines: readonly string[], line: number, k = 4): AnchorText {
  return {
    target: lines[line - 1] ?? '',
    contextBefore: lines.slice(Math.max(0, line - 1 - k), line - 1),
    contextAfter: lines.slice(line, line + k),
  };
}

/** Fallback when the original blob is unavailable: everything the frozen hunk knows. */
export function anchorFromHunk(diffHunk: string, side: DiffSide, line: number, k = 4): AnchorText | undefined {
  const sideLines = parseHunkSide(diffHunk, side);
  const idx = sideLines.findIndex((l) => l.num === line);
  if (idx === -1) return undefined;
  return {
    target: sideLines[idx]!.text,
    contextBefore: sideLines.slice(Math.max(0, idx - k), idx).map((l) => l.text),
    contextAfter: sideLines.slice(idx + 1, idx + 1 + k).map((l) => l.text),
  };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function tokens(s: string): Set<string> {
  return new Set(s.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Whitespace-insensitive blend of character and identifier similarity in [0,1]. */
export function lineSimilarity(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return 1;
  const max = Math.max(ta.length, tb.length);
  const chars = max === 0 ? 1 : 1 - levenshtein(ta, tb) / max;
  return 0.5 * chars + 0.5 * jaccard(tokens(ta), tokens(tb));
}

export function contextSimilarity(anchor: AnchorText, buffer: readonly string[], candidate: number): number {
  const sims: number[] = [];
  const before = anchor.contextBefore;
  for (let i = 1; i <= before.length; i++) {
    const idx = candidate - 1 - i;
    sims.push(idx >= 0 && idx < buffer.length ? lineSimilarity(before[before.length - i]!, buffer[idx]!) : 0);
  }
  const after = anchor.contextAfter;
  for (let i = 1; i <= after.length; i++) {
    const idx = candidate - 1 + i;
    sims.push(idx >= 0 && idx < buffer.length ? lineSimilarity(after[i - 1]!, buffer[idx]!) : 0);
  }
  if (sims.length === 0) return 0;
  return sims.reduce((s, v) => s + v, 0) / sims.length;
}

const LOW_INFO = /^[\s{}()[\];,]*$|^(return;?|else\s*\{?|break;|continue;|\}\s*else\s*\{|end|fi|done)$/;

export function contentWeight(target: string): number {
  const t = target.trim();
  return t.length < 4 || LOW_INFO.test(t) ? 0.25 : 0.6;
}

export function findAnchor(buf: readonly string[], anchor: AnchorText, predicted: number, cfg: FuzzyConfig): FuzzyHit | undefined {
  const w = contentWeight(anchor.target);
  const lo = Math.max(1, predicted - cfg.radius);
  const hi = Math.min(buf.length, predicted + cfg.radius);
  let best: FuzzyHit | undefined;
  let second: FuzzyHit | undefined;
  for (let c = lo; c <= hi; c++) {
    const raw = w * lineSimilarity(anchor.target, buf[c - 1]!) + (1 - w) * contextSimilarity(anchor, buf, c);
    const score = raw * (1 - 0.03 * (Math.abs(c - predicted) / cfg.radius));
    const hit: FuzzyHit = { line: c, score, ambiguous: false };
    if (!best || score > best.score) {
      second = best;
      best = hit;
    } else if (!second || score > second.score) {
      second = hit;
    }
  }
  if (!best) return undefined;
  const ambiguous = second !== undefined && best.score - second.score < cfg.ambiguityMargin && Math.abs(best.line - second.line) > 1;
  return { ...best, ambiguous };
}
