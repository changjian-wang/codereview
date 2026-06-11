import { describe, it, expect } from 'vitest';
import type { FixEdit } from '../ai/analyzer';
import {
  editStatus,
  hashContent,
  isPresent,
  looseMatches,
  needleLines,
  reindentToFile,
  resolveEditAt,
  strictMatches,
} from './editLocator';

/**
 * These tests pin the invariants of the line-anchored apply core — the place a
 * fix edit lands. Each `describe` block maps to a failure mode that historically
 * produced 「无法应用」 or, worse, a silently mis-placed edit. The contract under
 * test: an edit either resolves to a verified location or refuses; it must NEVER
 * fuzzily guess a wrong line.
 */

/** Builds a FixEdit terse-ly for tests. */
function edit(partial: Partial<FixEdit> & { oldText: string; newText: string }): FixEdit {
  return partial;
}

/** Applies a resolved edit to text the way the panel would, for end-to-end assertions. */
function applyResolved(text: string, e: FixEdit): string | null {
  const r = resolveEditAt(text, e);
  if (!r) {
    return null;
  }
  return text.slice(0, r.start) + r.replacement + text.slice(r.end);
}

// A file deliberately full of repeated boundary lines — the exact shape that
// made content-only search ambiguous (the bug in the user's screenshot).
const REPETITIVE = [
  'public void A()',                       // 1
  '{',                                     // 2
  '    try { Do(); }',                     // 3
  '    catch (OperationCanceledException)', // 4
  '    {',                                 // 5
  '        return;',                       // 6
  '    }',                                 // 7
  '}',                                     // 8
  '',                                      // 9
  'public void B()',                       // 10
  '{',                                     // 11
  '    try { Do(); }',                     // 12
  '    catch (OperationCanceledException)', // 13
  '    {',                                 // 14
  '        return;',                       // 15
  '    }',                                 // 16
  '}',                                     // 17
].join('\n');

describe('resolveEditAt — line-anchored happy path', () => {
  it('lands on the exact line the model declared', () => {
    const e = edit({
      startLine: 13,
      endLine: 13,
      oldText: '    catch (OperationCanceledException)',
      newText: '    catch (OperationCanceledException ex)',
    });
    const r = resolveEditAt(REPETITIVE, e);
    expect(r).not.toBeNull();
    expect(r!.startLine).toBe(13);
    const out = applyResolved(REPETITIVE, e)!;
    // The SECOND catch changed, the first is untouched.
    expect(out.split('\n')[12]).toBe('    catch (OperationCanceledException ex)');
    expect(out.split('\n')[3]).toBe('    catch (OperationCanceledException)');
  });

  it('disambiguates a repeated snippet by its line anchor (the screenshot bug)', () => {
    // `return;` appears on lines 6 AND 15. With only content this is ambiguous;
    // the line anchor must make it land uniquely on line 15.
    const e = edit({
      startLine: 15,
      endLine: 15,
      oldText: '        return;',
      newText: '        return; // handled',
    });
    expect(editStatus(REPETITIVE, e)).toBe('ok');
    const out = applyResolved(REPETITIVE, e)!.split('\n');
    expect(out[14]).toBe('        return; // handled');
    expect(out[5]).toBe('        return;'); // first one untouched
  });
});

describe('resolveEditAt — indentation tolerance on the anchored path', () => {
  it('verifies oldText at the anchor even when the model dropped indentation', () => {
    // Model returned the line with NO leading spaces, but the right startLine.
    const e = edit({
      startLine: 6,
      endLine: 6,
      oldText: 'return;',
      newText: 'return; // ok',
    });
    const r = resolveEditAt(REPETITIVE, e);
    expect(r).not.toBeNull();
    expect(r!.startLine).toBe(6);
  });

  it('reindents the replacement to the file so applying never eats indentation', () => {
    const e = edit({
      startLine: 6,
      endLine: 6,
      oldText: 'return;',         // de-indented oldText
      newText: 'return false;',   // de-indented newText
    });
    const out = applyResolved(REPETITIVE, e)!.split('\n');
    // Replacement picked up the file's 8-space indent, not the model's zero.
    expect(out[5]).toBe('        return false;');
  });

  it('reindents a multi-line replacement preserving its internal relative indent', () => {
    const file = ['class C', '{', '    void M()', '    {', '        Old();', '    }', '}'].join('\n');
    const e = edit({
      startLine: 5,
      endLine: 5,
      oldText: 'Old();',
      newText: 'if (x)\n{\n    New();\n}',
    });
    const out = applyResolved(file, e)!.split('\n');
    expect(out[4]).toBe('        if (x)');
    expect(out[5]).toBe('        {');
    expect(out[6]).toBe('            New();'); // +4 relative indent preserved
    expect(out[7]).toBe('        }');
  });
});

describe('resolveEditAt — strict fallback without a line anchor', () => {
  it('applies a unique snippet with no startLine (legacy edit shape)', () => {
    const e = edit({
      oldText: 'public void A()',
      newText: 'public void A2()',
    });
    expect(editStatus(REPETITIVE, e)).toBe('ok');
    expect(applyResolved(REPETITIVE, e)!.split('\n')[0]).toBe('public void A2()');
  });

  it('REFUSES an ambiguous snippet with no anchor — never guesses', () => {
    const e = edit({
      oldText: '        return;',
      newText: '        return; // x',
    });
    expect(resolveEditAt(REPETITIVE, e)).toBeNull();
    expect(editStatus(REPETITIVE, e)).toBe('ambiguous');
  });

  it('falls back to strict search when the anchor line drifted but content is unique', () => {
    // startLine points at the wrong line, but `public void B()` is unique, so
    // strict search recovers the real location instead of refusing.
    const e = edit({
      startLine: 999,
      oldText: 'public void B()',
      newText: 'public void B2()',
    });
    const r = resolveEditAt(REPETITIVE, e);
    expect(r).not.toBeNull();
    expect(r!.startLine).toBe(10);
  });

  it('uses the anchor to pick the nearest of several strict matches', () => {
    // Anchor is wrong (so the indentation-verify misses), but among the two
    // `return;` matches it must pick the one nearest the declared line.
    const e = edit({
      startLine: 14, // nearer line 15 than line 6
      oldText: '        return;',
      newText: '        return; // near',
    });
    const r = resolveEditAt(REPETITIVE, e);
    expect(r).not.toBeNull();
    expect(r!.startLine).toBe(15);
  });
});

describe('resolveEditAt — refuse when the file drifted (regenerate, do not mis-apply)', () => {
  it('returns null and marks gone when oldText is nowhere in the file', () => {
    const e = edit({
      startLine: 6,
      oldText: '        DoSomethingThatNoLongerExists();',
      newText: '        Fixed();',
    });
    expect(resolveEditAt(REPETITIVE, e)).toBeNull();
    expect(editStatus(REPETITIVE, e)).toBe('gone');
  });

  it('refuses an empty oldText (cannot place a pure insertion blindly)', () => {
    const e = edit({ startLine: 3, oldText: '', newText: 'x' });
    expect(resolveEditAt(REPETITIVE, e)).toBeNull();
  });
});

describe('EOL / trailing-whitespace tolerance', () => {
  it('matches across CRLF files with an LF snippet and preserves CRLF endings', () => {
    const crlf = REPETITIVE.replace(/\n/g, '\r\n');
    const e = edit({
      startLine: 1,
      oldText: 'public void A()',
      newText: 'public void Renamed()',
    });
    const r = resolveEditAt(crlf, e);
    expect(r).not.toBeNull();
    // The replaced span must stop before the '\r', so the line keeps its CRLF.
    const out = crlf.slice(0, r!.start) + r!.replacement + crlf.slice(r!.end);
    expect(out.split('\r\n')[0]).toBe('public void Renamed()');
    expect(out.startsWith('public void Renamed()\r\n{')).toBe(true);
  });

  it('ignores trailing whitespace differences between snippet and file', () => {
    const file = 'a();   \nb();\n';
    const e = edit({ startLine: 1, oldText: 'a();', newText: 'a2();' });
    expect(applyResolved(file, e)).toBe('a2();\nb();\n');
  });
});

describe('needleLines — blank-line trimming', () => {
  it('drops leading and trailing blank lines so a match lands on real content', () => {
    expect(needleLines('\n\n  x  \n\n')).toEqual(['  x  ']);
  });
  it('returns empty for whitespace-only needles', () => {
    expect(needleLines('\n   \n')).toEqual([]);
  });
});

describe('strictMatches vs looseMatches', () => {
  const file = '    foo();\n    bar();\n';
  it('strict respects leading indentation', () => {
    expect(strictMatches(file, 'foo();')).toHaveLength(0); // de-indented: no strict hit
    expect(strictMatches(file, '    foo();')).toHaveLength(1);
  });
  it('loose ignores leading indentation', () => {
    expect(looseMatches(file, 'foo();')).toHaveLength(1);
  });
});

describe('isPresent — undo/applied detection is reindent-tolerant', () => {
  it('finds a replacement even if it was reindented on apply', () => {
    const file = '        return false;\n';
    expect(isPresent(file, 'return false;')).toBe(true); // de-indented needle still found
  });
  it('is false for empty needle', () => {
    expect(isPresent('anything', '')).toBe(false);
  });
});

describe('reindentToFile', () => {
  it('rebases outer indent to the file line while keeping inner structure', () => {
    const file = '        anchor\n';
    const out = reindentToFile(file, { start: 0, end: 14 }, 'if (a)\n    b()');
    expect(out).toBe('        if (a)\n            b()');
  });
  it('passes blank lines through without indenting them', () => {
    const file = '    x\n';
    const out = reindentToFile(file, { start: 0, end: 5 }, 'a\n\nb');
    expect(out).toBe('    a\n\n    b');
  });

  it('leaves a block already at the file indent unchanged (verbatim-string safe)', () => {
    // A method body containing column-0 lines (a @"..." verbatim string with
    // markdown at the left margin). Its first line already sits at the file's
    // indent, so reindent must return it VERBATIM — not add the anchor indent to
    // every line (which would corrupt the string content). This was the bug
    // behind 「apply #1, undo, #2 无法应用」.
    const file = '            return @"\n# Title\n- item\n";\n';
    const block = '            return @"\n# Title\n- item\n";';
    expect(reindentToFile(file, { start: 0, end: 20 }, block)).toBe(block);
  });
});

describe('apply + undo round-trip (overlapping alternatives)', () => {
  // Mirrors the SwaggerConfig.cs case: a verbatim-string method body with
  // column-0 content, two alternative proposals that both touch that region.
  const FILE = [
    'public static class SwaggerConfig',        // 1
    '{',                                        // 2
    '    public static string GetDoc()',        // 3
    '    {',                                    // 4
    '        return @"',                        // 5
    '# Dawning Gateway',                        // 6  (column 0 — inside the string)
    '- Authentication',                         // 7  (column 0)
    '- User Management',                        // 8  (column 0)
    '";',                                       // 9
    '    }',                                     // 10
    '}',                                        // 11
  ].join('\n');

  // Proposal 1: translate the doc body. Anchored at the verbatim block (5–9),
  // with the model preserving the file's real indentation.
  const proposal1 = {
    startLine: 5,
    endLine: 9,
    oldText: '        return @"\n# Dawning Gateway\n- Authentication\n- User Management\n";',
    newText: '        return @"\n# 曙光网关\n- 身份认证\n- 用户管理\n";',
  };

  function apply(text: string, e: typeof proposal1): string {
    const r = resolveEditAt(text, e);
    expect(r).not.toBeNull();
    return text.slice(0, r!.start) + r!.replacement + text.slice(r!.end);
  }

  it('apply then undo restores the file byte-for-byte', () => {
    const afterApply = apply(FILE, proposal1);
    // Undo = the reversed edit, carrying the same line anchor (what the panel does).
    const afterUndo = apply(afterApply, {
      startLine: proposal1.startLine,
      endLine: proposal1.endLine,
      oldText: proposal1.newText,
      newText: proposal1.oldText,
    });
    expect(afterUndo).toBe(FILE);
  });

  it('a second overlapping proposal still applies after apply+undo of the first', () => {
    const afterApply = apply(FILE, proposal1);
    const afterUndo = apply(afterApply, {
      startLine: proposal1.startLine,
      endLine: proposal1.endLine,
      oldText: proposal1.newText,
      newText: proposal1.oldText,
    });
    // Proposal 2: remove the whole verbatim block (an alternative fix). Its
    // oldText is verbatim from the ORIGINAL file; it must still resolve once the
    // first proposal has been undone.
    const proposal2 = {
      startLine: 5,
      endLine: 9,
      oldText: '        return @"\n# Dawning Gateway\n- Authentication\n- User Management\n";',
      newText: '        return string.Empty;',
    };
    expect(resolveEditAt(afterUndo, proposal2)).not.toBeNull();
  });
});

describe('hashContent — drift detection', () => {
  it('is stable for identical content', () => {
    expect(hashContent('abc\n123')).toBe(hashContent('abc\n123'));
  });
  it('changes when content changes', () => {
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
  it('distinguishes same-prefix different-length payloads (length is mixed in)', () => {
    expect(hashContent('aaaa')).not.toBe(hashContent('aaaaa'));
  });
});
