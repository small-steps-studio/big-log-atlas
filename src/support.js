'use strict';
// The diagnostics block that "Report A Problem" copies to the clipboard. It holds versions, the
// platform, the settings, the shape of the log that is open (kind, size, lines, encoding, whether a
// filter, a profile or follow mode is on) and the licence or trial state. It never holds file
// contents, file names, paths, the licence key or its hint, user names, computer names or e-mail
// addresses.

const config = require('./licence/config');

const SETTING_KEYS = ['maxLineChars', 'defaultEncoding', 'indexCache.maxMB', 'follow.intervalMs', 'filter.maxMatches', 'colourLevels', 'export.neutraliseFormulas'];

function licenceLine(st) {
  if (!st) return 'unknown';
  const trial = st.trial || { state: 'unused' };
  let text;
  if (st.pro && st.via === 'grace') text = 'Pro (licence, offline grace period)';
  else if (st.pro) text = 'Pro (' + (st.licenceType || 'licence') + ', verified)';
  else if (st.hasKey && st.via === 'product') text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key of another product)';
  else if (st.hasKey && st.via === 'rejected') text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key rejected by the server)';
  else if (st.hasKey) text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key, grace period over)';
  else if (trial.state === 'active') text = 'Trial (' + trial.daysLeft + ' day' + (trial.daysLeft === 1 ? '' : 's') + ' left)';
  else if (trial.state === 'expired') text = 'Free (trial ended)';
  else text = 'Free (trial not started)';
  return text + ', licence server: ' + (st.mode || 'live');
}

function settingValue(v) {
  if (v === undefined) return 'default';
  return typeof v === 'object' || typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/**
 * Builds the block from `info`: extensionVersion, editorName, editorVersion, platform, osRelease,
 * arch, nodeVersion, settings (flat object keyed as SETTING_KEYS), licence (status), active
 * ({ kind, size, lines, encoding, indexed, filter, profile, follow } or null).
 */
function diagnosticsBlock(info) {
  const i = info || {};
  const lines = [];
  lines.push(config.productName + ' ' + (i.extensionVersion || 'unknown version'));
  lines.push('Editor: ' + (i.editorName || 'unknown') + ' ' + (i.editorVersion || ''));
  lines.push('Platform: ' + (i.platform || 'unknown') + ' ' + (i.osRelease || '') + ' ' + (i.arch || '') + (i.nodeVersion ? ', Node ' + i.nodeVersion : ''));
  const a = i.active;
  if (!a) lines.push('Open log: none');
  else {
    lines.push('Open log: ' + (a.kind || 'file') + ', ' + (typeof a.size === 'number' ? a.size + ' bytes' : 'size unknown') + ', ' + (typeof a.lines === 'number' ? a.lines + ' lines' : 'lines unknown') +
      (a.indexed === false ? ' (index not finished)' : '') + ', encoding ' + (a.encoding || 'unknown'));
    lines.push('View: filter ' + (a.filter ? 'on' : 'off') + ', parse profile ' + (a.profile || 'none') + ', follow ' + (a.follow ? 'on' : 'off'));
  }
  lines.push('Settings:');
  const s = i.settings || {};
  for (const k of SETTING_KEYS) lines.push('  ' + k + ' = ' + settingValue(s[k]));
  lines.push('Licence: ' + licenceLine(i.licence));
  lines.push('Issues page: ' + config.issuesUrl);
  return lines.join('\n') + '\n';
}

function reportProblemText(opened) {
  return 'A diagnostics block (version numbers, platform, settings, licence state, the size and shape of the open log; no file contents, names or paths) was copied to the clipboard. ' +
    (opened ? 'Paste it into the issue that opens in your browser, add what you did and what you expected, and attach a small example log without confidential content.'
      : 'Open ' + config.issuesUrl + ', create a new issue, paste the block and describe what you did and what you expected.');
}

module.exports = { diagnosticsBlock, licenceLine, reportProblemText, SETTING_KEYS };
