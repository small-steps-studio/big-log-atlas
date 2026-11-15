'use strict';
// Big Log Atlas entry point. Builds the shared `app` object and installs every part of the
// extension; a failure in one part does not take the others down.

const vscode = require('vscode');
const os = require('node:os');
const path = require('node:path');
const config = require('./licence/config');
const { createLicence } = require('./licence/licence');
const { createViewerManager } = require('./viewer');
const { registerCommands } = require('./commands');
const cache = require('./engine/indexcache');

const ENCODINGS = ['auto', 'utf8', 'utf16le', 'utf16be', 'latin1'];

function numberSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * The licence server environment. The installed extension always uses the live one: no setting,
 * command or environment variable can change it, and the module that holds the test environment is
 * not part of the package. Only a development checkout (the module is present) that runs as an
 * extension development host uses the payment provider's test environment.
 */
function licenceModeFor(context, extensionMode) {
  const development = extensionMode !== undefined && context && context.extensionMode !== undefined && context.extensionMode === extensionMode.Development;
  const mode = development && config.testEnvironmentAvailable ? 'test' : 'live';
  return function () { return mode; };
}

function activate(context) {
  let output = null;
  function log(text) {
    if (!output) output = vscode.window.createOutputChannel('Big Log Atlas');
    output.appendLine(text);
  }

  let settingsCache = null;
  function getSettings() {
    if (settingsCache) return settingsCache;
    const c = vscode.workspace.getConfiguration('bigLogAtlas');
    const enc = c.get('defaultEncoding', 'auto');
    settingsCache = {
      maxLineChars: numberSetting(c.get('maxLineChars', 2000), 2000, 200, 100000),
      defaultEncoding: ENCODINGS.indexOf(enc) !== -1 ? enc : 'auto',
      indexCacheMB: numberSetting(c.get('indexCache.maxMB', 64), 64, 0, 2048),
      followIntervalMs: numberSetting(c.get('follow.intervalMs', 500), 500, 100, 10000),
      filterMaxMatches: numberSetting(c.get('filter.maxMatches', 2000000), 2000000, 1000, 10000000),
      colourLevels: c.get('colourLevels', true) !== false,
      neutraliseFormulas: c.get('export.neutraliseFormulas', true) !== false
    };
    return settingsCache;
  }

  const licence = createLicence({
    secrets: context.secrets,
    globalState: context.globalState,
    getMode: licenceModeFor(context, vscode.ExtensionMode),
    editorName: vscode.env && vscode.env.appName
  });
  licence.checkTrial().then(undefined, function () { /* read-only state */ });

  const app = {
    vscode: vscode,
    context: context,
    licence: licence,
    getSettings: getSettings,
    viewer: null,
    requirePro: null,
    extensionVersion: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || require('../package.json').version,
    osRelease: function () { try { return os.release(); } catch (e) { return ''; } },
    settingsForReport: function () {
      const s = getSettings();
      return { maxLineChars: s.maxLineChars, defaultEncoding: s.defaultEncoding, 'indexCache.maxMB': s.indexCacheMB, 'follow.intervalMs': s.followIntervalMs, 'filter.maxMatches': s.filterMaxMatches, colourLevels: s.colourLevels, 'export.neutraliseFormulas': s.neutraliseFormulas };
    }
  };

  const subscriptions = context.subscriptions;
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event) {
    if (event.affectsConfiguration('bigLogAtlas')) settingsCache = null;
  }));

  function install(name, fn) {
    try {
      const result = fn();
      if (Array.isArray(result)) result.forEach(function (d) { subscriptions.push(d); });
      else if (result && typeof result.dispose === 'function') subscriptions.push(result);
      return result;
    } catch (err) {
      log('Could not start ' + name + ': ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  app.viewer = install('viewer', function () { return createViewerManager(app); });
  install('commands', function () { return registerCommands(app); });
  // Old saved indexes are removed in the background.
  if (context.globalStorageUri) {
    const dir = path.join(context.globalStorageUri.fsPath, 'index');
    cache.cleanup(dir, getSettings().indexCacheMB * 1024 * 1024).then(undefined, function () { /* nothing to clean */ });
  }
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate, licenceModeFor: licenceModeFor };
