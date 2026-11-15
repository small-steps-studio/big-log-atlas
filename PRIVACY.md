# Privacy

Last updated: 2026-11-12 (Big Log Atlas 0.1.0)

Big Log Atlas, published by Small Steps Studio, works on your computer. This page states exactly what the extension stores and what it sends over the network, which is very little.

## What stays on your computer

* The contents and names of your log files. Reading, scrolling, searching, filtering, statistics, merging, exporting, anonymising and comparing are performed locally and nothing about them is sent anywhere. Log files are only read, never changed.
* The free 14-day trial of the Pro features. Its start time, the time it was last used and the time of the last reminder are kept in the editor's extension storage on this computer. Nothing about the trial is sent anywhere, not even to the payment provider, and it needs no account.
* There is **no telemetry**, no usage statistics, no crash reporting and no advertising.

## What the extension saves (all local)

* **Saved line indexes** (optional, on by default, see the setting `bigLogAtlas.indexCache.maxMB`). For a log of at least 1 MB, the extension saves a small file in its storage folder that holds line numbers, byte offsets and two checksums of 4 KB blocks of the log, so that a log that has not changed opens without scanning it again. It holds no log text. The file is named by a hash of the log's path, size and modification time. The oldest files are deleted when the folder exceeds the size set, and files older than 60 days are deleted. Set the size to 0 to turn saved indexes off; they can also be deleted by hand in the extension's storage folder.
* **Bookmarks**, per log, in the editor's workspace storage. The log is identified by a hash of its path; only line numbers are saved.
* **Saved filters, highlight rules and the last parse pattern you typed** (Pro), in the editor's workspace storage. They hold what you typed (a search text or a pattern), which can be sensitive if you typed something sensitive. They are not sent anywhere.
* **Sample logs** (invented data), written to the extension's storage folder when you open a sample.
* **Exports and anonymised copies** are written only to the file you choose. The anonymiser draws a random key for every run; the key is held in memory only and is never saved, shown or logged, and no table of original and replaced values exists.

Remove a log's index, a bookmark or a saved filter by deleting the extension's storage, or by uninstalling the extension.

## The one network request: the licence check (Pro only)

The optional Pro tier is unlocked with a licence key. After you enter a key (**Big Log Atlas: Enter Licence Key**), the extension talks to the licence service of the payment provider, Dodo Payments, at `live.dodopayments.com`. It uses only the provider's public licence endpoints, to activate, validate and deactivate a key.

Each request contains:

* the **licence key**, and
* for activation, the text **`VS Code on <platform>`**, for example `VS Code on Windows`, `VS Code on macOS` or `VS Code on Linux`. This label lets you tell your activations apart. It never contains your computer's name, your user name, your files or anything else about you or your machine.
* for validation and deactivation, the activation id that the service returned when you activated the key.

As with any internet request, the service sees your IP address. In a remote window (SSH, container, WSL) the extension runs on the remote machine, so the request leaves from the remote machine.

Who receives it, where it goes and how long it is kept:

* The recipient is Dodo Payments, the payment provider and merchant of record that sells the licence key. The data is sent to its servers at `live.dodopayments.com` and to nobody else. The author of the extension does not run a server and receives none of it.
* The provider may process data in several countries. How long it keeps data, and under which legal basis, is set out in its own privacy policy: <https://dodopayments.com/legal/privacy-policy>.
* The answer to an activation names the product the key belongs to (the extension keeps that product id to know which licence it is) and contains customer details of the purchase; the extension never stores or shows those customer details.
* The data is **not anonymous**. A licence key belongs to a purchase and therefore to the buyer's record at the payment provider. The platform label contains no personal data.
* No data from this request is used for advertising, analytics or profiling by the extension.

When it happens:

* **Never without a key.** If you have not entered a licence key, the extension makes no network request. The free features and the trial work entirely offline.
* On activation (when you enter the key).
* On validation: a successful validation is remembered for 24 hours; the extension asks again at the next Pro feature use after that. If the service cannot be reached, the last successful validation keeps Pro working for 14 days.
* On deactivation (**Big Log Atlas: Remove Licence From This Machine**), and when a key of another product is entered or a key cannot be stored (the activation made for the check is given back to the service; if that request fails, the message says so). Entering the key that is already active on this computer only asks the service whether it is valid and uses no further activation.
* **Show Licence Status** asks the service right away when a key is stored.

## What is stored locally for the licence

* The licence key, in VS Code's secret storage (your operating system's credential store where available).
* The activation id, the product id, the time of the last check and the time of the last successful validation, in VS Code's extension storage.
* The trial record (start, last use, last reminder), in VS Code's extension storage.

**Remove Licence From This Machine** deletes the key and the activation data and frees the activation. The trial record is kept, so that the trial is not started again.

## Report A Problem

**Big Log Atlas: Report A Problem** copies a short diagnostics block to your clipboard and opens the public issues page in your browser. The block contains the extension and editor versions, the operating system, the size, the number of lines and the encoding of the open log, whether a filter, a parse profile or follow mode is on, your Big Log Atlas settings and the licence state (Free, Trial or Pro). It never contains log contents, file names, paths, the licence key, user or computer names. Nothing is sent until you paste it into an issue yourself.

## Buying

The **Buy Pro** command opens the payment provider's checkout page in your browser. Payment details are entered on that page and handled by the payment provider; the extension never sees them. Their privacy policy applies to the purchase.

## Questions

Open an issue at <https://github.com/small-steps-studio/big-log-atlas/issues>. Please do not include confidential data in a report.
