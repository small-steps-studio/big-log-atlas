'use strict';
// The panels that show logs: one webview panel per open log, each with its own LogSession. The page
// is served from media/webview with a strict content security policy (no inline script, no remote
// content, scripts only with a one-time nonce).

const path = require('node:path');
const crypto = require('node:crypto');
const { LogSession } = require('./session');
const config = require('./licence/config');

const VIEW_TYPE = 'bigLogAtlas.log';

function pageHtml(cspSource, nonce, scriptUri, styleUri) {
  const level = function (rank, letter, name) { return '<button type="button" class="lvbtn" data-rank="' + rank + '" aria-pressed="false" aria-label="Show ' + name + ' lines" title="Show ' + name + ' lines">' + letter + '</button>'; };
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + '; script-src \'nonce-' + nonce + '\'; font-src ' + cspSource + ';">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<link rel="stylesheet" href="' + styleUri + '">\n<title>Log</title>\n</head>\n<body>\n' +
    '<div id="toolbar" role="toolbar" aria-label="Log tools">\n' +
    '<div class="group"><label for="find">Find</label><input id="find" type="text" spellcheck="false" aria-label="Find in the log" placeholder="Text or pattern">' +
    '<button type="button" id="optCase" aria-pressed="false" aria-label="Match case" title="Match case">Aa</button>' +
    '<button type="button" id="optWord" aria-pressed="false" aria-label="Whole word" title="Whole word">W</button>' +
    '<button type="button" id="optRegex" aria-pressed="false" aria-label="Regular expression" title="Regular expression (no backtracking)">.*</button>' +
    '<button type="button" id="prevBtn" aria-label="Previous match" title="Previous match (Shift+F3)">▲</button>' +
    '<button type="button" id="nextBtn" aria-label="Next match" title="Next match (F3)">▼</button><span id="count" aria-live="polite"></span></div>\n' +
    '<div class="group"><label for="filter">Filter</label><input id="filter" type="text" spellcheck="false" aria-label="Filter lines by text or regular expression" placeholder="Show only lines with...">' +
    level(5, 'F', 'fatal') + level(4, 'E', 'error') + level(3, 'W', 'warning') + level(2, 'I', 'info') + level(1, 'D', 'debug') + level(0, 'T', 'trace') +
    '<button type="button" id="clearBtn" aria-label="Clear filter">Clear</button><span id="filterInfo" aria-live="polite"></span></div>\n' +
    '<div class="group"><label for="goto">Go to</label><input id="goto" type="text" spellcheck="false" aria-label="Go to a line, a percentage or a byte offset" placeholder="Line, 50% or @byte"></div>\n' +
    '<div class="group"><button type="button" id="followBtn" aria-pressed="false" title="Follow the end of a growing file">Follow</button>' +
    '<button type="button" id="pauseBtn" aria-pressed="false" title="Pause following without leaving follow mode">Pause</button>' +
    '<button type="button" id="tableBtn" title="Show parsed columns for a window of lines (Pro)">Table (Pro)</button>' +
    '<button type="button" id="encBtn" title="Change the encoding of this file">Encoding</button></div>\n' +
    '</div>\n<div id="banner" role="status" aria-live="polite"></div>\n' +
    '<div id="main"><div id="list" role="grid" tabindex="0" aria-label="Log lines. Arrow keys move, Page Up and Page Down scroll, Control+F finds, Control+G goes to a line."><div id="rows"></div></div>' +
    '<div id="sb" role="scrollbar" aria-orientation="vertical" aria-controls="list" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Position in the log"><div id="thumb"></div></div>' +
    '<div id="tableWrap" class="hidden" role="region" aria-label="Parsed columns"></div></div>\n' +
    '<div id="details" role="region" aria-label="Line details"></div>\n<div id="statusline" role="status" aria-live="polite"></div>\n' +
    '<script nonce="' + nonce + '" src="' + scriptUri + '"></script>\n</body>\n</html>\n';
}

function createViewerManager(app) {
  const vscode = app.vscode;
  const context = app.context;
  const panels = new Set();
  let active = null;   // the panel the user is in now (drives the status bar)
  let latest = null;   // the panel that was active last: commands act on it even when the focus is elsewhere
  let statusItem = null;

  function setStatus(entry, text) {
    entry.statusText = text;
    if (active !== entry) return;
    if (!statusItem) { statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100); statusItem.name = 'Big Log Atlas'; statusItem.command = 'bigLogAtlas.goTo'; statusItem.tooltip = 'Go to a line, a percentage or a byte offset'; }
    if (text) { statusItem.text = '$(list-flat) ' + text; statusItem.show(); } else statusItem.hide();
  }

  function setActive(entry) {
    active = entry;
    if (entry) latest = entry;
    vscode.commands.executeCommand('setContext', 'bigLogAtlas.viewActive', !!entry);
    if (!entry) { if (statusItem) statusItem.hide(); } else setStatus(entry, entry.statusText || '');
  }

  function cacheDir() {
    return context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'index') : '';
  }

  function stateOf() {
    return {
      get: function (k, fallback) { return context.workspaceState.get('bigLogAtlas.' + k, fallback); },
      update: function (k, v) { return context.workspaceState.update('bigLogAtlas.' + k, v); }
    };
  }

  function createPanel(title) {
    const root = vscode.Uri.joinPath(context.extensionUri, 'media', 'webview');
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] });
    const nonce = crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    const web = panel.webview;
    web.html = pageHtml(web.cspSource, nonce, web.asWebviewUri(vscode.Uri.joinPath(root, 'main.js')), web.asWebviewUri(vscode.Uri.joinPath(root, 'main.css')));
    return panel;
  }

  async function attach(panel, makeSession) {
    const entry = { panel: panel, session: null, statusText: '' };
    const session = new LogSession({
      post: function (m) { panel.webview.postMessage(m); },
      settings: app.getSettings,
      cacheDir: cacheDir(),
      state: stateOf(),
      gate: function (feature) { return app.requirePro(feature); },
      hasAccess: function () { return app.licence.hasAccess(); },
      clipboard: function (t) { return vscode.env.clipboard.writeText(t); },
      status: function (t) { setStatus(entry, t); },
      notify: function (kind, text) { (kind === 'error' ? vscode.window.showErrorMessage : kind === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(config.productName + ': ' + text); }
    });
    entry.session = session;
    panels.add(entry);
    panel.onDidDispose(function () { panels.delete(entry); session.dispose(); if (active === entry) setActive(null); if (latest === entry) latest = null; });
    panel.onDidChangeViewState(function (e) { if (e.webviewPanel.active) setActive(entry); else if (active === entry) setActive(null); });
    panel.webview.onDidReceiveMessage(function (msg) {
      if (msg && msg.type === 'encodingMenu') { setActive(entry); vscode.commands.executeCommand('bigLogAtlas.setEncoding'); return; }
      session.handle(msg);
    });
    setActive(entry);
    await makeSession(session);
    return entry;
  }

  return {
    sessions: function () { return Array.from(panels).map(function (e) { return e.session; }); },
    activeSession: function () { const e = active || latest; return e ? e.session : null; },
    async openFile(filePath, options) {
      const panel = createPanel(path.basename(filePath));
      try {
        return await attach(panel, function (s) { return s.openFile(filePath, options); });
      } catch (e) { panel.dispose(); throw e; }
    },
    async openMerge(merge, title) {
      const panel = createPanel(title);
      return attach(panel, function (s) { return s.openMerge(merge, title); });
    },
    pageHtml: pageHtml,
    dispose: function () { for (const e of Array.from(panels)) e.panel.dispose(); if (statusItem) statusItem.dispose(); }
  };
}

module.exports = { createViewerManager, pageHtml, VIEW_TYPE };
