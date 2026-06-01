import * as vscode from 'vscode';
import type { Finding, FindingSeverity, GlobalFixSpot, GlobalReport } from './types';

/** Raised when analysis cannot complete; message is user-facing. */
export class AnalysisError extends Error {}

const FILE_SYSTEM_PROMPT = `你是一名严格的资深代码审查员。审查给定源码文件的逻辑、正确性、并发与安全问题。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：{"findings":[{"line":<1基行号>,"endLine":<可选>,"severity":"bug"|"conditional"|"suggestion","title":"简短标题","detail":"问题与证据","suggestion":"可选的修复建议"}]}
severity 含义：bug=确定缺陷；conditional=特定条件下才出问题；suggestion=可选改进。
没有问题就返回 {"findings":[]}。行号必须对应所给文件的真实行。`;

const GLOBAL_SYSTEM_PROMPT = `你是一名严格的资深代码审查员，负责跨文件的全局逻辑分析。
基于给定的文件清单与各文件的发现，给出跨文件结论、证据链与具体修复落点。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：{"conclusion":"一句话跨文件结论","evidence":["证据1","证据2"],"fixSpots":[{"file":"相对路径","line":<1基行号>,"severity":"bug"|"conditional"|"suggestion","title":"标题","detail":"说明","suggestion":"可选修复"}]}
若无跨文件问题，conclusion 说明无重大问题，fixSpots 返回 []。`;

async function ask(
  model: vscode.LanguageModelChat,
  system: string,
  user: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const messages = [
    vscode.LanguageModelChatMessage.User(system),
    vscode.LanguageModelChatMessage.User(user),
  ];
  let out = '';
  try {
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      out += chunk;
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      throw new AnalysisError(`模型调用失败：${err.message}`);
    }
    throw err;
  }
  return out;
}

/** Strips markdown fences and parses the first JSON object in the text. */
function parseJson<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    t = fence[1].trim();
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new AnalysisError('无法解析模型返回的 JSON。');
  }
}

function normaliseSeverity(value: unknown): FindingSeverity {
  return value === 'bug' || value === 'conditional' || value === 'suggestion'
    ? value
    : 'suggestion';
}

function numberifyLines(text: string): string {
  return text
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n');
}

/** Runs file-level analysis on a document, returning normalised findings. */
export async function analyzeFile(
  model: vscode.LanguageModelChat,
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
): Promise<Finding[]> {
  const numbered = numberifyLines(document.getText());
  const user = `文件路径：${document.uri.fsPath}\n语言：${document.languageId}\n以下每行以「行号<TAB>内容」给出：\n\n${numbered}`;
  const raw = await ask(model, FILE_SYSTEM_PROMPT, user, token);
  const parsed = parseJson<{ findings?: unknown[] }>(raw);
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  const lineCount = document.lineCount;
  return list.map((f, i) => {
    const o = f as Record<string, unknown>;
    const line = clampLine(Number(o.line) || 1, lineCount);
    return {
      id: `f${i}`,
      line,
      endLine: o.endLine ? clampLine(Number(o.endLine), lineCount) : undefined,
      severity: normaliseSeverity(o.severity),
      title: String(o.title ?? '未命名问题'),
      detail: String(o.detail ?? ''),
      suggestion: o.suggestion ? String(o.suggestion) : undefined,
    } satisfies Finding;
  });
}

/** Context fed to global analysis: each file plus its file-level findings. */
export interface GlobalContextFile {
  path: string;
  findings: Finding[];
}

/** Runs cross-file global analysis over the review set. */
export async function analyzeGlobal(
  model: vscode.LanguageModelChat,
  files: GlobalContextFile[],
  token: vscode.CancellationToken,
): Promise<GlobalReport> {
  const summary = files
    .map((f) => {
      const findings = f.findings.length
        ? f.findings.map((x) => `  - [${x.severity}] L${x.line} ${x.title}`).join('\n')
        : '  - （文件级未发现问题）';
      return `文件：${f.path}\n${findings}`;
    })
    .join('\n\n');
  const user = `审查集共 ${files.length} 个文件。各文件与其文件级发现如下：\n\n${summary}\n\n请给出跨文件的全局逻辑分析。`;
  const raw = await ask(model, GLOBAL_SYSTEM_PROMPT, user, token);
  const parsed = parseJson<{
    conclusion?: string;
    evidence?: unknown[];
    fixSpots?: unknown[];
  }>(raw);
  const fixSpots: GlobalFixSpot[] = (Array.isArray(parsed.fixSpots) ? parsed.fixSpots : []).map(
    (f, i) => {
      const o = f as Record<string, unknown>;
      return {
        id: `g${i}`,
        file: String(o.file ?? ''),
        line: Math.max(1, Number(o.line) || 1),
        severity: normaliseSeverity(o.severity),
        title: String(o.title ?? '未命名问题'),
        detail: String(o.detail ?? ''),
        suggestion: o.suggestion ? String(o.suggestion) : undefined,
      } satisfies GlobalFixSpot;
    },
  );
  return {
    conclusion: String(parsed.conclusion ?? '无重大跨文件问题。'),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((e) => String(e)),
    fixSpots,
  };
}

function clampLine(line: number, max: number): number {
  if (!Number.isFinite(line) || line < 1) {
    return 1;
  }
  return Math.min(Math.floor(line), Math.max(1, max));
}
