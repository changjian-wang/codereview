import type { FixEdit } from '../ai/analyzer';

/**
 * Pure, VS Code-free edit-locating core for the fix-proposal apply pipeline.
 *
 * This module is the accuracy-critical heart of 「应用此方案」: given the current
 * file text and a model edit, decide WHERE (if anywhere) it lands and WHAT bytes
 * to write — without ever fuzzily guessing a wrong location. It is deliberately
 * free of any `vscode` import so it can be unit-tested directly.
 *
 * Strategy (line-anchored, accuracy first):
 *  - The model is shown the file as `行号<TAB>内容` and returns each edit's
 *    `startLine`/`endLine`. We trust that line as the anchor and VERIFY `oldText`
 *    there (indentation-tolerant, because the line number already pins WHERE).
 *  - Without a usable anchor we fall back to a STRICT content search (indentation
 *    significant); a unique hit applies, several refuse unless a line anchor can
 *    disambiguate, and zero refuses. No fuzzy tiers — loose searching is exactly
 *    what historically let edits land on the wrong line.
 */

/** A line of `text` with char offsets into the original string (offsets exclude the trailing '\n'). */
export interface LineSpan {
  start: number;
  end: number;
  raw: string;
}

/** A resolved placement for one edit: the byte span to replace, its 1-based start line, and the replacement text. */
export interface ResolvedEdit {
  start: number;
  end: number;
  startLine: number;
  replacement: string;
}

/** A located occurrence: byte span into the original text plus its 1-based start line. */
export interface LocatedMatch {
  start: number;
  end: number;
  line: number;
}

/**
 * Splits `text` into lines with char offsets into the original string. The raw
 * line is kept (including any trailing '\r') so callers normalise it as strictly
 * as they need, but `end` stops BEFORE a trailing '\r' so a replacement slots in
 * ahead of the '\r\n' — editing a CRLF file preserves its CRLF endings.
 */
export function lineTable(text: string): LineSpan[] {
  const out: LineSpan[] = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    // raw excludes the '\n'; it may still carry a trailing '\r'. Exclude that
    // '\r' from the content span so we never overwrite the line ending itself.
    const contentLen = raw.endsWith('\r') ? raw.length - 1 : raw.length;
    out.push({ start: pos, end: pos + contentLen, raw });
    pos += raw.length + 1; // +1 for the '\n' we split on
  }
  return out;
}

/** Drop trailing whitespace / CR only; leading indentation is significant. */
export function normTrailing(l: string): string {
  return l.replace(/\s+$/, '');
}

/**
 * Trim both ends — used only on the line-anchored path, where the line number
 * already pins the location so the model dropping/adding indentation is safe to
 * ignore (we still replace the file's real bytes, reindented to the file).
 */
export function normLoose(l: string): string {
  return l.trim();
}

/** Splits `needle` into lines, dropping leading/trailing blank lines so a match lands on real content. */
export function needleLines(needle: string): string[] {
  const lines = needle.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines;
}

/**
 * All occurrences of `needle` in `text`, comparing lines through `norm`:
 * line-based, ignoring only what `norm` discards. Returns char-offset ranges
 * into the original `text` plus the 1-based start line of each match.
 */
export function matchesBy(
  text: string,
  needle: string,
  norm: (l: string) => string,
): LocatedMatch[] {
  const nl = needleLines(needle).map(norm);
  if (nl.length === 0) {
    return [];
  }
  const lines = lineTable(text);
  // Normalise each file line once, not once per overlapping window: `norm` is
  // pure, so hoisting it out of the inner loop is behaviour-preserving and drops
  // the work from O(lines × needle) normalisations to O(lines).
  const normed = lines.map((l) => norm(l.raw));
  const out: LocatedMatch[] = [];
  for (let i = 0; i + nl.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < nl.length; j++) {
      if (normed[i + j] !== nl[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push({ start: lines[i].start, end: lines[i + nl.length - 1].end, line: i + 1 });
    }
  }
  return out;
}

/**
 * STRICT occurrences: leading indentation IS significant. Deliberately NO fuzzy
 * tiers — loose searching is exactly what let edits land on the wrong line.
 * Used to PLACE an edit when there is no line anchor.
 */
export function strictMatches(text: string, needle: string): LocatedMatch[] {
  return matchesBy(text, needle, normTrailing);
}

/**
 * LOOSE occurrences: leading indentation ignored. Used only for cosmetic
 * detection (is a replacement present? where is it for the header?) and undo
 * uniqueness — never to choose where to write a fresh edit. Tolerant because the
 * line-anchored apply path may have reindented the replacement to the file.
 */
export function looseMatches(text: string, needle: string): LocatedMatch[] {
  return matchesBy(text, needle, normLoose);
}

/** True when `needle` occurs at least once (loose — tolerant of reindentation). */
export function isPresent(text: string, needle: string): boolean {
  return needle ? looseMatches(text, needle).length > 0 : false;
}

/**
 * Verifies that the file lines starting at `startIdx` (0-based) equal the
 * already-normalised needle lines `nl` under `norm`, returning the covered byte
 * span or null. The line-anchored path uses this: the line number says WHERE,
 * this confirms WHAT.
 */
export function matchBlockAt(
  lines: LineSpan[],
  startIdx: number,
  nl: string[],
  norm: (l: string) => string,
): { start: number; end: number } | null {
  if (startIdx < 0 || nl.length === 0 || startIdx + nl.length > lines.length) {
    return null;
  }
  for (let j = 0; j < nl.length; j++) {
    if (norm(lines[startIdx + j].raw) !== nl[j]) {
      return null;
    }
  }
  return { start: lines[startIdx].start, end: lines[startIdx + nl.length - 1].end };
}

/** Leading run of spaces/tabs on a line (its indentation). */
export function leadingWhitespace(s: string): string {
  return (s.match(/^[ \t]*/) || [''])[0];
}

/** Fast non-cryptographic content hash (FNV-1a, 32-bit) used for drift detection. */
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}

/**
 * Resolves one edit against the live file for application: the exact byte range
 * to replace, the 1-based start line, and the replacement text — or `null` when
 * the edit cannot be placed with confidence (never a fuzzy guess).
 *
 * Accuracy-first, line-anchored strategy:
 *  1. If the model gave a `startLine`, trust it as the location and VERIFY
 *     `oldText` against the file lines at that anchor (indentation-tolerant,
 *     since the line number already pins WHERE). On match, replace those exact
 *     bytes — ambiguity is impossible because we never searched the whole file.
 *  2. Otherwise, or if the anchor no longer verifies, fall back to a STRICT
 *     content search (indentation significant). Exactly one match → use it;
 *     several → pick the one nearest `startLine` if we have one, else refuse;
 *     zero → refuse (the file changed since generation → regenerate).
 */
export function resolveEditAt(text: string, edit: FixEdit): ResolvedEdit | null {
  const raw = needleLines(edit.oldText);
  if (raw.length === 0) {
    return null;
  }
  // (1) Line-anchored verify at the declared startLine (indentation-tolerant).
  if (edit.startLine && edit.startLine >= 1) {
    const lines = lineTable(text);
    const at = matchBlockAt(lines, edit.startLine - 1, raw.map(normLoose), normLoose);
    if (at) {
      return {
        start: at.start,
        end: at.end,
        startLine: edit.startLine,
        replacement: reindentToFile(text, at, edit.newText),
      };
    }
  }
  // (2) Strict content search, disambiguated by proximity to the declared line.
  const hits = strictMatches(text, edit.oldText);
  if (hits.length === 1) {
    return { start: hits[0].start, end: hits[0].end, startLine: hits[0].line, replacement: edit.newText };
  }
  if (hits.length > 1 && edit.startLine) {
    let best = hits[0];
    for (const h of hits) {
      if (Math.abs(h.line - edit.startLine) < Math.abs(best.line - edit.startLine)) {
        best = h;
      }
    }
    return { start: best.start, end: best.end, startLine: best.line, replacement: edit.newText };
  }
  return null;
}

/**
 * Why an edit can't apply (for the UI badge): `'ambiguous'` when `oldText`
 * matches several places and there is no usable line anchor; otherwise `'gone'`
 * (the file changed since generation → regenerate). `'ok'` when it resolves.
 */
export function editStatus(text: string, edit: FixEdit): 'ok' | 'gone' | 'ambiguous' {
  if (resolveEditAt(text, edit)) {
    return 'ok';
  }
  return strictMatches(text, edit.oldText).length > 1 ? 'ambiguous' : 'gone';
}

/**
 * Re-indents `newText` so it sits at the file's indentation at `hit.start`,
 * used on the line-anchored path when the model dropped the leading indent.
 *
 * It ONLY corrects a uniform under-indentation: if `newText`'s first non-blank
 * line is shallower than the file's anchor indent (and a prefix of it), the
 * missing prefix is prepended to every non-blank line, preserving the block's
 * internal relative indentation. If `newText` already sits at (or below) the
 * anchor indent, it is returned VERBATIM.
 *
 * It deliberately does NOT strip a common minimum indent: doing so corrupts
 * blocks that contain column-0 lines — e.g. a C# `@"..."` verbatim string or a
 * heredoc whose content sits at the left margin — by shifting that significant
 * whitespace. That corruption broke the apply→undo round-trip (undoing a fix no
 * longer restored the file, so an overlapping alternative could not re-apply).
 */
export function reindentToFile(
  haystack: string,
  hit: { start: number; end: number },
  newText: string,
): string {
  let nlPos = haystack.indexOf('\n', hit.start);
  if (nlPos === -1 || nlPos > hit.end) {
    nlPos = hit.end;
  }
  const origIndent = leadingWhitespace(haystack.slice(hit.start, nlPos));
  const lines = newText.split('\n');
  let firstIndent: string | undefined;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstIndent = leadingWhitespace(l);
      break;
    }
  }
  // Nothing to anchor on, already at/over the file indent, or the indents use a
  // different whitespace shape (tabs vs spaces): leave verbatim — never corrupt.
  if (
    firstIndent === undefined ||
    !origIndent.startsWith(firstIndent) ||
    origIndent.length <= firstIndent.length
  ) {
    return newText;
  }
  const pad = origIndent.slice(firstIndent.length);
  return lines.map((l) => (l.trim() === '' ? l : pad + l)).join('\n');
}
