'use strict';
// A small stand-in for the editor API, large enough to activate the extension and drive its
// commands in unit tests. It records what the extension registers, shows and opens.

const Module = require('node:module');
const path = require('node:path');

class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath; }
  toString() { return this.scheme + '://' + this.fsPath; }
  static file(p) { return new Uri('file', p); }
  static parse(t) { const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(t); return m ? new Uri(m[1], m[2]) : new Uri('file', t); }
  static joinPath(base) { const parts = Array.prototype.slice.call(arguments, 1); return new Uri(base.scheme, path.join.apply(path, [base.fsPath].concat(parts))); }
}
class EventEmitter { constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; } fire(v) { this.l.forEach((f) => f(v)); } }

function create(options) {
  const o = options || {};
  const disposable = { dispose() {} };
  const state = {
    commands: new Map(), info: [], warn: [], error: [], opened: [], clipboard: null, panels: [], statusItems: [], output: [],
    quick: (o.quickPicks || []).slice(), inputs: (o.inputs || []).slice(), openDialog: (o.openDialog || []).slice(), saveDialog: (o.saveDialog || []).slice(), buttons: (o.buttons || []).slice(),
    config: Object.assign({}, o.config || {}), context: {}, executed: []
  };
  const next = (arr) => arr.shift();
  const msg = (list) => async (text, ...rest) => { list.push(text); const b = next(state.buttons); return b !== undefined && rest.some((r) => r === b || (r && r.title === b)) ? b : undefined; };
  const vscode = {
    Uri: Uri, EventEmitter: EventEmitter, version: '1.99.0',
    ViewColumn: { Active: -1, Beside: -2 }, StatusBarAlignment: { Left: 1, Right: 2 }, ProgressLocation: { Notification: 15 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    env: { appName: 'Visual Studio Code', clipboard: { writeText: async (t) => { state.clipboard = t; } }, openExternal: async (u) => { state.opened.push(u.toString()); return true; } },
    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable; },
      executeCommand: async (id, ...args) => { state.executed.push([id].concat(args)); const fn = state.commands.get(id); return fn ? fn(...args) : undefined; }
    },
    window: {
      createOutputChannel: () => ({ appendLine: (t) => state.output.push(t), dispose() {} }),
      showInformationMessage: msg(state.info), showWarningMessage: msg(state.warn), showErrorMessage: msg(state.error),
      showQuickPick: async (items) => { const a = next(state.quick); if (a === undefined) return undefined; const list = await items; return typeof a === 'function' ? a(list) : list.find((i) => i.label === a || i.id === a || i === a); },
      showInputBox: async (opts) => { const a = next(state.inputs); if (typeof a === 'function') return a(opts); return a; },
      showOpenDialog: async () => next(state.openDialog), showSaveDialog: async () => next(state.saveDialog),
      setStatusBarMessage: () => disposable,
      createStatusBarItem: () => { const it = { text: '', show() { it.visible = true; }, hide() { it.visible = false; }, dispose() {} }; state.statusItems.push(it); return it; },
      withProgress: async (opts, fn) => fn({ report() {} }, { onCancellationRequested: () => disposable, isCancellationRequested: false }),
      createWebviewPanel: (type, title, col, opts) => {
        const handlers = {};
        const panel = {
          type, title, opts, posted: [], active: true, disposed: false,
          webview: { html: '', cspSource: 'vscode-resource:', options: opts, postMessage: async (m) => { panel.posted.push(m); return true; }, asWebviewUri: (u) => ({ toString: () => 'vscode-resource:' + u.fsPath.replace(/\\/g, '/') }), onDidReceiveMessage: (fn) => { handlers.message = fn; return disposable; } },
          onDidDispose: (fn) => { handlers.dispose = fn; return disposable; }, onDidChangeViewState: (fn) => { handlers.view = fn; return disposable; },
          dispose: () => { panel.disposed = true; if (handlers.dispose) handlers.dispose(); }, send: (m) => handlers.message(m), handlers
        };
        state.panels.push(panel);
        return panel;
      }
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(state.config, k) ? state.config[k] : d) }),
      onDidChangeConfiguration: () => disposable,
      openTextDocument: async (x) => ({ uri: Uri.file('untitled'), content: x && x.content })
    }
  };
  state.vscode = vscode;
  return state;
}

/** Installs the mock for require('vscode') and returns it; call restore() afterwards. */
function install(options) {
  const mock = create(options);
  const original = Module._load;
  Module._load = function (request) { return request === 'vscode' ? mock.vscode : original.apply(this, arguments); };
  mock.restore = function () { Module._load = original; };
  return mock;
}

function makeContext(mock, dir, extra) {
  const secrets = new Map();
  const globalState = new Map();
  const workspaceState = new Map();
  return Object.assign({
    subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..', '..')), globalStorageUri: Uri.file(path.join(dir, 'global')), extensionMode: 1,
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k) => globalState.get(k), update: async (k, v) => { if (v === undefined) globalState.delete(k); else globalState.set(k, v); } },
    workspaceState: { get: (k, d) => (workspaceState.has(k) ? workspaceState.get(k) : d), update: async (k, v) => { workspaceState.set(k, v); } },
    extension: { packageJSON: { version: '0.1.0' } }, secretsMap: secrets, globalMap: globalState, workspaceMap: workspaceState
  }, extra || {});
}

module.exports = { install, create, makeContext, Uri };
