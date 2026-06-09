import * as vscode from 'vscode';
import { esc, nonce as makeNonce } from '../ui/html';
import { m } from '../i18n';

/** Options for {@link pickScopeTree}. */
export interface ScopeTreeOptions {
  /** Human label of the locked project root (e.g. the folder name). */
  rootLabel: string;
  /** Every reviewable file under the root, as root-relative POSIX paths. */
  relPaths: string[];
  /**
   * Editor column to open in. Pass the workbench's own column so the picker
   * opens in the SAME window — otherwise ViewColumn.Active can land it in the
   * parent window when the workbench lives in an auxiliary window.
   */
  viewColumn?: vscode.ViewColumn;
}

/**
 * Opens a self-contained webview file-tree picker that is *locked* to the
 * project root: the tree is built purely from `relPaths` (all under the root),
 * so there is no way to navigate or select anything outside it — unlike the
 * native open dialog. Resolves with the chosen file paths, or `undefined` when
 * the reviewer cancels or closes the panel.
 */
export function pickScopeTree(opts: ScopeTreeOptions): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'codereview.scopePicker',
      m().scopePanel.title,
      opts.viewColumn ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    let settled = false;
    const finish = (result: string[] | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      panel.dispose();
    };

    panel.webview.onDidReceiveMessage((msg: { type?: string; files?: unknown }) => {
      if (msg?.type === 'confirm') {
        const files = Array.isArray(msg.files) ? (msg.files as string[]) : [];
        finish(files);
      } else if (msg?.type === 'cancel') {
        finish(undefined);
      }
    });

    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    panel.webview.html = renderHtml(opts);
  });
}

function renderHtml(opts: ScopeTreeOptions): string {
  const nonce = makeNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const data = JSON.stringify(opts.relPaths);
  const t = m().scopePanel;
  const T = JSON.stringify(t);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --line: var(--vscode-panel-border, rgba(127,127,127,.25));
    --dim: var(--vscode-descriptionForeground, #999);
    --blue: var(--vscode-textLink-foreground, #569cd6);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  .head { padding: 12px 16px 8px; border-bottom: 1px solid var(--line); }
  .head h2 { margin: 0 0 4px; font-size: 14px; }
  .root-line { font-size: 12px; color: var(--dim); }
  .root-line b { color: var(--blue); font-weight: 600; }
  .root-note { margin-top: 4px; font-size: 11.5px; color: var(--dim); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .toolbar input[type=search] {
    flex: 1; font-family: inherit; font-size: 12px; padding: 5px 9px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 5px; outline: none;
  }
  .toolbar input[type=search]:focus { border-color: var(--vscode-focusBorder, var(--blue)); }
  .tbtn {
    font-family: inherit; font-size: 11.5px; padding: 4px 9px; cursor: pointer; white-space: nowrap;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--line); border-radius: 5px;
  }
  .tbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tree { flex: 1; overflow: auto; padding: 6px 0; }
  .row {
    display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 16px 0 8px;
    cursor: default; white-space: nowrap; user-select: none;
  }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); }
  .row.dir { cursor: pointer; }
  .cb { flex: none; margin: 0; cursor: pointer; }
  .caret { flex: none; width: 12px; text-align: center; color: var(--dim); font-size: 10px; }
  .name { flex: none; overflow: hidden; text-overflow: ellipsis; }
  .row.dir .name { font-weight: 600; }
  .count { flex: none; font-size: 11px; color: var(--dim); }
  .empty { padding: 24px 16px; color: var(--dim); text-align: center; }
  .foot {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-top: 1px solid var(--line); background: var(--vscode-editorWidget-background, transparent);
  }
  .count-line { flex: 1; font-size: 12px; color: var(--dim); }
  .count-line b { color: var(--vscode-foreground); }
  button.act { font-family: inherit; font-size: 12px; padding: 6px 14px; cursor: pointer; border-radius: 5px; border: 1px solid var(--line); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.act:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.act.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.act.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button.act:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <div class="head">
    <h2>${esc(t.heading)}</h2>
    <div class="root-line">${esc(t.rootLabel)}<b>${esc(opts.rootLabel)}</b></div>
    <div class="root-note">${esc(t.note)}</div>
  </div>
  <div class="toolbar">
    <input id="filter" type="search" placeholder="${esc(t.filterPlaceholder)}" autocomplete="off" />
    <button class="tbtn" id="btnSelAll">${esc(t.selectAll)}</button>
    <button class="tbtn" id="btnClear">${esc(t.clear)}</button>
    <button class="tbtn" id="btnCollapse">${esc(t.collapseAll)}</button>
  </div>
  <div class="tree" id="tree"></div>
  <div class="foot">
    <div class="count-line">${esc(t.selectedPrefix)}<b id="selCount">0</b>${esc(t.selectedSuffix)}</div>
    <button class="act" id="btnCancel">${esc(t.cancel)}</button>
    <button class="act primary" id="btnConfirm" disabled>${esc(t.confirm)}</button>
  </div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const DATA = ${data};
  const T = ${T};
  const $ = (id) => document.getElementById(id);
  const treeEl = $('tree');

  // ---- Build tree from flat relative paths ---------------------------------
  const root = { name: '', path: '', kind: 'dir', children: new Map(), parent: null };
  const nodeByPath = new Map();
  for (const p of DATA) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const name = parts[i];
      if (!node.children.has(name)) {
        const childPath = parts.slice(0, i + 1).join('/');
        const child = { name, path: childPath, kind: isFile ? 'file' : 'dir', children: isFile ? null : new Map(), parent: node };
        node.children.set(name, child);
        nodeByPath.set(childPath, child);
      }
      node = node.children.get(name);
    }
  }

  // descendant file count per directory (post-order)
  const dirTotal = new Map();
  function countFiles(node) {
    if (node.kind === 'file') return 1;
    let n = 0;
    for (const c of node.children.values()) n += countFiles(c);
    if (node !== root) dirTotal.set(node.path, n);
    return n;
  }
  countFiles(root);

  const selected = new Set();   // file paths
  const dirSel = new Map();     // dir path -> selected descendant file count
  const expanded = new Set();   // dir paths currently expanded

  function ancestors(filePath) {
    const parts = filePath.split('/');
    const out = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
    return out;
  }
  function setFile(filePath, on) {
    if (on && !selected.has(filePath)) {
      selected.add(filePath);
      for (const d of ancestors(filePath)) dirSel.set(d, (dirSel.get(d) || 0) + 1);
    } else if (!on && selected.has(filePath)) {
      selected.delete(filePath);
      for (const d of ancestors(filePath)) dirSel.set(d, (dirSel.get(d) || 0) - 1);
    }
  }
  function collectFiles(node, out) {
    if (node.kind === 'file') { out.push(node.path); return; }
    for (const c of node.children.values()) collectFiles(c, out);
  }
  function setDir(dirPath, on) {
    const node = nodeByPath.get(dirPath);
    if (!node) return;
    const files = [];
    collectFiles(node, files);
    for (const f of files) setFile(f, on);
  }

  // ---- Visible-row computation ---------------------------------------------
  let filterText = '';
  function computeVisible() {
    const rows = [];
    if (filterText) {
      const q = filterText.toLowerCase();
      const show = new Set();
      for (const p of DATA) {
        if (p.toLowerCase().indexOf(q) !== -1) {
          show.add(p);
          for (const a of ancestors(p)) show.add(a);
        }
      }
      // While filtering, only matching nodes are shown, but folding still works:
      // a directory's children are hidden when the user has collapsed it.
      const walk = (node, depth) => {
        for (const c of node.children.values()) {
          if (!show.has(c.path)) continue;
          rows.push({ node: c, depth });
          if (c.kind === 'dir' && expanded.has(c.path)) walk(c, depth + 1);
        }
      };
      walk(root, 0);
    } else {
      const walk = (node, depth) => {
        for (const c of node.children.values()) {
          rows.push({ node: c, depth });
          if (c.kind === 'dir' && expanded.has(c.path)) walk(c, depth + 1);
        }
      };
      walk(root, 0);
    }
    return rows;
  }

  /** Files currently visible given the filter (used by 全选). */
  function visibleFiles() {
    if (!filterText) {
      return DATA.slice();
    }
    const q = filterText.toLowerCase();
    return DATA.filter((p) => p.toLowerCase().indexOf(q) !== -1);
  }

  function rowHtml(r) {
    const n = r.node;
    const pad = 8 + r.depth * 16;
    const isDir = n.kind === 'dir';
    let caret = '';
    if (isDir) {
      caret = expanded.has(n.path) ? '▾' : '▸';
    }
    let count = '';
    if (isDir) {
      const sel = dirSel.get(n.path) || 0;
      const total = dirTotal.get(n.path) || 0;
      count = '<span class="count">' + (sel > 0 ? sel + '/' + total : total) + '</span>';
    }
    return '<div class="row ' + (isDir ? 'dir' : 'file') + '" data-path="' + encodeURIComponent(n.path) + '" data-kind="' + n.kind + '" style="padding-left:' + pad + 'px">'
      + '<input type="checkbox" class="cb" data-path="' + encodeURIComponent(n.path) + '" data-kind="' + n.kind + '" />'
      + '<span class="caret">' + caret + '</span>'
      + '<span class="name">' + escapeHtml(n.name) + '</span>'
      + count
      + '</div>';
  }
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render() {
    const rows = computeVisible();
    if (rows.length === 0) {
      treeEl.innerHTML = '<div class="empty">' + T.noMatch + '</div>';
    } else {
      treeEl.innerHTML = rows.map(rowHtml).join('');
      // apply checkbox states (checked / indeterminate)
      const inputs = treeEl.querySelectorAll('input.cb');
      for (const cb of inputs) {
        const p = decodeURIComponent(cb.getAttribute('data-path'));
        if (cb.getAttribute('data-kind') === 'file') {
          cb.checked = selected.has(p);
          cb.indeterminate = false;
        } else {
          const sel = dirSel.get(p) || 0;
          const total = dirTotal.get(p) || 0;
          cb.checked = total > 0 && sel === total;
          cb.indeterminate = sel > 0 && sel < total;
        }
      }
    }
    const count = selected.size;
    $('selCount').textContent = String(count);
    $('btnConfirm').disabled = count === 0;
  }

  // ---- Events ---------------------------------------------------------------
  treeEl.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.classList || !cb.classList.contains('cb')) return;
    const p = decodeURIComponent(cb.getAttribute('data-path'));
    const kind = cb.getAttribute('data-kind');
    if (kind === 'file') {
      setFile(p, cb.checked);
    } else {
      const sel = dirSel.get(p) || 0;
      const total = dirTotal.get(p) || 0;
      setDir(p, !(total > 0 && sel === total));
    }
    render();
  });

  treeEl.addEventListener('click', (e) => {
    const cb = e.target;
    if (cb.classList && cb.classList.contains('cb')) return; // handled by change
    const row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || row.getAttribute('data-kind') !== 'dir') return;
    const p = decodeURIComponent(row.getAttribute('data-path'));
    if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
    render();
  });

  $('filter').addEventListener('input', (e) => {
    filterText = e.target.value.trim();
    // Auto-expand the ancestor chain of every match so results are visible by
    // default; the user can still collapse any directory afterwards.
    if (filterText) {
      const q = filterText.toLowerCase();
      for (const path of DATA) {
        if (path.toLowerCase().indexOf(q) !== -1) {
          for (const a of ancestors(path)) expanded.add(a);
        }
      }
    }
    treeEl.scrollTop = 0;
    render();
  });
  $('btnSelAll').addEventListener('click', () => { for (const p of visibleFiles()) setFile(p, true); render(); });
  $('btnClear').addEventListener('click', () => { selected.clear(); dirSel.clear(); render(); });
  $('btnCollapse').addEventListener('click', () => { expanded.clear(); render(); });
  $('btnCancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('btnConfirm').addEventListener('click', () => {
    if (selected.size === 0) return;
    vscode.postMessage({ type: 'confirm', files: Array.from(selected) });
  });

  render();
  $('filter').focus();
})();
</script>
</body>
</html>`;
}
