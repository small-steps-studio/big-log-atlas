'use strict';
// The licence and trial commands (buy, enter key, status, remove) and the Pro gate that every Pro
// command goes through: a valid licence first, then the free 14-day trial, then a notice.

const config = require('./licence/config');
const messages = require('./licence/messages');

const BUTTONS = Object.freeze({ buy: 'Buy Pro', enter: 'Enter Licence Key', lost: 'Lost your key?', remove: 'Remove Licence', report: 'Report A Problem' });
const NAME = config.productName;

function registerLicenceCommands(app, reg) {
  const vscode = app.vscode;
  function info() { return vscode.window.showInformationMessage.apply(vscode.window, Array.prototype.slice.call(arguments)); }

  async function openExternal(url) {
    try { return await vscode.env.openExternal(vscode.Uri.parse(url)); } catch (e) {
      vscode.window.showWarningMessage(NAME + ': The link could not be opened by the editor. Open it in your browser: ' + url);
      return false;
    }
  }
  async function handleLicenceButton(pick) {
    if (pick === BUTTONS.buy) await vscode.commands.executeCommand('bigLogAtlas.buyPro');
    else if (pick === BUTTONS.enter) await vscode.commands.executeCommand('bigLogAtlas.enterKey');
    else if (pick === BUTTONS.remove) await vscode.commands.executeCommand('bigLogAtlas.removeLicence');
    else if (pick === BUTTONS.lost) await showLostKey();
  }
  async function showLostKey() {
    const pick = await info(messages.lostKeyText(), BUTTONS.enter, BUTTONS.report);
    if (pick === BUTTONS.enter) await vscode.commands.executeCommand('bigLogAtlas.enterKey');
    else if (pick === BUTTONS.report) await vscode.commands.executeCommand('bigLogAtlas.reportProblem');
  }

  // ---- Pro gate: licence first, then the free trial -----------------------------------------
  async function requirePro(feature) {
    if (await app.licence.isPro()) return true;
    let trial = await app.licence.checkTrial();
    if (trial.state === 'unused') {
      trial = await app.licence.startTrial();
      if (trial.state === 'active') {
        await app.licence.noteTrialReminder();
        info(messages.trialStartedText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* closed */ });
        return true;
      }
    }
    if (trial.state === 'active') {
      await app.licence.touchTrial();
      if (await app.licence.noteTrialReminder()) info(messages.trialReminderText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* closed */ });
      return true;
    }
    const pick = await info(messages.proNoticeText(feature, trial), BUTTONS.buy, BUTTONS.enter);
    await handleLicenceButton(pick);
    return false;
  }

  reg('bigLogAtlas.buyPro', async function () {
    const choice = await vscode.window.showQuickPick(messages.buyChoices(), { placeHolder: 'Which licence? Both unlock the same Pro features.', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    let users = 1;
    if (choice.tier === 'business') {
      const answer = await vscode.window.showInputBox({ title: NAME + ' Pro Business: ' + messages.businessUsersQuestion(), value: '1', ignoreFocusOut: true, validateInput: messages.businessUsersError });
      if (answer === undefined) return;
      if (messages.businessUsersError(answer)) { vscode.window.showWarningMessage(NAME + ': ' + messages.businessUsersError(answer) + ' The checkout page was not opened.'); return; }
      users = Number(String(answer).trim());
    }
    const url = app.licence.buyUrl(choice.tier, users);
    if (!url) { info(NAME + ': ' + choice.label + ' is not on sale yet. Please check the extension page again soon.'); return; }
    await openExternal(url);
  });

  reg('bigLogAtlas.enterKey', async function () {
    const raw = await vscode.window.showInputBox({
      title: NAME + ' Pro: paste the licence key from your purchase e-mail', placeHolder: 'Licence key', ignoreFocusOut: true, password: true,
      validateInput: function (v) { return /\s/.test((v || '').trim()) ? 'A licence key contains no spaces.' : null; }
    });
    const key = (raw || '').trim();
    if (!key) return;
    const result = await app.licence.activate(key);
    if (result.ok) info(NAME + ': ' + messages.activatedText(result.licenceType, result));
    else {
      const pick = await vscode.window.showErrorMessage(NAME + ': ' + messages.activationFailureText(result), BUTTONS.lost);
      if (pick === BUTTONS.lost) await showLostKey();
    }
  });

  reg('bigLogAtlas.licenceStatus', async function () {
    const st = await app.licence.status(true);
    const text = NAME + ': ' + messages.licenceStatusText(st);
    let pick;
    if (st.pro) pick = await info(text, BUTTONS.remove);
    else if (st.hasKey) pick = await info(text, BUTTONS.enter, BUTTONS.remove, BUTTONS.lost);
    else pick = await info(text, BUTTONS.buy, BUTTONS.enter, BUTTONS.lost);
    await handleLicenceButton(pick);
  });

  reg('bigLogAtlas.removeLicence', async function () {
    const st = await app.licence.status(false);
    if (!st.hasKey) { info(NAME + ': No licence key is stored on this computer, so there is nothing to remove.'); return; }
    const pick = await vscode.window.showWarningMessage(NAME + ': ' + messages.removeConfirmText(), { modal: true }, BUTTONS.remove);
    if (pick !== BUTTONS.remove) return;
    const result = await app.licence.remove();
    info(NAME + ': ' + (result.deactivated
      ? 'The licence was removed from this computer and the activation was freed. You can enter the key on another computer now.'
      : 'The licence was removed from this computer. The licence server could not be reached, so the activation may still count against the limit of ' + config.activationLimit + '; if a later activation is refused, contact ' + config.supportContact() + '.'));
  });

  return { requirePro: requirePro, openExternal: openExternal, BUTTONS: BUTTONS };
}

module.exports = { registerLicenceCommands, BUTTONS };
