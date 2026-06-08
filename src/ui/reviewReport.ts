import type { Finding, GlobalReport } from '../ai/types';
import type { Annotation, FindingDisposition, ReviewConclusion } from '../review/reviewStore';
import type { Messages } from '../i18n/en';

/** Everything the report needs about one file in the review set. */
export interface ReportFile {
  path: string;
  findings: Finding[];
  /** Disposition per finding id, when the reviewer acted on it. */
  disposition: (findingId: string) => FindingDisposition | undefined;
  annotations: Annotation[];
}

/** Inputs for {@link buildReviewReportMarkdown}. */
export interface ReportData {
  repo: string;
  scopeLabel: string;
  generatedAt: number;
  coverage: { seen: number; total: number; filesReady: number; filesTotal: number };
  files: ReportFile[];
  globalReport?: GlobalReport;
  conclusion?: ReviewConclusion;
}

function sevLabel(t: Messages['report'], s: Finding['severity']): string {
  return s === 'bug' ? t.sevBug : s === 'conditional' ? t.sevConditional : t.sevSuggestion;
}

function dispLabel(t: Messages['report'], d: FindingDisposition | undefined): string {
  if (!d) {
    return t.dispositionOpen;
  }
  return d.kind === 'fixed'
    ? t.dispositionFixed
    : d.kind === 'commented'
      ? t.dispositionCommented
      : t.dispositionIgnored;
}

function noteKind(t: Messages['report'], k: Annotation['kind']): string {
  return k === 'translate' ? t.noteKindTranslate : k === 'explain' ? t.noteKindExplain : t.noteKindNote;
}

function fmtDate(ms: number): string {
  // Local, human-readable timestamp; locale-agnostic ISO-ish without the T/Z.
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Assembles a self-contained Markdown report from a review's persisted state:
 * a summary, every finding grouped by file with its disposition, reviewer
 * notes/explanations, the global analysis (if run) and the final conclusion.
 * Pure string assembly — no IO — so it is trivially testable.
 */
export function buildReviewReportMarkdown(data: ReportData, t: Messages['report']): string {
  const lines: string[] = [];
  const totalFindings = data.files.reduce((n, f) => n + f.findings.length, 0);
  const unhandled = data.files.reduce(
    (n, f) => n + f.findings.filter((x) => !f.disposition(x.id)).length,
    0,
  );

  lines.push(`# ${t.title}`, '');
  lines.push(`- **${t.repo}**: ${data.repo}`);
  lines.push(`- **${t.scope}**: ${data.scopeLabel}`);
  lines.push(`- **${t.generatedAt}**: ${fmtDate(data.generatedAt)}`, '');

  // Summary -------------------------------------------------------------------
  lines.push(`## ${t.summary}`, '');
  lines.push(`- ${t.filesLine(data.coverage.filesReady, data.coverage.filesTotal)}`);
  lines.push(`- ${t.coverageLine(data.coverage.seen, data.coverage.total)}`);
  lines.push(`- ${t.findingsLine(totalFindings)}`);
  lines.push(`- ${t.unhandledLine(unhandled)}`, '');

  // Findings by file ----------------------------------------------------------
  lines.push(`## ${t.filesHeading}`, '');
  if (totalFindings === 0) {
    lines.push(t.noFindings, '');
  } else {
    for (const f of data.files) {
      if (f.findings.length === 0 && f.annotations.length === 0) {
        continue;
      }
      lines.push(`### \`${f.path}\``, '');
      if (f.findings.length === 0) {
        lines.push(t.noFindingsInFile, '');
      }
      for (const finding of f.findings) {
        const d = f.disposition(finding.id);
        lines.push(
          `- **[${sevLabel(t, finding.severity)}] ${finding.title}** — ${t.line(finding.line)} · _${dispLabel(t, d)}_`,
        );
        if (finding.detail) {
          lines.push(`  - ${finding.detail.replace(/\n+/g, ' ')}`);
        }
        if (finding.suggestion) {
          lines.push(`  - 💡 ${finding.suggestion.replace(/\n+/g, ' ')}`);
        }
        if (d?.reason) {
          lines.push(`  - ${t.reason}: ${d.reason.replace(/\n+/g, ' ')}`);
        }
      }
      // Per-file notes / explanations
      if (f.annotations.length > 0) {
        lines.push('', `**${t.notesHeading}**`, '');
        for (const a of f.annotations) {
          const where = a.startLine > 0 ? ` (${t.line(a.startLine)})` : '';
          lines.push(`- _${noteKind(t, a.kind)}${where}_: ${a.content.replace(/\n+/g, ' ')}`);
        }
      }
      lines.push('');
    }
  }

  // Global analysis -----------------------------------------------------------
  if (data.globalReport) {
    const g = data.globalReport;
    lines.push(`## ${t.globalHeading}`, '');
    if (g.conclusion) {
      lines.push(g.conclusion, '');
    }
    lines.push(`- **${t.recommendation}**: ${g.recommendation}`, '');
    if (g.evidence.length > 0) {
      lines.push(`**${t.evidence}**`, '');
      for (const e of g.evidence) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }
  }

  // Conclusion ----------------------------------------------------------------
  lines.push(`## ${t.conclusionHeading}`, '');
  if (data.conclusion) {
    const c = data.conclusion;
    lines.push(`- **${t.verdict}**: ${c.label}`);
    const target = c.target === 'pr' && c.prNumber ? t.targetPr(c.prNumber) : t.targetLocal;
    lines.push(`- **${t.target}**: ${target}`);
    lines.push(`- **${t.generatedAt}**: ${fmtDate(c.submittedAt)}`, '');
  } else {
    lines.push(t.notSubmitted, '');
  }

  return lines.join('\n');
}
