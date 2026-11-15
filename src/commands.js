'use strict';
// All commands of the extension: opening logs, the commands that act on the open log (search,
// filter, follow, bookmarks, encoding), support commands, and the Pro commands (parse profiles,
// field and time filters, time jump, statistics, merge, saved filters, highlight rules, export,
// anonymised export, comparison of two excerpts).

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./licence/config');
const { registerLicenceCommands } = require('./licencecmds');
const { sampleFor } = require('./samples');
const { diagnosticsBlock, reportProblemText } = require('./support');
const { LogFile } = require('./engine/lineindex');
const { FileSource } = require('./engine/source');
const E = require('./engine/encoding');

const WALKTHROUGH_ID = 'SmallStepsStudio.big-log-atlas#bigLogAtlas.gettingStarted';
const NAME = config.productName;
const LEVEL_ITEMS = [
  { label: 'Fatal', rank: 5 }, { label: 'Error', rank: 4 }, { label: 'Warning', rank: 3 }, { label: 'Info', rank: 2 }, { label: 'Debug', rank: 1 }, { label: 'Trace', rank: 0 }
];

function registerCommands(app) {
  const vscode = app.vscode;
  const disposables = [];

  function reg(id, fn) {
    disposables.push(vscode.commands.registerCommand(id, async function () {
      try {
        return await fn.apply(null, arguments);
      } catch (err) {
        const why = err && err.message ? err.message : 'the command could not be completed.';
        vscode.window.showErrorMessage(NAME + ': ' + why + ' If this keeps happening, run "' + NAME + ': Report A Problem".');
        return undefined;
      }
    }));
  }
  function info() { return vscode.window.showInformationMessage.apply(vscode.window, Array.prototype.slice.call(arguments)); }
  function warn(text) { return vscode.window.showWarningMessage(NAME + ': ' + text); }

  const lic = registerLicenceCommands(app, reg);
  app.requirePro = lic.requirePro;
  const requirePro = lic.requirePro;
  const openExternal = lic.openExternal;

  function session() {
    const s = app.viewer.activeSession();
    if (!s) { warn('Open a log first: run "' + NAME + ': Open As Large Log", or "' + NAME + ': Open Sample Log" to try one.'); return null; }
    return s;
  }
  // The commands that read the whole log wait until the line index is complete, so that they never cover only a part of the log.
  async function waitIndexed(s, what) {
    if (!s.scanPromise || s.source.complete !== false) return true;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': waiting for the line index before ' + what, cancellable: true }, async function (progress, token) {
      const ctl = new AbortController();
      token.onCancellationRequested(function () { ctl.abort(); });
      return s.waitForIndex(ctl.signal);
    });
  }
  function fileSession() {
    const s = session();
    if (s && !s.hasFile) { warn('This command needs a single log file; this view merges several files.'); return null; }
    return s;
  }

  // ---- opening ---------------------------------------------------------------------------------
  async function openPath(fsPath) {
    let st;
    try { st = await fsp.stat(fsPath); } catch (e) {
      warn(e && e.code === 'ENOENT' ? 'The file does not exist (any more).' : 'The file cannot be read: ' + (e && e.message ? e.message : 'unknown error'));
      return null;
    }
    if (!st.isFile()) { warn('This is not a file.'); return null; }
    try { return await app.viewer.openFile(fsPath, {}); } catch (e) {
      const code = e && e.code;
      warn(code === 'EACCES' || code === 'EPERM' ? 'The file cannot be opened: access is denied.' : code === 'EBUSY' ? 'The file is locked by another program and cannot be opened right now.' : 'The file cannot be opened: ' + (e && e.message ? e.message : 'unknown error'));
      return null;
    }
  }

  reg('bigLogAtlas.openLarge', async function (uri) {
    let target = uri && uri.scheme ? uri : null;
    if (!target) {
      const editor = vscode.window.activeTextEditor;
      const current = editor && editor.document.uri.scheme === 'file' ? editor.document.uri : null;
      if (current) {
        // The usual case: the file in the active editor is the one to open as a large log.
        const choice = await vscode.window.showQuickPick([{ label: 'Open ' + path.basename(current.fsPath), description: 'the file in the active editor', uri: current }, { label: 'Choose another file...', choose: true }], { placeHolder: 'Open as a large log' });
        if (!choice) return;
        if (!choice.choose) target = choice.uri;
      }
      if (!target) {
        const picks = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: 'Open As Large Log', defaultUri: current || undefined });
        if (!picks || !picks[0]) return;
        target = picks[0];
      }
    }
    if (target.scheme !== 'file') { warn('Only files on this computer can be opened (the file is on "' + target.scheme + '").'); return; }
    await openPath(target.fsPath);
  });

  async function openSample(kind) {
    const s = sampleFor(kind);
    const dir = path.join(app.context.globalStorageUri.fsPath, 'samples');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, s.fileName);
    await fsp.writeFile(file, s.text, 'utf8');
    const opened = await openPath(file);
    if (opened) vscode.window.setStatusBarMessage(NAME + ': opened the ' + s.title + ' (invented data)', 5000);
  }
  reg('bigLogAtlas.openSampleLog', function () { return openSample('app'); });
  reg('bigLogAtlas.openSampleJson', function () { return openSample('json'); });
  reg('bigLogAtlas.openWalkthrough', async function () { await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false); });
  reg('bigLogAtlas.showDocumentation', async function () { await openExternal(config.docsUrl); });

  reg('bigLogAtlas.reportProblem', async function () {
    const s = app.viewer.activeSession();
    let active = null;
    if (s && s.source) {
      active = { kind: s.kind, size: s.source.size, lines: s.source.lineCount, indexed: s.source.complete !== false, encoding: s.file ? s.file.encoding : 'merged', filter: s.filter.active, profile: s.profile ? s.profile.id : '', follow: s.follow.on };
    }
    const extension = app.context && app.context.extension;
    const block = diagnosticsBlock({
      extensionVersion: extension && extension.packageJSON ? extension.packageJSON.version : app.extensionVersion,
      editorName: vscode.env && vscode.env.appName, editorVersion: vscode.version, platform: process.platform, osRelease: app.osRelease ? app.osRelease() : '',
      arch: process.arch, nodeVersion: process.versions && process.versions.node, settings: app.settingsForReport(), licence: await app.licence.status(false), active: active
    });
    await vscode.env.clipboard.writeText(block);
    const opened = await openExternal(config.issuesUrl);
    info(NAME + ': ' + reportProblemText(opened !== false));
  });

  // ---- commands on the open log ------------------------------------------------------------------
  reg('bigLogAtlas.goTo', async function () {
    const s = session();
    if (!s) return;
    const text = await vscode.window.showInputBox({ title: NAME + ': go to a line (1234), a percentage (50%), a byte offset (@1048576 or 0x1F4000) or a time (t:2026-01-15 10:30, Pro)', placeHolder: 'Line, 50% or @byte', ignoreFocusOut: true });
    if (text === undefined || !text.trim()) return;
    await s.handle({ type: 'goto', text: text });
  });
  reg('bigLogAtlas.find', function () { const s = session(); if (s) s.cmd('focusFind'); });
  reg('bigLogAtlas.findNext', function () { const s = session(); if (s) s.cmd('findNext'); });
  reg('bigLogAtlas.findPrevious', function () { const s = session(); if (s) s.cmd('findPrev'); });
  reg('bigLogAtlas.copyLines', function () { const s = session(); if (s) s.cmd('copy'); });

  reg('bigLogAtlas.filterLevels', async function () {
    const s = session();
    if (!s) return;
    const current = (s.filter.spec && s.filter.spec.levels) || [];
    const items = LEVEL_ITEMS.map(function (l) { return { label: l.label, rank: l.rank, picked: current.indexOf(l.rank) !== -1 }; });
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Show only lines of these levels (nothing selected shows all levels)' });
    if (!picks) return;
    await s.applySpec(Object.assign({}, s.lastWebSpec, s.extra, { levels: picks.map(function (p) { return p.rank; }) }));
  });
  reg('bigLogAtlas.clearFilter', function () { const s = session(); if (s) { s.clearFilter(s.cursor); s.post({ type: 'filterSpec', spec: {} }); } });

  reg('bigLogAtlas.toggleFollow', function () {
    const s = fileSession();
    if (!s) return;
    if (s.follow.on) s.stopFollow(); else s.startFollow();
  });

  reg('bigLogAtlas.setEncoding', async function () {
    const s = fileSession();
    if (!s) return;
    const items = [{ label: 'Detect automatically', value: 'auto' }].concat(E.ENCODINGS.map(function (e) { return { label: E.labelOf(e), value: e, description: e === s.file.encoding ? 'current' : '' }; }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Read this file as... (now: ' + E.labelOf(s.file.encoding) + ', ' + s.file.encodingReason + ')' });
    if (!pick) return;
    await s.setEncoding(pick.value);
  });

  reg('bigLogAtlas.toggleBookmark', async function () { const s = session(); if (s) await s.handle({ type: 'bookmark', row: s.cursor }); });
  reg('bigLogAtlas.nextBookmark', async function () { const s = session(); if (s) await s.handle({ type: 'bookmarkJump', row: s.cursor, dir: 'next' }); });
  reg('bigLogAtlas.previousBookmark', async function () { const s = session(); if (s) await s.handle({ type: 'bookmarkJump', row: s.cursor, dir: 'prev' }); });

  // ---- Pro: parse profiles and field filters ---------------------------------------------------
  const P = () => require('./pro/profiles');
  reg('bigLogAtlas.chooseProfile', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Parse profiles'))) return;
    const items = [{ label: 'Detect from the first lines', id: '__detect' }].concat(P().PROFILE_LIST.map(function (p) { return { label: p.label, id: p.id }; })).concat([{ label: 'No profile (plain text)', id: '__none' }]);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'How should the lines of this log be read?' });
    if (!pick) return;
    if (pick.id === '__none') { s.setProfile(null); s.refreshInfo(); info(NAME + ': The parse profile was removed.'); return; }
    let id = pick.id;
    let pattern;
    if (id === '__detect') {
      const sample = await s.source.readLines(0, 200, { maxChars: 4000 });
      id = P().suggest(sample.map(function (l) { return l.text; }));
      if (!id) { warn('No built-in profile fits the first lines of this log. Choose one from the list, or write a pattern with named groups.'); return; }
    }
    if (id === 'log4j' || id === 'regex') {
      const key = 'profilePattern.' + id;
      pattern = await vscode.window.showInputBox({
        title: NAME + ': ' + (id === 'log4j' ? 'log4j / logback conversion pattern' : 'regular expression with named groups (no backtracking; no back-references or look-around)'), ignoreFocusOut: true, value: app.context.workspaceState.get('bigLogAtlas.' + key, ''),
        placeHolder: id === 'log4j' ? '%d{yyyy-MM-dd HH:mm:ss.SSS} [%t] %-5level %logger{36} - %msg%n' : '^(?<time>\\S+) (?<level>[A-Z]+) (?<message>.*)$'
      });
      if (pattern === undefined) return;
      await app.context.workspaceState.update('bigLogAtlas.' + key, pattern);
    }
    let profile;
    try { profile = P().createProfile(id, { pattern: pattern }); } catch (e) { vscode.window.showErrorMessage(NAME + ': ' + e.message); return; }
    s.setProfile(profile);
    s.refreshInfo();
    const next = await info(NAME + ': The lines are now read as "' + profile.label + '". Use "Filter By Field" to filter on its fields, or show the columns.', 'Show Table');
    if (next === 'Show Table') s.post({ type: 'cmd', name: 'table' });
  });

  reg('bigLogAtlas.fieldFilter', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Field filters'))) return;
    if (!s.profile) { warn('Choose a parse profile first ("' + NAME + ': Choose Parse Profile").'); return; }
    const FF = require('./pro/fieldfilter');
    const current = s.extra.field || '';
    const text = await vscode.window.showInputBox({
      title: NAME + ': filter by field. Terms separated by spaces, all must hold; operators = != > >= < <= ~ !~; quote values with spaces; empty removes the field filter', ignoreFocusOut: true, value: current, placeHolder: 'status>=500 path~^/api/ level=error',
      validateInput: function (v) { try { FF.parseFilter(v); return null; } catch (e) { return e.message; } }
    });
    if (text === undefined) return;
    await s.setExtra({ field: text.trim() || null });
  });

  // ---- Pro: time -----------------------------------------------------------------------------------
  function parseTimeInput(text) { return require('./engine/timestamps').parseUserTime(text); }
  reg('bigLogAtlas.timeFilter', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Time range filter'))) return;
    const fmt = await s.ensureTimeFormat();
    if (!fmt) { warn('No time stamps were recognised in this log, so a time range cannot be applied. See docs/timestamps.md for the supported formats.'); return; }
    const validate = function (v) { return !v.trim() || !isNaN(parseTimeInput(v)) ? null : 'Use 2026-01-15 10:30:00, 2026-01-15T10:30:00Z or a time of day such as 10:30. Times without a zone are read as UTC.'; };
    const from = await vscode.window.showInputBox({ title: NAME + ': time range, from (empty = from the start)', ignoreFocusOut: true, validateInput: validate });
    if (from === undefined) return;
    const to = await vscode.window.showInputBox({ title: NAME + ': time range, until (empty = to the end)', ignoreFocusOut: true, validateInput: validate });
    if (to === undefined) return;
    await s.setExtra({ from: from.trim() ? parseTimeInput(from) : null, to: to.trim() ? parseTimeInput(to) : null });
  });

  reg('bigLogAtlas.jumpToTime', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Jump to a time'))) return;
    const text = await vscode.window.showInputBox({ title: NAME + ': jump to the first line at or after a time (times without a zone are read as UTC)', ignoreFocusOut: true, placeHolder: '2026-01-15 10:30:00' });
    if (!text || !text.trim()) return;
    await s.jumpToTime(text.trim());
  });

  // ---- Pro: statistics -------------------------------------------------------------------------------
  reg('bigLogAtlas.statistics', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Statistics'))) return;
    let fields = [];
    if (s.profile) {
      const text = await vscode.window.showInputBox({ title: NAME + ': count the most frequent values of these fields, separated by commas (empty for none). Profile: ' + s.profile.label, ignoreFocusOut: true, placeHolder: 'status, path' });
      if (text === undefined) return;
      fields = text.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 5);
    }
    if (!(await waitIndexed(s, 'counting'))) return;
    const timeFormat = await s.ensureTimeFormat();
    const { computeStats } = require('./pro/stats');
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': counting', cancellable: true }, async function (progress, token) {
      const ctl = new AbortController();
      token.onCancellationRequested(function () { ctl.abort(); });
      let last = 0;
      return computeStats(s.source, { profile: s.profile, topFields: fields, timeFormat: timeFormat || undefined, reference: s.reference, signal: ctl.signal, onProgress: function (p) { const pct = p.total ? Math.floor(p.scanned / p.total * 100) : 0; if (pct > last) { progress.report({ increment: pct - last, message: pct + '%' }); last = pct; } } });
    });
    const panel = vscode.window.createWebviewPanel('bigLogAtlas.stats', 'Statistics: ' + s.title, vscode.ViewColumn.Beside, { enableScripts: false });
    const nonce = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    panel.webview.html = require('./statsview').statsHtml(result, { title: s.title }, nonce);
  });

  // ---- Pro: merge --------------------------------------------------------------------------------------
  reg('bigLogAtlas.mergeFiles', async function () {
    if (!(await requirePro('Merge log files by time'))) return;
    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: 'Merge By Time', title: NAME + ': choose 2 to 16 log files' });
    if (!picks || !picks.length) return;
    if (picks.length < 2) { warn('Choose at least two files to merge.'); return; }
    const { MergeSource, MAX_FILES } = require('./pro/merge');
    if (picks.length > MAX_FILES) { warn('At most ' + MAX_FILES + ' files can be merged at once.'); return; }
    const files = [];
    try {
      for (const u of picks) {
        if (u.scheme !== 'file') { warn('Only files on this computer can be merged.'); for (const f of files) await f.file.close(); return; }
        const f = new LogFile(u.fsPath, {});
        await f.open({ encoding: app.getSettings().defaultEncoding });
        files.push({ file: f, name: u.fsPath });
      }
    } catch (e) { for (const f of files) await f.file.close(); warn('A file could not be opened: ' + (e && e.message ? e.message : 'unknown error')); return; }
    const merge = new MergeSource(files, { reference: Date.now() });
    const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': merging', cancellable: true }, async function (progress, token) {
      const ctl = new AbortController();
      token.onCancellationRequested(function () { ctl.abort(); });
      return merge.prepare(ctl.signal, function (p) { progress.report({ message: p.merged ? p.merged.toLocaleString('en-US') + ' lines' : Math.floor(p.scannedBytes / Math.max(1, p.size) * 100) + '%' }); });
    });
    if (done.aborted) { for (const f of files) await f.file.close(); return; }
    await app.viewer.openMerge(merge, 'Merged: ' + merge.tags.join(' + '));
    const notes = [];
    if (merge.untimedFiles.length) notes.push('No time stamps were recognised in ' + merge.untimedFiles.join(', ') + '; its lines are placed at the start, in file order.');
    merge.outOfOrder.forEach(function (n, i) { if (n) notes.push(merge.tags[i] + ' has ' + n.toLocaleString('en-US') + ' lines whose time is earlier than the line before; its lines keep the order of the file.'); });
    if (notes.length) info(NAME + ': ' + notes.join(' '));
  });

  // ---- Pro: saved filters and highlight rules ----------------------------------------------------------
  reg('bigLogAtlas.saveFilter', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Saved filters'))) return;
    const spec = s.currentFilterSpec();
    if (!spec) { warn('There is no filter to save. Set a filter first.'); return; }
    const name = await vscode.window.showInputBox({ title: NAME + ': name for this filter', ignoreFocusOut: true, validateInput: function (v) { return v.trim() && v.length <= 60 ? null : 'Enter a name of up to 60 characters.'; } });
    if (!name) return;
    const list = (app.context.workspaceState.get('bigLogAtlas.savedFilters', []) || []).filter(function (f) { return f.name !== name.trim(); });
    list.push({ name: name.trim(), spec: spec });
    await app.context.workspaceState.update('bigLogAtlas.savedFilters', list.slice(-50));
    info(NAME + ': Filter "' + name.trim() + '" saved for this workspace.');
  });

  reg('bigLogAtlas.applySavedFilter', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Saved filters'))) return;
    const list = app.context.workspaceState.get('bigLogAtlas.savedFilters', []) || [];
    if (!list.length) { warn('No filter has been saved in this workspace yet.'); return; }
    const pick = await vscode.window.showQuickPick(list.map(function (f) { return { label: f.name, description: [f.spec.text, (f.spec.levels || []).length ? 'levels' : '', f.spec.field, (f.spec.from || f.spec.to) ? 'time range' : ''].filter(Boolean).join(' | '), spec: f.spec }; }), { placeHolder: 'Apply which saved filter?' });
    if (pick) await s.applySpec(pick.spec);
  });

  reg('bigLogAtlas.highlightRules', async function () {
    const s = session();
    if (!s) return;
    if (!(await requirePro('Highlight rules'))) return;
    const rules = (app.context.workspaceState.get('bigLogAtlas.highlights', []) || []).slice();
    const action = await vscode.window.showQuickPick([{ label: 'Add a rule', id: 'add' }, { label: 'Remove a rule', id: 'remove', description: rules.length + ' rules' }, { label: 'Remove all rules', id: 'clear' }], { placeHolder: 'Highlight rules colour parts of lines in every log of this workspace' });
    if (!action) return;
    if (action.id === 'add') {
      if (rules.length >= 20) { warn('At most 20 highlight rules are kept.'); return; }
      const text = await vscode.window.showInputBox({ title: NAME + ': text or pattern to highlight', ignoreFocusOut: true });
      if (!text) return;
      const kind = await vscode.window.showQuickPick([{ label: 'Text', regex: false }, { label: 'Regular expression (no backtracking)', regex: true }], { placeHolder: 'The text is...' });
      if (!kind) return;
      const probe = require('./engine/matcher').createMatcher({ text: text, regex: kind.regex, caseSensitive: false });
      if (!probe.ok) { vscode.window.showErrorMessage(NAME + ': ' + probe.error.message); return; }
      const colours = ['Yellow', 'Green', 'Blue', 'Pink', 'Purple', 'Orange'].map(function (c, i) { return { label: c, colour: i }; });
      const colour = await vscode.window.showQuickPick(colours, { placeHolder: 'Colour' });
      if (!colour) return;
      rules.push({ text: text, regex: kind.regex, caseSensitive: false, colour: colour.colour });
    } else if (action.id === 'remove') {
      if (!rules.length) { warn('There are no highlight rules.'); return; }
      const pick = await vscode.window.showQuickPick(rules.map(function (r, i) { return { label: r.text, description: r.regex ? 'regular expression' : 'text', i: i }; }), { placeHolder: 'Remove which rule?' });
      if (!pick) return;
      rules.splice(pick.i, 1);
    } else rules.length = 0;
    await app.context.workspaceState.update('bigLogAtlas.highlights', rules);
    for (const x of app.viewer.sessions()) { x.loadHighlights(); x.post({ type: 'cmd', name: 'rowsChanged' }); }
  });

  // ---- Pro: export ---------------------------------------------------------------------------------------------
  async function runExport(anonymise) {
    const s = session();
    if (!s) return;
    if (!(await requirePro(anonymise ? 'Anonymised export' : 'Export of filtered lines'))) return;
    const formats = [
      { label: 'Text (the lines as they are)', id: 'text', ext: 'log' }, { label: 'CSV (line, time, level, columns, text)', id: 'csv', ext: 'csv' },
      { label: 'JSON (one array)', id: 'json', ext: 'json' }, { label: 'JSON Lines (one object per line)', id: 'jsonl', ext: 'jsonl' }
    ];
    const format = await vscode.window.showQuickPick(formats, { placeHolder: anonymise ? 'Format of the anonymised copy' : 'Format of the export' });
    if (!format) return;
    let rules = [];
    if (anonymise) {
      const A = require('./pro/anonymise');
      const useFile = await vscode.window.showQuickPick([{ label: 'Built-in rules only', id: 'no' }, { label: 'Built-in rules and a rule file...', id: 'file' }], { placeHolder: 'Rules: e-mail addresses, IP addresses, token-like strings and card-like numbers are always replaced' });
      if (!useFile) return;
      if (useFile.id === 'file') {
        const picks = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Rule file (JSON)': ['json'] }, openLabel: 'Use Rule File' });
        if (!picks || !picks[0]) return;
        const parsed = A.parseRuleFile(await fsp.readFile(picks[0].fsPath, 'utf8'));
        if (parsed.errors.length) { vscode.window.showErrorMessage(NAME + ': ' + parsed.errors.slice(0, 5).join(' ')); return; }
        rules = parsed.rules;
      }
    }
    const base = (s.title || 'log').replace(/\.[^.]*$/, '');
    const target = await vscode.window.showSaveDialog({ defaultUri: s.hasFile ? vscode.Uri.file(path.join(path.dirname(s.file.path), base + (anonymise ? '-anonymised.' : '-export.') + format.ext)) : undefined, saveLabel: 'Export', filters: { 'Export': [format.ext] } });
    if (!target) return;
    if (s.hasFile && path.resolve(target.fsPath) === path.resolve(s.file.path)) { warn('The export would overwrite the log that is open. Choose another file name.'); return; }
    const X = require('./pro/exporter');
    const A2 = require('./pro/anonymise');
    if (!(await waitIndexed(s, 'exporting'))) return;
    const timeFormat = await s.ensureTimeFormat();
    const first = s.filter.active ? await s.buildPredicate(s.filter.spec) : { pred: function () { return true; } };
    const second = s.filter.active ? await s.buildPredicate(s.filter.spec) : { pred: function () { return true; } };
    if (first.error) { warn(first.error); return; }
    const an = anonymise ? A2.createAnonymiser({ rules: rules }) : null;
    let res;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': exporting', cancellable: true }, async function (progress, token) {
        const ctl = new AbortController();
        token.onCancellationRequested(function () { ctl.abort(); });
        let last = 0;
        return X.exportLines(s.source, {
          outPath: target.fsPath, format: format.id, pred: first.pred, freshPred: function () { return second.pred; }, profile: s.profile, timeFormat: timeFormat || undefined, reference: s.reference,
          neutralise: app.getSettings().neutraliseFormulas, transform: an ? an.apply : null, discoverTransform: an ? an.applyQuiet : null, fieldRule: an ? an.fieldRule : null, signal: ctl.signal,
          onProgress: function (p) { const pct = p.total ? Math.floor(p.scanned / p.total * 100) : 0; if (pct > last) { progress.report({ increment: pct - last, message: pct + '%' }); last = pct; } }
        });
      });
    } catch (e) {
      // The exporter has removed the incomplete file. A rule that needs too much work, or too many
      // different values, stops the copy with a message that says what to change.
      if (e && (e.name === 'AnonymiseError' || e.name === 'RegexError')) { vscode.window.showErrorMessage(NAME + ': The export was stopped and no file was kept. ' + e.message); return; }
      throw e;
    }
    const notes = [];
    if (res.aborted) notes.push('The export was cancelled, so the file is incomplete.');
    if (res.longLines) notes.push(res.longLines.toLocaleString('en-US') + ' line(s) longer than 1,048,576 characters were written up to that length.');
    if (an) {
      const c = an.counts();
      const parts = Object.keys(c).map(function (k) { return k + ' ' + c[k].toLocaleString('en-US'); });
      notes.push('Replaced: ' + (parts.length ? parts.join(', ') : 'nothing found') + '. Review the copy before you share it: the rules cannot recognise every kind of sensitive text.');
    }
    const pick = await info(NAME + ': Wrote ' + res.written.toLocaleString('en-US') + ' lines to ' + path.basename(target.fsPath) + '. ' + notes.join(' '), 'Open As Large Log');
    if (pick === 'Open As Large Log') await openPath(target.fsPath);
  }
  reg('bigLogAtlas.exportFiltered', function () { return runExport(false); });
  reg('bigLogAtlas.exportAnonymised', function () { return runExport(true); });

  // ---- Pro: compare two excerpts -----------------------------------------------------------------------------
  reg('bigLogAtlas.compareExcerpts', async function () {
    const a = session();
    if (!a) return;
    if (!(await requirePro('Comparison of two log excerpts'))) return;
    const D = require('./pro/logdiff');
    const askRange = async function (label, def) {
      const text = await vscode.window.showInputBox({ title: NAME + ': ' + label + ' (lines such as 100-250, at most ' + D.MAX_LINES.toLocaleString('en-US') + ')', ignoreFocusOut: true, value: def, validateInput: function (v) { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(v); return m && +m[1] >= 1 && +m[2] >= +m[1] && +m[2] - +m[1] < D.MAX_LINES ? null : 'Write two line numbers such as 100-250.'; } });
      if (!text) return null;
      const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text);
      return { from: +m[1] - 1, count: +m[2] - +m[1] + 1 };
    };
    const cur = a.lineOfRow(a.cursor);
    const ra = await askRange('first excerpt of "' + a.title + '"', (Math.max(0, cur) + 1) + '-' + (Math.max(0, cur) + 200));
    if (!ra) return;
    const others = app.viewer.sessions().filter(function (x) { return x !== a && x.source; });
    const items = others.map(function (x) { return { label: x.title, description: 'open log', sess: x }; }).concat([{ label: 'Another log in this view', description: a.title, sess: a }, { label: 'Choose a file...', file: true }]);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Compare with which log?' });
    if (!pick) return;
    let bSource;
    let temp = null;
    if (pick.file) {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare With' });
      if (!files || !files[0] || files[0].scheme !== 'file') return;
      temp = new LogFile(files[0].fsPath, {});
      await temp.open({ encoding: app.getSettings().defaultEncoding });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': reading the file' }, function () { return temp.scan(); });
      bSource = new FileSource(temp);
    } else bSource = pick.sess.source;
    const rb = await askRange('second excerpt', (ra.from + 1) + '-' + (ra.from + ra.count));
    if (!rb) { if (temp) await temp.close(); return; }
    let left;
    let right;
    try {
      const ctl = new AbortController();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': reading the excerpts', cancellable: true }, async function (progress, token) {
        token.onCancellationRequested(function () { ctl.abort(); });
        left = await D.readExcerpt(a.source, ra.from, ra.count, { signal: ctl.signal });
        right = left ? await D.readExcerpt(bSource, rb.from, rb.count, { signal: ctl.signal }) : null;
      });
    } finally {
      if (temp) await temp.close();
    }
    if (!left || !right) return;
    if (left.got === 0 || right.got === 0) {
      warn('The ' + (left.got === 0 ? 'first' : 'second') + ' excerpt is empty: its range starts after the last line of the log' + ((left.got === 0 ? a.source : bSource).complete === false ? ' indexed so far.' : '.') + ' Choose lines that exist.');
      return;
    }
    const result = D.compareExcerpts(left, right);
    if (!result.ok) { warn(result.reason); return; }
    const sbs = D.sideBySide(left.lines.map(function (l) { return l.display; }), right.lines.map(function (l) { return l.display; }), result.diff);
    const docA = await vscode.workspace.openTextDocument({ content: sbs.left.join('\n') + '\n', language: 'log' });
    const docB = await vscode.workspace.openTextDocument({ content: sbs.right.join('\n') + '\n', language: 'log' });
    await vscode.commands.executeCommand('vscode.diff', docA.uri, docB.uri, 'Excerpts compared (times, ids and long numbers are replaced by placeholders)');
    info(NAME + ': ' + result.message);
  });

  return disposables;
}

module.exports = { registerCommands };
