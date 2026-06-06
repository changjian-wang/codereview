/**
 * English message catalog — the single source of truth for all user-facing UI
 * strings. The catalog's shape (`Messages`) is inferred from this object, so the
 * Chinese catalog in `zh.ts` is structurally checked against it at compile time.
 *
 * Conventions:
 * - Non-webview groups use functions for parameterized strings (nice server-side
 *   ergonomics + type-checked arguments).
 * - Webview groups (scopePanel / workbench / documentPanel / fixPanel /
 *   globalPanel) and the shared label groups (severity / disposition / verdict /
 *   recommendation) use plain strings with `{0}` placeholders, so the whole
 *   group can be JSON-serialized and injected into webview client scripts.
 *   Format them with `fmt()` (server) or the injected `fmt()` (client).
 */
export const en = {
  common: {
    continue: 'Continue',
    cancel: 'Cancel',
    listSep: '; ',
  },

  statusBar: {
    loading: 'Code Review: loading…',
    loadingTooltip: 'Code Review is loading, please wait…',
    opening: 'Opening Code Review…',
    openingTooltip: 'Code Review is opening the review workbench, please wait…',
    ready: 'Open in Code Review',
    readyTooltip:
      'Code Review: open the review workbench in a separate window (pick the review scope inside it)',
  },

  /** Verbs slotted into review.notInScope(); keep them lowercase. */
  actions: {
    open: 'opening',
    revertFix: 'reverting the fix',
    read: 'reading',
    analyze: 'analysis',
    viewFixProposals: 'viewing fix proposals',
    disposeFinding: 'disposing the finding',
    locate: 'locating',
    jump: 'jumping',
  },

  review: {
    notInScope: (rel: string, action: string) =>
      `Code Review: ${rel} is not in the current review scope; skipped ${action}.`,
    noWorkspace: 'Code Review: please open a workspace first.',
    noGitWorkspace: 'Code Review: please open a Git repository workspace first.',
    pickProjectTitle: 'Code Review · Pick a project to review',
    pickProjectPlaceholder: 'Choose which workspace folder to start the review in',
    loadingProject: 'Code Review: loading project sources…',
    loadingSource: 'Code Review: loading sources…',
    noReviewableFiles:
      'No reviewable files in the selected project (skipped node_modules / .git / dist / out / bin / obj / .vs).',
    loaded: (label: string, count: number) => `Loaded ${label} · ${count} file(s)`,
    notStarted: '(not started)',
    notStartedWarn: 'Review has not started yet',
    saveFailed: (msg: string) => `Code Review: failed to save review progress: ${msg}`,
    error: (msg: string) => `Code Review: ${msg}`,
  },

  model: {
    switched: (label: string) => `Analysis model switched: ${label}`,
    noModel: 'Code Review: no available Copilot model found.',
    autoDescription: 'Let Copilot pick the most suitable model automatically',
    pickTitle: 'Code Review · Select analysis model',
    pickPlaceholder: 'Select the model used for code review analysis',
    pickPlaceholderEmpty: 'No Copilot model detected; you can start with Auto',
    current: 'current',
  },

  analysis: {
    translating: 'Code Review: translating…',
    explaining: 'Code Review: explaining…',
    pickFileToAnalyze: 'Pick a file to analyze in the workbench first',
    pickFile: 'Pick a file in the workbench first',
    deletedFileHandled: (rel: string) =>
      `${rel} is a deleted file; handled as a no-source analysis`,
    inProgress: (rel: string) => `${rel} is being analyzed, please wait`,
    cannotOpen: (rel: string) => `Code Review: cannot open ${rel}`,
    analyzingFile: (rel: string) => `Code Review: analyzing ${rel}`,
    callingModel: (file: string) => `Calling the model to analyze ${file}…`,
    writingFindings: 'Writing findings…',
    foundIssues: (rel: string, n: number) => `${rel}: found ${n} issue(s)`,
    noIssues: (rel: string) => `${rel}: no issues found`,
    fileNotLoaded: 'The file is not fully loaded yet',
    allRead: 'You have read through this entire file',
  },

  document: {
    deletedFileNote:
      '(File deleted; no source content exists on the current branch. Confirm the deletion impact in the global review.)',
  },

  annotation: {
    addTitle: 'Code Review · Add annotation',
    linePrompt: (start: number, end: number) =>
      end > start ? `Lines ${start}–${end}` : `Line ${start}`,
    selectionPrompt: 'Selection annotation',
    placeholder: 'Enter annotation…',
  },

  fix: {
    revertNotFound:
      'Cannot auto-revert the Copilot fix: the previously applied snippet is no longer in the file (it may have been edited manually).',
    revertAmbiguous:
      'The previously applied snippet appears multiple times; cannot locate it uniquely to auto-revert. Please restore manually.',
    noModelClipboard:
      'No available Copilot model; the fix prompt was copied to the clipboard — paste it into Copilot Chat.',
    applied: 'Fix applied and marked as "Fixed by Copilot"',
    clipboardHeader: (line: number) =>
      `Fix the following code review issue (around line ${line}):`,
    clipboardTitle: (t: string) => `Title: ${t}`,
    clipboardIssue: (d: string) => `Issue: ${d}`,
    clipboardSuggestion: (s: string) => `Suggestion: ${s}`,
    clipboardFooter: 'Please provide the minimal applicable change.',
    suggestionLabel: (s: string) => `**Suggestion**: ${s}`,
  },

  finding: {
    dispositionReverted: (rel: string) => `Reverted the disposition for ${rel}`,
    postedLineComment: (pr: number) => `Posted as a line comment on PR #${pr}`,
    postedFallbackComment: (pr: number) =>
      `Line comment unavailable; posted as a normal comment on PR #${pr}`,
    postCommentFailed: (msg: string) => `Code Review: failed to send the PR comment — ${msg}`,
    recordedLocal: (p: string) => `Recorded in ${p}`,
    localCommentFailed: (msg: string) => `Code Review: failed to write the local comment — ${msg}`,
    ignoreTitle: (t: string) => `Code Review · Ignore: ${t}`,
    ignorePrompt: 'Enter a reason for ignoring this finding (persisted to the local review record)',
    ignorePlaceholder: 'e.g. false positive / not this iteration / tracked in issue #123',
    ignoreMinLength: 'At least 4 characters',
    ignored: 'Ignored',
  },

  global: {
    inProgress: 'Global analysis is already running…',
    inProgressWait: 'Global analysis is already running, please wait',
    confirmUnready: (n: number) => `${n} file(s) not fully read. Run global analysis anyway?`,
    preparing: (total: number) => `Preparing to analyze ${total} file(s)…`,
    reading: (read: number, total: number, p: string) =>
      `Reading sources (${read}/${total}) ${p}…`,
    analyzing: (total: number) =>
      `Read ${total} file(s); calling the model for cross-file analysis…`,
    cancelled: 'Global analysis cancelled',
    noReport: 'No global conclusion yet; run global analysis first',
    fixFileNotInScope: (file: string) =>
      `Code Review: ${file} is not in the current review scope; skipped.`,
    generatingDiff: (file: string) => `Code Review: generating a candidate diff for ${file}…`,
    noDiff: '(model returned no diff)',
  },

  conclusion: {
    gateFilesUnready: (n: number) => `${n} file(s) not read and analyzed`,
    gateGlobalUnconfirmed: 'Global conclusion not confirmed',
    gateFailed: (reasons: string) => `Code Review gate not passed: ${reasons}.`,
    approve: 'Approve',
    requestChanges: 'Request Changes',
    comment: 'Comment',
    submitTitle: 'Code Review · Submit conclusion',
    submitPlaceholder: 'Select the conclusion of this review',
    confirmPr: (pr: number, label: string) =>
      `This will write the review conclusion back to PR #${pr}: ${label}. Confirm?`,
    submitToGitHub: 'Submit to GitHub',
    prBody: (ready: number, total: number) =>
      `Reviewed via Code Review Gate — ${ready}/${total} files read line-by-line and confirmed, global conclusion verified.`,
    postedToPr: (pr: number, label: string) => `Written back to PR #${pr} (${label})`,
    recordedLocal: (label: string) => `Review conclusion recorded: ${label}`,
  },

  scope: {
    pickFilesLabel: '$(files) Pick source files/folders',
    pickFilesDescription: 'Pure source review',
    pickFilesDetail:
      'Directly pick the source files or directories to review, independent of any diff',
    pickPrLabel: '$(git-pull-request) PR of the current branch',
    pickPrDetail: 'Include the source files touched by the PR (requires gh login)',
    pickTitle: 'Code Review · Select review scope',
    pickPlaceholder:
      'Pick the sources to review (local files/folders or the current branch PR)',
    scanning: 'Code Review: scanning project files…',
    noFiles:
      'No reviewable files in this project (skipped node_modules / .git / dist / out / bin / obj / .vs).',
    branchVsBase: (base: string) => `Current branch vs ${base}`,
    workingTree: 'Uncommitted changes',
    selectedSources: (count: number) => `Selected sources (${count})`,
  },

  // ── Shared label groups (injected into webviews; plain strings) ──────────────
  severity: { bug: 'Bug', conditional: 'Conditional', suggestion: 'Suggestion' },
  disposition: { fixed: 'Fixed by Copilot', commented: 'Commented', ignored: 'Ignored' },
  verdict: { flip: 'Flip', found: 'New find', confirmed: 'Confirmed' },
  recommendation: { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment only' },

  // ── Webview: scope picker panel ──────────────────────────────────────────────
  scopePanel: {
    title: 'Code Review · Select review scope',
    heading: 'Select review scope',
    rootLabel: 'Project root:',
    note: 'Check the directories or files to include. The scope is locked to this project; you cannot select anything outside it.',
    filterPlaceholder: 'Filter by path keyword…',
    selectAll: 'Select all',
    clear: 'Clear',
    collapseAll: 'Collapse all',
    selectedPrefix: 'Selected ',
    selectedSuffix: ' file(s)',
    cancel: 'Cancel',
    confirm: 'Include in review',
    noMatch: 'No matching files',
  },

  // ── Webview: workbench panel ─────────────────────────────────────────────────
  workbench: {
    title: 'Code Review · Workbench',
    emptyTitle: 'Code Review · Workbench',
    emptyDesc:
      'Pick a scope to review (local files / folders, or the current branch PR) to start a review.',
    emptyButton: 'Select review scope…',
    emptyHint:
      'Once the scope is set, review file-by-file and run global analysis in this window.',
    gateReasonFiles: '{0} file(s) not read and confirmed',
    gateReasonGlobal: 'Global conclusion not confirmed',
    submittedConclusionPrefix: 'Conclusion submitted: ',
    writtenBackPr: 'Written back to PR #{0} · ',
    localRecord: 'Local record · ',
    scopeTitle: 'Review scope',
    switchScope: 'Switch scope…',
    switchScopeTitle: 'Pick a different code scope to review',
    filterPlaceholder: 'Filter file paths…',
    overallReview: 'Overall review',
    globalAnalysis: 'Global logic analysis',
    viewGlobal: 'View global conclusion',
    cancel: 'Cancel',
    modelPrefix: 'Model: ',
    switch: 'Switch',
    languagePrefix: 'Language: ',
    languageTitle: 'Code Review · Switch language',
    languagePlaceholder: 'Language for the UI and all LLM output',
    langEn: 'English',
    langZh: '中文 (zh-CN)',
    langAuto: 'Auto',
    lineCoverage: 'Line coverage',
    filesReady: 'Files ready',
    gatePass: 'Gate passed — you can submit the conclusion',
    gateFail: 'Gate not passed',
    submitConclusion: 'Submit review conclusion',
    analyzing: 'Analyzing…',
    unconfirmedTitle: '{0} unconfirmed finding(s)',
    noFindings: 'No findings',
    noMatch: 'No matching files',
    noFiles: 'No files',
    listSep: '; ',
    dotReady: 'Ready',
    dotReadConfirm: 'Read; findings to confirm',
    dotReadAnalyze: 'Read; pending analysis',
    dotReadProgress: 'Read {0}/{1} lines',
    dotNotStarted: 'Not started',
    tokens: 'Tokens (est.)',
    tokenIn: '↑',
    tokenOut: '↓',
    tokenTotal: 'Total',
    tokenCalls: '{0} call(s)',
    tokenEstimateNote: 'Estimated locally (countTokens), not the provider\u2019s billed counts.',
    tokenOps: {
      analyze: 'File analysis',
      global: 'Global analysis',
      fix: 'Fix proposals',
      diff: 'Candidate diff',
      translate: 'Translation',
      explain: 'Explanation',
    },
  },

  // ── Webview: document panel ──────────────────────────────────────────────────
  documentPanel: {
    title: 'File viewer',
    readView: 'Reading view',
    sourceView: 'Source view',
    jumpNextUnseen: 'Jump to next unseen',
    analyzeFile: 'Analyze this file',
    analyzing: 'Analyzing…',
    analyzeDone: '✓ Analysis done',
    translate: 'Translate',
    explain: 'Explain',
    note: 'Note',
    toggleTitle: 'Click to expand / collapse',
    line: 'Line {0}',
    suggestionPrefix: 'Suggestion: ',
    locate: 'Locate',
    revertPrefix: 'Undo ',
    fixedView: '🪄 Fixed (view)',
    fixWithCopilot: '🪄 Fix with Copilot',
    commentBtn: '💬 Comment',
    ignoreBtn: '🚫 Ignore',
    annoLine: 'Line {0}',
    annoLineRange: 'Lines {0}–{1}',
    annoSelection: 'Selection',
    annoTranslate: 'Translation',
    annoExplain: 'Explanation',
    annoNote: 'Note',
    delete: 'Delete',
    otherFindings: 'Other findings',
    unlocatedAnnotations: 'Unlocated annotations',
    fileFindings: 'File-level findings ({0})',
    annotationsTranslations: 'Annotations / translations',
    findingCount: 'Findings {0}',
    unconfirmedCount: '{0} unconfirmed',
    allConfirmed: 'All confirmed',
  },

  // ── Webview: fix-proposal panel ──────────────────────────────────────────────
  fixPanel: {
    generating: 'Generating fix proposals…',
    titlePrefix: 'Fix proposals: ',
    mutexApplied:
      'Applied "{0}". These are mutually-exclusive alternatives; to switch, undo the applied one first.',
    locateGone:
      'Cannot locate: one original snippet in the proposal no longer exists in the file (the file may have changed). Please "Regenerate".',
    locateAmbiguous:
      'One original snippet in the proposal appears {0} times and cannot be located uniquely. Please "Regenerate" for a more context-rich proposal.',
    applyRace: 'Apply failed: the file changed while writing. Please "Regenerate".',
    appliedStatus: 'Applied: {0} (click "Undo changes" to revert)',
    undoGone:
      'Cannot undo: one previously applied snippet is no longer in the file (it may have been edited manually).',
    undoAmbiguous:
      'One previously applied snippet now appears {0} times and cannot be located uniquely; not auto-undoing. Please use Ctrl+Z.',
    undoRace: 'Undo failed: the file changed while writing.',
    undoneStatus: 'Undone: {0}',
    heading: 'Fix proposals',
    suggestionPrefix: 'Suggestion: ',
    supplementLabel: 'Add context (optional)',
    supplementPlaceholder: 'e.g. the null here is guaranteed upstream; the real risk is concurrent writes…',
    supplementHint: 'Your note takes priority over the finding when generating fixes.',
    regenerate: 'Regenerate',
    regenerateWithSupplement: 'Regenerate with context',
    close: 'Close',
    noProposals: 'The model returned no proposals. Please "Regenerate".',
    appliedBannerPrefix: 'Applied: ',
    appliedBannerSuffix:
      '. The change is synced to the file viewer on the left; click "Undo changes" to revert.',
    mutexHint:
      'These are mutually-exclusive alternatives; apply any one to fix the issue — you do not need to apply them all.',
    editCount: ' · {0} edit(s)',
    badgeApplied: 'Applied',
    badgeAlternative: 'Alternative {0}',
    badgeProposal: 'Proposal {0}',
    badgeUnlocatable: 'Cannot locate uniquely ({0}/{1})',
    undoBtn: 'Undo changes',
    otherSelected: 'Another proposal selected',
    otherSelectedTitle: 'Another proposal is applied; undo it first to switch to this one',
    applyBtn: 'Apply this proposal',
    cannotApply: 'Cannot apply',
    applyHint:
      'Applying writes directly into the file (unsaved); the file viewer on the left refreshes immediately.',
    emptyDiff: '(empty diff)',
    line: 'Line {0}',
  },

  // ── Webview: global report panel ─────────────────────────────────────────────
  globalPanel: {
    title: 'Code Review · Global conclusion',
    confirmedRead: 'Confirmed reading the global conclusion',
    noEvidence: '(no evidence chain)',
    lineCoverage: 'line coverage',
    filesReady: 'files ready',
    fileFindings: 'file-level findings',
    tabFiles: '① File-level review',
    tabGlobal: '② Global logic analysis',
    heroTitle: 'Cross-file global conclusion',
    kicker: 'Global conclusion',
    metricRealBugs: 'confirmed real bugs',
    metricFlips: 'flipped false positives',
    metricFixPaths: 'fix spots',
    fileLevelSays: 'File level says (partial)',
    globalResolves: 'Global resolves',
    locate: 'Locate',
    noFlips: '(no flips / new finds; all file-level judgments hold)',
    suggestionPrefix: 'Suggestion: ',
    noFixSpots: 'No cross-file issues that need fixing.',
    noCallGraph: '(no call-graph info)',
    noArchChecks: '(no architecture / intent checks)',
    sectionEvidence: 'Evidence chain: why file-level judgments were corrected by global facts',
    sectionFixSpots: 'Fix spots',
    sectionCallGraph: 'Call graph',
    sectionArch: 'Architecture layers & PR-intent checks',
    confirmedReadBadge: '✓ Confirmed reading the global conclusion',
    confirmReadBtn: 'Confirm I read the global conclusion',
    generating: 'Generating…',
    genDiffBtn: 'Let AI generate a candidate diff',
  },

  gh: {
    timeout: (cmd: string, seconds: number) => `gh ${cmd} timed out (${seconds}s).`,
    notFound: 'GitHub CLI (gh) not found. Please install gh and run `gh auth login`.',
    notAuthed: 'GitHub CLI is not logged in. Please run `gh auth login`.',
    prParseFailed: 'Could not parse the PR data returned by gh.',
    repoViewParseFailed: 'Could not parse the gh repo view response.',
    commentParseFailed: 'The PR comment was sent but the response could not be parsed.',
  },

  git: {
    timeout: (cmd: string, seconds: number) => `git ${cmd} timed out (${seconds}s).`,
    notRepo: 'The current workspace is not a Git repository.',
    noDefaultBranch:
      'Could not determine the default branch (no origin/HEAD, main, or master found).',
  },

  /** User-facing analyzer fallbacks/errors only — LLM prompts stay verbatim in analyzer.ts. */
  analyzer: {
    modelCallFailed: (msg: string) => `Model call failed: ${msg}`,
    jsonParseFailed: (preview: string, truncated: boolean) =>
      `Could not parse the JSON returned by the model. Preview: ${preview}${truncated ? '…' : ''}`,
    untitledFinding: 'Untitled finding',
    untitledVerdict: 'Untitled verdict',
    noCrossFileIssues: 'No significant cross-file issues.',
    checkLabel: 'Check',
    fixProposalTitle: 'Fix proposal',
    noFixProposals: 'The model returned no valid fix proposals.',
  },
};

/** The shape of the message catalog, inferred from the English source of truth. */
export type Messages = typeof en;
