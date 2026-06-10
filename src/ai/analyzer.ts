import * as vscode from 'vscode';
import type {
  Finding,
  FindingSeverity,
  GlobalFixSpot,
  GlobalRecommendation,
  GlobalReport,
  GlobalVerdict,
  VerdictKind,
} from './types';
import { languageDirective } from './lang';
import { m } from '../i18n';

/** Raised when analysis cannot complete; message is user-facing. */
export class AnalysisError extends Error {}

/** The kind of LLM operation, used to bucket token usage by purpose. */
export type LlmOp = 'analyze' | 'global' | 'fix' | 'diff' | 'translate' | 'explain';

/** A single LLM call's estimated token usage. Estimated locally via `countTokens`. */
export interface TokenUsage {
  op: LlmOp;
  /** Estimated input tokens (system + user). */
  input: number;
  /** Estimated output tokens. */
  output: number;
}

/**
 * Optional sink that receives an estimated token-usage record after each LLM
 * call. Wired by the host (extension.ts) so usage can be accumulated on the
 * review session. Estimation uses `model.countTokens`, so totals are an
 * approximation — they are NOT the provider's billed token counts.
 */
export type TokenUsageSink = (usage: TokenUsage) => void;

let usageSink: TokenUsageSink | undefined;

/** Registers the token-usage sink. Pass `undefined` to detach. */
export function setTokenUsageSink(sink: TokenUsageSink | undefined): void {
  usageSink = sink;
}

/**
 * Best-effort token estimate for a string against the given model. Returns 0 on
 * any failure (countTokens can throw / be unavailable) so accounting never
 * breaks the primary analysis flow.
 */
async function estimateTokens(model: vscode.LanguageModelChat, text: string): Promise<number> {
  try {
    return await model.countTokens(text);
  } catch {
    return 0;
  }
}


const FILE_SYSTEM_PROMPT = `你是一名严格的资深代码审查员。审查给定源码文件的逻辑、正确性、并发与安全问题。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：{"findings":[{"line":<1基行号>,"endLine":<可选>,"anchor":"问题所在的原始代码片段（逐字、不含行号前缀，连续一到数行且在文件中能唯一定位）","severity":"bug"|"conditional"|"suggestion","title":"简短标题","detail":"问题与证据","suggestion":"可选的修复建议"}]}
severity 含义：bug=确定缺陷；conditional=特定条件下才出问题；suggestion=可选改进。
title 必填：一句话概括问题本身（≤8 字为佳），不得为空、不得用“问题”“缺陷”等笼统占位词。
anchor 必须逐字摘自源码（去掉「行号<TAB>」前缀），用于按内容定位，请尽量唯一；如确实无法给出就省略。
没有问题就返回 {"findings":[]}。行号必须对应所给文件的真实行。`;

const GLOBAL_SYSTEM_PROMPT = `你是一名严格的资深代码审查员，负责跨文件的全局逻辑分析。
文件级审查只看单文件，会产生"如果/可能"级别的猜测。你的职责是用跨文件事实（DI 生命周期、调用图、架构层边界、PR 意图是否兑现）把这些猜测落地成"确证 / 推翻 / 新发现"。
只输出 JSON，不要任何解释文字或 markdown 代码围栏。
JSON 结构：
{
  "conclusion": "一句话整体风险表态：点明这批改动能否放心提交，以及最大的残余风险点",
  "recommendation": "approve" | "request_changes" | "comment",
  "evidence": ["按顺序的证据链步骤1", "步骤2", "步骤3"],
  "verdicts": [
    {
      "kind": "flip" | "found" | "confirmed",
      "title": "简短标题",
      "before": "文件级当初怎么说（片面判断）",
      "after": "跨文件事实确立了什么",
      "evidence": "具体代码/文件证据，如 Program.cs:47 AddScoped<...>",
      "file": "相对路径（可选，用于定位）",
      "line": <1基行号，可选>
    }
  ],
  "fixSpots": [
    {"file":"相对路径","line":<1基行号>,"severity":"bug"|"conditional"|"suggestion","title":"标题","detail":"说明","suggestion":"可选修复"}
  ]
}
verdict.kind 含义：flip=文件级判断被推翻（误报）；found=只有跨文件才看得到的真问题（文件级漏报）；confirmed=跨文件事实确证文件级判断成立。
所有 title 必填：verdict 与 fixSpot 的 title 都要一句话概括该项本身，不得为空、不得用笼统占位词。
recommendation 是 AI 对这批改动的整体表态：approve=可放心提交；request_changes=存在应先处理的问题；comment=有保留意见但不阻塞。
conclusion 与 recommendation 必须一致：存在 found 级问题时不应 approve。
若无跨文件问题，conclusion 说明无重大问题，recommendation 用 "approve"，verdicts/fixSpots 返回 []。`;

async function ask(
  model: vscode.LanguageModelChat,
  system: string,
  user: string,
  token: vscode.CancellationToken,
  options: { skipLanguageDirective?: boolean; op?: LlmOp } = {},
): Promise<string> {
  const fullSystem = options.skipLanguageDirective
    ? system
    : `${languageDirective()}\n\n${system}`;
  const messages = [
    vscode.LanguageModelChatMessage.User(fullSystem),
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
      throw new AnalysisError(m().analyzer.modelCallFailed(err.message));
    }
    throw err;
  }
  // Estimate and report token usage after a successful call. The VS Code LM API
  // does not expose billed usage, so we approximate via countTokens; failures
  // here must never disturb the analysis result.
  if (usageSink && options.op && !token.isCancellationRequested) {
    const op = options.op;
    void (async () => {
      const [input, output] = await Promise.all([
        estimateTokens(model, fullSystem).then(async (s) => s + (await estimateTokens(model, user))),
        estimateTokens(model, out),
      ]);
      usageSink?.({ op, input, output });
    })();
  }
  return out;
}

/** Translates arbitrary text to the active UI language, returning the plain result. */
export async function translateSelection(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    `${languageDirective()}\n\n` +
    "You are a professional technical translator. Translate the user's content into the target language stated above, " +
    'keeping code identifiers and domain terms verbatim. Output only the translation — no explanation, quotes, or markdown fences.';
  const out = await ask(model, system, text, token, { skipLanguageDirective: true, op: 'translate' });
  return out.trim();
}

/** Explains a snippet of code, returning plain prose in the configured language. */
export async function explainCode(
  model: vscode.LanguageModelChat,
  code: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const system =
    '你是资深代码审查助手。解释用户给出的这段代码：它做什么、关键逻辑/控制流、涉及的副作用或边界条件，以及可能值得注意的风险点。' +
    '语言简洁专业，可用短句或最多 3-5 条要点。只输出解释正文，不要复述原代码，不要 markdown 标题或代码围栏。';
  const out = await ask(model, system, code, token, { op: 'explain' });
  return out.trim();
}

function extractBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/** Strips markdown fences and parses a JSON object from model output. */
function parseJson<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) {
    candidates.push(fence[1].trim());
  }
  candidates.push(t);
  const balancedObjects: string[] = [];
  for (let start = t.indexOf('{'); start >= 0; start = t.indexOf('{', start + 1)) {
    const object = extractBalancedObject(t, start);
    if (object) {
      balancedObjects.push(object);
    }
  }
  candidates.push(...balancedObjects.sort((a, b) => b.length - a.length));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next plausible JSON object before surfacing a user-facing error.
    }
  }
  const preview = t.replace(/\s+/g, ' ').slice(0, 500);
  throw new AnalysisError(m().analyzer.jsonParseFailed(preview, t.length > 500));
}

function normaliseSeverity(value: unknown): FindingSeverity {
  return value === 'bug' || value === 'conditional' || value === 'suggestion'
    ? value
    : 'suggestion';
}

/**
 * Resolves a finding/verdict title defensively. The model occasionally returns a
 * null/blank `title` while still giving a useful `detail`; rather than showing a
 * bare "未命名问题" placeholder, derive a short title from the detail's first
 * sentence (CJK or ASCII punctuation), capped to a readable length. Falls back to
 * the placeholder only when there is no detail to derive from.
 */
function deriveTitle(title: unknown, detail: unknown, fallback: string): string {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t) {
    return t;
  }
  const d = typeof detail === 'string' ? detail.trim() : '';
  if (d) {
    const firstSentence = d.split(/(?<=[\u3002\uff01\uff1f.!?])\s*/)[0] ?? d;
    const oneLine = firstSentence.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
  }
  return fallback;
}

function normaliseVerdictKind(value: unknown): VerdictKind {
  return value === 'flip' || value === 'found' || value === 'confirmed' ? value : 'confirmed';
}

function normaliseRecommendation(value: unknown): GlobalRecommendation {
  return value === 'approve' || value === 'request_changes' || value === 'comment'
    ? value
    : 'comment';
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
  const raw = await ask(model, FILE_SYSTEM_PROMPT, user, token, { op: 'analyze' });
  const parsed = parseJson<{ findings?: unknown[] }>(raw);
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  const lineCount = document.lineCount;
  return list.map((f, i) => {
    const o = f as Record<string, unknown>;
    const line = clampLine(Number(o.line) || 1, lineCount);
    const anchor = typeof o.anchor === 'string' && o.anchor.trim() ? o.anchor : undefined;
    return {
      id: `f${i}`,
      line,
      endLine: o.endLine ? clampLine(Number(o.endLine), lineCount) : undefined,
      anchor,
      severity: normaliseSeverity(o.severity),
      title: deriveTitle(o.title, o.detail, m().analyzer.untitledFinding),
      detail: String(o.detail ?? ''),
      suggestion: o.suggestion ? String(o.suggestion) : undefined,
    } satisfies Finding;
  });
}

/** Context fed to global analysis: each file plus its file-level findings. */
export interface GlobalContextFile {
  path: string;
  findings: Finding[];
  /** Full source text of the file, so the model can resolve cross-file facts. */
  content: string;
}

/** Caps per-file source sent to the model so a few large files can't blow the context. */
const MAX_FILE_CHARS = 16_000;

/** Caps the total source budget across all files in one global request. */
const MAX_TOTAL_CHARS = 120_000;

/** Runs cross-file global analysis over the review set. */
export async function analyzeGlobal(
  model: vscode.LanguageModelChat,
  files: GlobalContextFile[],
  token: vscode.CancellationToken,
): Promise<GlobalReport> {
  const perFileBudget = Math.max(
    1,
    Math.min(MAX_FILE_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, files.length))),
  );
  const sections = files.map((f) => {
    const findings = f.findings.length
      ? f.findings.map((x) => `  - [${x.severity}] L${x.line} ${x.title}`).join('\n')
      : '  - （文件级未发现问题）';

    let source = f.content ?? '';
    let truncated = source.length > perFileBudget;
    if (truncated) {
      source = source.slice(0, perFileBudget);
    }

    const numbered = source ? numberifyLines(source) : '（源码不可用）';
    const note = truncated ? '\n…（源码因长度被截断）' : '';
    return `文件：${f.path}\n文件级发现：\n${findings}\n源码（行号<TAB>内容）：\n${numbered}${note}`;
  });
  const summary = sections.join('\n\n----\n\n');
  const user = `审查集共 ${files.length} 个文件。请基于下面每个文件的真实源码与文件级发现，给出跨文件的全局逻辑分析。务必依据源码中可见的事实（DI 注册、调用关系、配置键、分层依赖）作出判断，不要臆测。\n\n${summary}`;
  const raw = await ask(model, GLOBAL_SYSTEM_PROMPT, user, token, { op: 'global' });
  const parsed = parseJson<{
    conclusion?: string;
    recommendation?: string;
    evidence?: unknown[];
    verdicts?: unknown[];
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
        title: deriveTitle(o.title, o.detail, m().analyzer.untitledFinding),
        detail: String(o.detail ?? ''),
        suggestion: o.suggestion ? String(o.suggestion) : undefined,
      } satisfies GlobalFixSpot;
    },
  );
  const verdicts: GlobalVerdict[] = (Array.isArray(parsed.verdicts) ? parsed.verdicts : []).map(
    (v) => {
      const o = v as Record<string, unknown>;
      return {
        kind: normaliseVerdictKind(o.kind),
        title: deriveTitle(o.title, o.after ?? o.before, m().analyzer.untitledVerdict),
        before: String(o.before ?? ''),
        after: String(o.after ?? ''),
        evidence: o.evidence ? String(o.evidence) : undefined,
        file: o.file ? String(o.file) : undefined,
        line: o.line ? Math.max(1, Number(o.line)) : undefined,
      } satisfies GlobalVerdict;
    },
  );
  return {
    conclusion: String(parsed.conclusion ?? m().analyzer.noCrossFileIssues),
    recommendation: normaliseRecommendation(parsed.recommendation),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((e) => String(e)),
    verdicts,
    fixSpots,
  };
}

function clampLine(line: number, max: number): number {
  if (!Number.isFinite(line) || line < 1) {
    return 1;
  }
  return Math.min(Math.floor(line), Math.max(1, max));
}

const DIFF_SYSTEM_PROMPT = `你是一名资深工程师，为指定的修复落点生成一个可直接套用的统一 diff（unified diff）。
只输出 diff 文本，使用标准 \`---\`/\`+++\`/\`@@\` 头与 +/- 行，不要任何解释、不要 markdown 代码围栏。
保持改动最小、聚焦本问题，行号尽量贴合给定源码。`;

/** Generates a candidate unified diff for a fix spot, given the file content. */
export async function generateFixDiff(
  model: vscode.LanguageModelChat,
  fileRelPath: string,
  fileContent: string,
  fix: { title: string; detail: string; suggestion?: string; line: number },
  token: vscode.CancellationToken,
): Promise<string> {
  const user = `文件：${fileRelPath}
修复落点：${fix.title}（第 ${fix.line} 行附近）
问题说明：${fix.detail}
${fix.suggestion ? `建议方向：${fix.suggestion}\n` : ''}
完整源码如下：

${fileContent}

请生成针对该文件的统一 diff。`;
  const raw = await ask(model, DIFF_SYSTEM_PROMPT, user, token, { op: 'diff' });
  let t = raw.trim();
  const fence = t.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i);
  if (fence) {
    t = fence[1].trim();
  }
  return t;
}

/** A single precise replacement inside a file. */
export interface FixEdit {
  /** Exact substring of the current file content; must appear once. */
  oldText: string;
  /** Replacement text; may be empty (pure deletion). */
  newText: string;
}

/**
 * A single fix proposal: one or more coordinated in-file replacements applied
 * together as one solution, plus its rationale. Multiple proposals are mutually
 * exclusive alternatives; multiple `edits` inside one proposal are applied and
 * reverted as a unit.
 */
export interface FixProposal {
  title: string;
  rationale: string;
  /** One or more edits applied together. */
  edits: FixEdit[];
}

const FIX_PROPOSALS_SYSTEM_PROMPT = `你是一名资深工程师。给你一个源码文件以及一个针对某一行附近的代码审查发现，请提出修复方案。
- 由你判断给出几个方案（1 到 3 个），优先质量而非数量；如果只有一种合理改法就只给 1 个。
- **多个方案之间是互斥的备选**：用户只会选其中一个应用。不要把「同一个修复的多个步骤」拆成多个方案。
- **一个方案可以包含多处改动**：如果正确的修复需要同时改动文件里的多个位置，就把它们全部放进同一个方案的 edits 数组里 —— 它们会被一起应用、一起撤销，作为一个完整解决方案。
- 每处改动都是「精确字符串替换」：oldText 取自当前文件、是连续若干行且在文件中只出现一次；newText 是替换后的内容（可以为空字符串表示删除）。
- 同一个方案内的多处 edits 不要相互重叠。
- **只修复本次发现指向的那段代码**：如果用户给出了「问题代码」原文，你的 oldText 必须落在这段代码（或紧邻的上下文）上，不要去改文件里其它看起来类似但与本发现无关的位置。
- oldText 不要取得太大；只覆盖真正需要改的最小连续片段，但要留足上下文使其唯一定位。
- 不要修改与本问题无关的格式或行尾空白。
- 行号语义：用户给你的源码每行以「行号<TAB>内容」前缀；oldText/newText 只填「内容」部分，**不要带行号前缀**。
只输出 JSON，不要解释、不要 markdown 围栏：
{"proposals":[{"title":"一句话方案名","rationale":"为什么这样改、有什么 trade-off","edits":[{"oldText":"...","newText":"..."}]}]}`;

/** Generates 1–N fix proposals for a finding; each is a precise oldText→newText edit. */
export async function generateFixProposals(
  model: vscode.LanguageModelChat,
  fileRelPath: string,
  fileContent: string,
  finding: { title: string; detail: string; suggestion?: string; line: number; endLine?: number; anchor?: string },
  token: vscode.CancellationToken,
  userContext?: string,
): Promise<FixProposal[]> {
  const numbered = numberifyLines(fileContent);
  const range = finding.endLine && finding.endLine > finding.line
    ? `第 ${finding.line}-${finding.endLine} 行`
    : `第 ${finding.line} 行附近`;
  const anchorBlock = finding.anchor
    ? `问题代码（务必只修复这段，不要改到文件里其它类似位置）：\n${finding.anchor}\n\n`
    : '';
  // The reviewer's supplementary note carries the highest authority: it may
  // correct or constrain the model's original judgment, so place it prominently.
  const supplement = userContext && userContext.trim()
    ? `审查者补充（权威，请据此修正或约束你的方案；如与「问题说明」冲突，以本补充为准）：\n${userContext.trim()}\n\n`
    : '';
  const user = `文件：${fileRelPath}
审查发现：${finding.title}（${range}）
问题说明：${finding.detail}
${finding.suggestion ? `建议方向：${finding.suggestion}\n` : ''}
${supplement}${anchorBlock}源码（每行以「行号<TAB>内容」给出）：

${numbered}

请按上述 JSON 结构给出修复方案。`;
  const raw = await ask(model, FIX_PROPOSALS_SYSTEM_PROMPT, user, token, { op: 'fix' });
  const parsed = parseJson<{ proposals?: unknown[] }>(raw);
  const list = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  const out: FixProposal[] = [];
  for (const p of list) {
    const o = p as Record<string, unknown>;
    const edits = parseFixEdits(o);
    if (edits.length === 0) {
      continue;
    }
    out.push({
      title: String(o.title ?? m().analyzer.fixProposalTitle).trim() || m().analyzer.fixProposalTitle,
      rationale: String(o.rationale ?? '').trim(),
      edits,
    });
  }
  if (out.length === 0) {
    throw new AnalysisError(m().analyzer.noFixProposals);
  }
  return out;
}

/**
 * Extracts the edit list from a raw proposal object. Accepts the new `edits`
 * array shape and falls back to a single top-level `oldText`/`newText` pair so
 * older model outputs still parse. Drops edits without an `oldText`.
 */
function parseFixEdits(o: Record<string, unknown>): FixEdit[] {
  const rawEdits = Array.isArray(o.edits)
    ? o.edits
    : typeof o.oldText === 'string'
      ? [{ oldText: o.oldText, newText: o.newText }]
      : [];
  const edits: FixEdit[] = [];
  for (const e of rawEdits) {
    const eo = e as Record<string, unknown>;
    const oldText = typeof eo.oldText === 'string' ? eo.oldText : '';
    const newText = typeof eo.newText === 'string' ? eo.newText : '';
    if (oldText) {
      edits.push({ oldText, newText });
    }
  }
  return edits;
}
