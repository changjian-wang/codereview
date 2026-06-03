import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { esc as escapeHtml } from './html';

/** Rendered representation of a review file, ready for the document webview. */
export interface DocumentRender {
  /** True when the file is markdown and a reading view is available. */
  isMarkdown: boolean;
  /** Reading-friendly HTML (markdown only), with no raw markdown syntax. */
  readingHtml?: string;
  /** Per-source-line highlighted HTML; index 0 is line 1. */
  sourceLines: string[];
  /** Total number of source lines (drives coverage). */
  totalLines: number;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through to default escaping */
      }
    }
    return '';
  },
});

/** Maps VS Code languageIds / extensions to highlight.js language names. */
const LANG_ALIAS: Record<string, string> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  csharp: 'csharp',
  'c#': 'csharp',
  cpp: 'cpp',
  c: 'c',
  python: 'python',
  java: 'java',
  go: 'go',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  shellscript: 'bash',
  powershell: 'powershell',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  xml: 'xml',
  html: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  ini: 'ini',
  toml: 'ini',
};

function resolveLanguage(languageId: string, fileName: string): string | undefined {
  const byId = LANG_ALIAS[languageId];
  if (byId && hljs.getLanguage(byId)) {
    return byId;
  }
  if (hljs.getLanguage(languageId)) {
    return languageId;
  }
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  const byExt = LANG_ALIAS[ext];
  if (byExt && hljs.getLanguage(byExt)) {
    return byExt;
  }
  return hljs.getLanguage(ext) ? ext : undefined;
}

/**
 * Splits highlight.js output (which may contain spans crossing newlines) into
 * one self-contained HTML string per source line, re-opening any spans that
 * are still open at a line break so each line renders correctly on its own.
 */
function splitHighlightedLines(html: string): string[] {
  const lines = html.split('\n');
  const result: string[] = [];
  let open: string[] = [];
  const tagRe = /<span[^>]*>|<\/span>/g;

  for (const line of lines) {
    const prefix = open.join('');
    const stack = [...open];
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(line))) {
      if (m[0] === '</span>') {
        stack.pop();
      } else {
        stack.push(m[0]);
      }
    }
    const suffix = '</span>'.repeat(stack.length);
    result.push(prefix + line + suffix);
    open = stack;
  }
  return result;
}

function highlightToLines(text: string, language: string | undefined): string[] {
  let value: string;
  try {
    value = language
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(text).value;
  } catch {
    value = escapeHtml(text);
  }
  return splitHighlightedLines(value);
}

/** Renders a file's text into reading HTML (markdown) and highlighted lines. */
export function renderDocument(text: string, languageId: string, fileName: string): DocumentRender {
  const isMarkdown = languageId === 'markdown' || /\.(md|markdown)$/i.test(fileName);
  const rawLines = text.split(/\r?\n/);
  const language = resolveLanguage(languageId, fileName);
  const sourceLines = highlightToLines(text, language);

  // Keep one highlighted entry per raw line so coverage line numbers line up.
  while (sourceLines.length < rawLines.length) {
    sourceLines.push('');
  }

  return {
    isMarkdown,
    readingHtml: isMarkdown ? renderMarkdownReading(text) : undefined,
    sourceLines: sourceLines.slice(0, rawLines.length),
    totalLines: rawLines.length,
  };
}

/**
 * Renders markdown for the reading view. Leading YAML front matter (a `---`
 * fenced block at the very top) is shown as a highlighted YAML code block rather
 * than being parsed as markdown, where its closing `---` would otherwise be
 * misread as a setext heading and bold the whole block.
 */
function renderMarkdownReading(text: string): string {
  const fm = extractFrontMatter(text);
  if (!fm) {
    return md.render(text);
  }
  const highlighted = hljs.getLanguage('yaml')
    ? hljs.highlight(fm.yaml, { language: 'yaml', ignoreIllegals: true }).value
    : escapeHtml(fm.yaml);
  const block = `<pre class="frontmatter"><code class="hljs language-yaml">${highlighted}</code></pre>\n`;
  return block + md.render(fm.body);
}

/** Splits leading `---` … `---` YAML front matter from the markdown body. */
function extractFrontMatter(text: string): { yaml: string; body: string } | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return undefined;
  }
  return { yaml: match[1], body: text.slice(match[0].length) };
}
