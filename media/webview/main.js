/* Big Log Atlas: the page that shows one log. It never holds more than a few thousand lines: the
   extension sends the rows of the visible window on request, and this page draws them with a
   scroll position of its own (so a file of any number of lines scrolls smoothly). All text from the
   log is inserted as text nodes, never as markup. */
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  function $(id) { return document.getElementById(id); }
  var LV = ['T', 'D', 'I', 'W', 'E', 'F'];
  var LVNAME = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'];
  var CACHE_MAX = 4000;

  var S = {
    total: 0, top: 0, cursor: 0, anchor: 0, rowH: 19, vis: 20, cache: new Map(), gen: 0, seq: 0, inflight: null,
    info: null, follow: { on: false, paused: false }, filtering: false, matchRow: -1, searchSeq: 0, detailRow: -1,
    table: null, indexing: false, pool: [], findTimer: 0, filterTimer: 0, detailTimer: 0, viewTimer: 0, opt: { c: false, w: false, r: false }, levels: {}
  };

  var list = $('list');
  var rowsEl = $('rows');
  var thumb = $('thumb');
  var sb = $('sb');

  function send(msg) { vscode.postMessage(msg); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function say(text, kind) { var b = $('banner'); b.textContent = text || ''; b.className = kind || ''; }
  function status(text) { $('statusline').textContent = text || ''; }

  // ---- geometry ----------------------------------------------------------------------------
  function measure() {
    var probe = document.createElement('div');
    probe.className = 'row';
    probe.style.visibility = 'hidden';
    probe.textContent = 'X';
    rowsEl.appendChild(probe);
    var h = probe.getBoundingClientRect().height;
    rowsEl.removeChild(probe);
    if (h >= 8) S.rowH = h;
    S.vis = Math.max(1, Math.floor(list.clientHeight / S.rowH));
  }
  function maxTop() { return Math.max(0, S.total - S.vis); }
  function setTop(v) { S.top = clamp(v, 0, maxTop()); }

  // ---- drawing -----------------------------------------------------------------------------
  function segments(row) {
    var text = row.t;
    var marks = [];
    var i;
    if (row.h) for (i = 0; i < row.h.length; i++) marks.push({ s: row.h[i][0], e: row.h[i][1], c: 'hl' + row.h[i][2] });
    if (row.s) for (i = 0; i < row.s.length; i++) marks.push({ s: row.s[i][0], e: row.s[i][1], c: 'm' + (row.i === S.matchRow ? ' curmatch' : ''), mark: true });
    if (!marks.length) return null;
    var cuts = [0, text.length];
    marks.forEach(function (m) { cuts.push(clamp(m.s, 0, text.length), clamp(m.e, 0, text.length)); });
    cuts = cuts.filter(function (v, k, a) { return a.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
    var frag = document.createDocumentFragment();
    for (var k = 0; k < cuts.length - 1; k++) {
      var a = cuts[k];
      var b = cuts[k + 1];
      if (b <= a) continue;
      var piece = text.slice(a, b);
      var inside = marks.filter(function (m) { return m.s <= a && m.e >= b; });
      var node = document.createTextNode(piece);
      var hlOnly = inside.filter(function (m) { return !m.mark; })[0];
      var search = inside.filter(function (m) { return m.mark; })[0];
      if (hlOnly) { var sp = document.createElement('span'); sp.className = hlOnly.c; sp.appendChild(node); node = sp; }
      if (search) { var mk = document.createElement('mark'); mk.className = search.c; mk.appendChild(node); node = mk; }
      frag.appendChild(node);
    }
    return frag;
  }

  function build(el, idx, row) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var ln = document.createElement('span'); ln.className = 'ln'; ln.setAttribute('role', 'gridcell');
    var lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.setAttribute('role', 'gridcell');
    var txt = document.createElement('span'); txt.className = 'txt'; txt.setAttribute('role', 'gridcell');
    el.className = 'row';
    if (!row) {
      el.classList.add('placeholder');
      ln.textContent = '';
      txt.textContent = row === null ? '(line not available)' : 'loading...';
      el.appendChild(ln); el.appendChild(lvl); el.appendChild(txt);
      return;
    }
    ln.textContent = (row.b ? '● ' : '') + fmt(row.n);
    if (row.b) { el.classList.add('bookmarked'); ln.classList.add('bm'); }
    if (S.info && S.info.colour && row.l !== undefined) {
      el.classList.add('lv-' + row.l);
      lvl.textContent = LV[row.l];
      lvl.setAttribute('aria-label', LVNAME[row.l]);
    } else lvl.setAttribute('aria-label', 'no level');
    el.appendChild(ln); el.appendChild(lvl);
    if (row.tag) { var tag = document.createElement('span'); tag.className = 'tag'; tag.setAttribute('role', 'gridcell'); tag.textContent = '[' + row.tag + ']'; el.appendChild(tag); }
    var seg = segments(row);
    if (seg) txt.appendChild(seg); else txt.textContent = row.t;
    if (row.x) { var more = document.createElement('span'); more.className = 'more'; more.textContent = ' … [line continues: ' + fmt(row.bl) + ' bytes in total; select it to see more]'; txt.appendChild(more); }
    el.appendChild(txt);
  }

  function render() {
    var first = Math.floor(S.top);
    var frac = S.top - first;
    rowsEl.style.transform = 'translateY(' + (-frac * S.rowH) + 'px)';
    var count = Math.max(0, Math.min(S.total - first, S.vis + 2));
    while (S.pool.length < count) {
      var el = document.createElement('div');
      el.setAttribute('role', 'row');
      rowsEl.appendChild(el);
      S.pool.push(el);
    }
    var selLo = Math.min(S.anchor, S.cursor);
    var selHi = Math.max(S.anchor, S.cursor);
    for (var k = 0; k < S.pool.length; k++) {
      var e = S.pool[k];
      if (k >= count) { e.classList.add('hidden'); e._k = ''; continue; }
      e.classList.remove('hidden');
      var idx = first + k;
      var row = S.cache.has(idx) ? S.cache.get(idx) : undefined;
      var key = S.gen + '|' + idx + '|' + (row === undefined ? 0 : row === null ? 2 : 1) + '|' + (idx === S.matchRow ? 1 : 0);
      if (e._k !== key) { build(e, idx, row); e._k = key; }
      e.id = 'r-' + k;
      e.setAttribute('aria-rowindex', String(idx + 1));
      e.setAttribute('aria-selected', idx >= selLo && idx <= selHi ? 'true' : 'false');
      e.classList.toggle('sel', idx >= selLo && idx <= selHi);
      e.classList.toggle('cur', idx === S.cursor);
      if (idx === S.cursor) list.setAttribute('aria-activedescendant', e.id);
    }
    list.setAttribute('aria-rowcount', String(S.total));
    updateScrollbar();
    ensureRows(first, count);
  }

  function updateScrollbar() {
    var h = sb.clientHeight;
    var span = Math.max(1, S.total);
    var th = clamp(h * Math.min(1, S.vis / span), 24, Math.max(24, h));
    thumb.style.height = th + 'px';
    var mt = maxTop();
    thumb.style.top = (mt > 0 ? (S.top / mt) * (h - th) : 0) + 'px';
    var pct = mt > 0 ? Math.round(S.top / mt * 100) : 0;
    sb.setAttribute('aria-valuenow', String(pct));
    sb.setAttribute('aria-valuetext', 'line ' + fmt(Math.floor(S.top) + 1) + ' of ' + fmt(S.total));
  }

  // ---- fetching rows -------------------------------------------------------------------------
  function ensureRows(first, count) {
    // A request that was never answered (an error in the extension) must not block drawing for ever.
    if (S.inflight && Date.now() - S.inflight.t > 8000) S.inflight = null;
    if (S.inflight || S.total === 0) return;
    var lo = Math.max(0, first - S.vis);
    var hi = Math.min(S.total, first + count + S.vis);
    var start = -1;
    for (var i = lo; i < hi; i++) { if (!S.cache.has(i)) { start = i; break; } }
    if (start < 0) return;
    var n = Math.min(400, hi - start);
    S.inflight = { id: ++S.seq, first: start, count: n, gen: S.gen, t: Date.now() };
    send({ type: 'rows', id: S.inflight.id, first: start, count: n });
  }

  function trimCache() {
    if (S.cache.size <= CACHE_MAX) return;
    var center = Math.floor(S.top);
    var keys = Array.from(S.cache.keys()).sort(function (a, b) { return Math.abs(b - center) - Math.abs(a - center); });
    for (var i = 0; i < keys.length - CACHE_MAX + 500 && i < keys.length; i++) S.cache.delete(keys[i]);
  }

  function resetCache() { S.cache.clear(); S.gen++; S.inflight = null; }

  // ---- movement ------------------------------------------------------------------------------
  function ensureVisible(idx, center) {
    if (center) { setTop(idx - Math.floor(S.vis / 2)); return; }
    if (idx < Math.floor(S.top)) setTop(idx);
    else if (idx > Math.floor(S.top) + S.vis - 1) setTop(idx - S.vis + 1);
  }

  function moveCursor(to, extend, center) {
    if (S.total === 0) return;
    S.cursor = clamp(to, 0, S.total - 1);
    if (!extend) S.anchor = S.cursor;
    ensureVisible(S.cursor, center);
    render();
    scheduleView();
  }

  function scheduleView() {
    clearTimeout(S.viewTimer);
    S.viewTimer = setTimeout(function () {
      send({ type: 'view', cursor: S.cursor, top: Math.floor(S.top), total: S.total });
      requestDetails();
    }, 120);
  }

  function gotoRow(row, center) {
    if (row === null || row === undefined) return;
    S.matchRow = -1;
    moveCursor(row, false, center !== false);
  }

  // ---- details -----------------------------------------------------------------------------
  function requestDetails() {
    clearTimeout(S.detailTimer);
    S.detailTimer = setTimeout(function () { if (S.total > 0) send({ type: 'details', row: S.cursor }); }, 60);
  }

  function btn(label, handler, aria) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', handler);
    return b;
  }

  function showDetails(d) {
    var box = $('details');
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!d) return;
    S.detailRow = d.row;
    var meta = document.createElement('div');
    meta.className = 'meta';
    var bits = ['Line ' + fmt(d.n)];
    if (d.o !== undefined) bits.push('byte offset ' + fmt(d.o));
    bits.push(fmt(d.bl) + ' bytes');
    if (d.level) bits.push(d.level);
    if (d.time) bits.push(d.time);
    if (d.tag) bits.push(d.tag);
    meta.textContent = bits.join(' · ');
    box.appendChild(meta);
    var pre = document.createElement('pre');
    pre.id = 'detailText';
    pre.textContent = d.text;
    box.appendChild(pre);
    if (d.truncated) {
      var note = document.createElement('div');
      note.className = 'meta';
      note.textContent = 'This line is longer than ' + fmt(d.text.length) + ' characters; the first part is shown.';
      box.appendChild(note);
    }
    var actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(btn('Copy line', function () { send({ type: 'copy', from: d.row, to: d.row }); }));
    if (d.looksJson) actions.appendChild(btn('Pretty-print JSON (Pro)', function () { send({ type: 'pretty', row: d.row }); }));
    actions.appendChild(btn('Show parsed fields (Pro)', function () { send({ type: 'fields', row: d.row }); }));
    box.appendChild(actions);
  }

  // ---- table (Pro) --------------------------------------------------------------------------
  function showTable(m) {
    var wrap = $('tableWrap');
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    if (!m || !m.ok) { wrap.classList.add('hidden'); S.table = null; if (m && m.message) say(m.message, 'warn'); return; }
    S.table = m;
    wrap.classList.remove('hidden');
    var bar = document.createElement('div');
    bar.id = 'tableBar';
    var info = document.createElement('span');
    info.textContent = 'Rows ' + fmt(m.first + 1) + ' to ' + fmt(m.first + m.window) + ' of ' + fmt(m.total) + (m.sorted ? ', sorted by ' + m.sorted.col + (m.sorted.dir === 'desc' ? ' (descending)' : '') : '') + '. Sorting applies to this window only.';
    bar.appendChild(btn('Previous window', function () { requestTable(Math.max(0, m.first - 500), m.sorted); }));
    bar.appendChild(btn('Next window', function () { if (m.first + 500 < m.total) requestTable(m.first + 500, m.sorted); }));
    bar.appendChild(btn('Close table', function () { showTable(null); list.focus(); }));
    bar.appendChild(info);
    wrap.appendChild(bar);
    var table = document.createElement('table');
    table.setAttribute('aria-label', 'Parsed lines');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var th0 = document.createElement('th'); th0.textContent = 'Line'; hr.appendChild(th0);
    m.columns.forEach(function (c) {
      var th = document.createElement('th');
      th.setAttribute('scope', 'col');
      var b = btn(c + (m.sorted && m.sorted.col === c ? (m.sorted.dir === 'desc' ? ' ▼' : ' ▲') : ''), function () {
        var dir = m.sorted && m.sorted.col === c && m.sorted.dir === 'asc' ? 'desc' : 'asc';
        requestTable(m.first, { col: c, dir: dir });
      }, 'Sort by ' + c);
      th.appendChild(b);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    m.rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var td0 = document.createElement('td'); td0.textContent = fmt(r.n); tr.appendChild(td0);
      r.cells.forEach(function (c) { var td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }
  function requestTable(first, sort) { send({ type: 'table', first: first, sort: sort || null }); }

  // ---- search and filter ----------------------------------------------------------------------
  function searchSpec() { return { text: $('find').value, regex: S.opt.r, caseSensitive: S.opt.c, wholeWord: S.opt.w }; }
  function doSearch(dir, from, count) {
    var spec = searchSpec();
    S.searchSeq++;
    resetCache();
    if (!spec.text) { $('count').textContent = ''; send({ type: 'search', id: S.searchSeq, spec: spec, dir: dir, from: from }); S.matchRow = -1; render(); return; }
    $('count').textContent = 'Searching...';
    send({ type: 'search', id: S.searchSeq, spec: spec, dir: dir, from: from, count: count !== false });
  }
  function filterSpec() {
    var levels = [];
    Object.keys(S.levels).forEach(function (k) { if (S.levels[k]) levels.push(Number(k)); });
    return { text: $('filter').value, regex: S.opt.r, caseSensitive: S.opt.c, wholeWord: S.opt.w, levels: levels };
  }
  function doFilter() {
    clearTimeout(S.filterTimer);
    var spec = filterSpec();
    if (!spec.text && !spec.levels.length) { send({ type: 'clearFilter', anchor: S.cursor }); return; }
    send({ type: 'filter', spec: spec });
  }

  // ---- messages from the extension ----------------------------------------------------------
  var handlers = {
    init: function (m) {
      S.info = m.info;
      S.total = m.info.total;
      document.title = m.info.title;
      $('followBtn').classList.toggle('hidden', !m.info.canFollow);
      $('pauseBtn').classList.toggle('hidden', !m.info.canFollow);
      if (m.info.binary) say('This file looks binary (it contains NUL bytes that are not UTF-16 text). It is shown as text; control characters appear as symbols.', 'warn');
      measure();
      resetCache(); setTop(S.top); render();
      status(m.info.sizeText + ' · ' + m.info.encodingLabel + (m.info.complete ? ' · ' + fmt(m.info.total) + ' lines' : ' · indexing...'));
      if (m.info.complete && m.info.total === 0) say('This log has no lines.', '');
      scheduleView();
    },
    rows: function (m) {
      // A reply to an earlier request (the cache was reset since, or a newer request is waiting) is ignored: the
      // request that is in flight now will be answered. Clearing it here would start an endless chase of stale replies.
      if (!S.inflight) { render(); return; }
      if (S.inflight.id !== m.id) return;
      if (S.inflight.gen !== S.gen) { S.inflight = null; render(); return; }
      var got = {};
      m.rows.forEach(function (r) { got[r.i] = true; S.cache.set(r.i, r); });
      for (var i = S.inflight.first; i < S.inflight.first + S.inflight.count; i++) if (!got[i] && i < m.total) S.cache.set(i, null);
      S.inflight = null;
      trimCache();
      if (m.total !== S.total) { S.total = m.total; setTop(S.top); }
      render();
    },
    total: function (m) {
      var atEnd = S.follow.on && !S.follow.paused;
      S.total = m.total;
      if (atEnd) { setTop(maxTop()); S.cursor = Math.max(0, S.total - 1); S.anchor = S.cursor; }
      if (m.added) say(S.follow.paused ? fmt(m.added) + ' new lines (follow is paused).' : '', '');
      render();
      if (atEnd) scheduleView();
    },
    progress: function (m) {
      S.total = m.total;
      S.indexing = true;
      var pct = m.size ? Math.min(99, Math.floor(m.scanned / m.size * 100)) : 0;
      status('Indexing: ' + pct + '% · ' + fmt(m.lines) + ' lines so far · you can already scroll and search the indexed part');
      render();
    },
    indexed: function (m) {
      S.indexing = false;
      S.total = m.total;
      status((S.info ? S.info.sizeText + ' · ' + S.info.encodingLabel + ' · ' : '') + fmt(m.total) + ' lines' + (m.cached ? ' (saved index)' : ''));
      render();
    },
    found: function (m) {
      if (m.error) { say(m.error, 'error'); $('count').textContent = ''; return; }
      say('', '');
      if (m.cleared) { S.matchRow = -1; render(); return; }
      if (m.none) { $('count').textContent = m.partial ? 'No match so far (still indexing)' : 'No match'; S.matchRow = -1; render(); return; }
      S.matchRow = m.row;
      moveCursor(m.row, false, true);
      if (m.wrapped) say('Search wrapped around to the other end of the log.', '');
      if (m.longLines) say(fmt(m.longLines) + ' line(s) are longer than 1,048,576 characters and were searched only in their first 1,048,576 characters.', 'warn');
    },
    count: function (m) {
      if (m.error) { say(m.error, 'error'); $('count').textContent = ''; return; }
      if (m.empty) { $('count').textContent = ''; return; }
      $('count').textContent = (m.done ? '' : 'at least ') + fmt(m.matches) + (m.matches === 1 ? ' line' : ' lines') + (m.done ? '' : ' (' + (m.total ? Math.floor(m.scanned / m.total * 100) : 0) + '% scanned)') + (m.done && m.complete === false ? ' so far (indexing)' : '');
      if (m.done && m.longLines) say(fmt(m.longLines) + ' line(s) were longer than 1,048,576 characters; only their first 1,048,576 characters were searched.', 'warn');
    },
    filter: function (m) {
      var info = $('filterInfo');
      if (m.state === 'error') { say(m.message, 'error'); info.textContent = ''; return; }
      if (m.state === 'cleared') {
        S.filtering = false; info.textContent = ''; resetCache(); S.total = m.total; S.matchRow = -1; say('', '');
        S.top = 0; S.cursor = 0; S.anchor = 0;
        if (m.row !== undefined) { S.cursor = m.row; S.anchor = m.row; ensureVisible(m.row, true); }
        render(); scheduleView(); return;
      }
      if (!S.filtering) { S.filtering = true; resetCache(); S.top = 0; S.cursor = 0; S.anchor = 0; }
      S.total = m.total;
      if (m.state === 'running' && m.waiting) info.textContent = 'waiting for the line index...';
      else if (m.state === 'running') info.textContent = fmt(m.matches) + ' lines match so far (' + (m.scanTotal ? Math.floor(m.scanned / m.scanTotal * 100) : 0) + '% scanned)';
      else {
        info.textContent = fmt(m.matches) + ' lines match' + (m.state === 'cancelled' ? ' (cancelled; the list is incomplete)' : '');
        if (m.limited) say('The filter stopped at ' + fmt(m.limit) + ' matching lines (the setting bigLogAtlas.filter.maxMatches), so the list is incomplete. Narrow the filter.', 'warn');
        else if (m.longLines) say(fmt(m.longLines) + ' line(s) were longer than 1,048,576 characters and were filtered by their first 1,048,576 characters only.', 'warn');
        else say('', '');
      }
      render(); scheduleView();
    },
    follow: function (m) {
      S.follow.on = m.on; S.follow.paused = m.paused;
      $('followBtn').setAttribute('aria-pressed', m.on ? 'true' : 'false');
      $('pauseBtn').setAttribute('aria-pressed', m.paused ? 'true' : 'false');
      $('pauseBtn').disabled = !m.on;
      if (m.on && !m.paused) { setTop(maxTop()); S.cursor = Math.max(0, S.total - 1); S.anchor = S.cursor; render(); scheduleView(); }
    },
    reset: function (m) {
      resetCache(); S.total = m.total; S.top = 0; S.cursor = 0; S.anchor = 0; S.matchRow = -1; S.filtering = false;
      $('filterInfo').textContent = '';
      if (S.follow.on && !S.follow.paused) { setTop(maxTop()); S.cursor = Math.max(0, S.total - 1); S.anchor = S.cursor; }
      say(m.message || '', '');
      render(); scheduleView();
    },
    goto: function (m) {
      if (!m.ok) { if (m.needsPro) return; say(m.message || 'That position was not found.', 'warn'); return; }
      say(m.exact === false ? 'That line is not in the filtered view; showing the next line that is.' : '', '');
      gotoRow(m.row, true);
    },
    bookmark: function (m) {
      if (!m.ok) { if (m.message) say(m.message, 'warn'); return; }
      resetCache(); render();
      say(m.set ? 'Bookmark set (' + fmt(m.count) + ' in this log).' : 'Bookmark removed.', '');
    },
    copied: function (m) { say(m.ok ? 'Copied ' + fmt(m.lines) + (m.lines === 1 ? ' line' : ' lines') + (m.limited ? ' (stopped at the copy limit)' : '') + '.' : (m.message || ''), m.ok ? '' : 'warn'); },
    expanded: function () {},
    details: function (m) { if (m.row === S.cursor) showDetails(m.d); },
    pretty: function (m) {
      if (m.locked) return;
      if (!m.ok) { say(m.message || 'Could not format the line.', 'warn'); return; }
      var pre = $('detailText');
      if (pre) pre.textContent = m.text;
    },
    fields: function (m) {
      if (m.locked) return;
      if (!m.ok) { say(m.message || '', 'warn'); return; }
      var box = $('details');
      var old = $('fieldsTable');
      if (old) old.parentNode.removeChild(old);
      var t = document.createElement('table');
      t.id = 'fieldsTable';
      t.setAttribute('aria-label', 'Parsed fields');
      (m.fields || []).forEach(function (kv) {
        var tr = document.createElement('tr');
        var a = document.createElement('th'); a.setAttribute('scope', 'row'); a.textContent = kv[0];
        var b = document.createElement('td'); b.textContent = kv[1];
        tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
      });
      box.appendChild(t);
      if (m.message) say(m.message, 'warn');
    },
    table: function (m) { showTable(m); },
    banner: function (m) { say(m.text, m.kind || ''); },
    info: function (m) { S.info = m.info; $('tableBtn').textContent = m.info.pro ? 'Table: ' + m.info.profile : 'Table (Pro)'; },
    cmd: function (m) {
      if (m.name === 'findNext') doSearch('next', S.cursor);
      else if (m.name === 'findPrev') doSearch('prev', S.cursor);
      else if (m.name === 'copy') send({ type: 'copy', from: S.anchor, to: S.cursor });
      else if (m.name === 'focusFind') { $('find').focus(); $('find').select(); }
      else if (m.name === 'focusGoto') { $('goto').focus(); $('goto').select(); }
      else if (m.name === 'table') requestTable(Math.floor(S.top), null);
      else if (m.name === 'rowsChanged') { resetCache(); render(); }
    },
    filterSpec: function (m) {
      $('filter').value = m.spec.text || '';
      S.opt.c = !!m.spec.caseSensitive; S.opt.w = !!m.spec.wholeWord; S.opt.r = !!m.spec.regex;
      $('optCase').setAttribute('aria-pressed', S.opt.c ? 'true' : 'false');
      $('optWord').setAttribute('aria-pressed', S.opt.w ? 'true' : 'false');
      $('optRegex').setAttribute('aria-pressed', S.opt.r ? 'true' : 'false');
      S.levels = {};
      (m.spec.levels || []).forEach(function (r) { S.levels[r] = true; });
      Array.prototype.forEach.call(document.querySelectorAll('.lvbtn'), function (b) { b.setAttribute('aria-pressed', S.levels[Number(b.getAttribute('data-rank'))] ? 'true' : 'false'); });
    },
    error: function (m) { say(m.message, 'error'); }
  };

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && handlers[m.type]) handlers[m.type](m);
  });

  // ---- input -----------------------------------------------------------------------------------
  list.addEventListener('wheel', function (e) {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    var rows = e.deltaMode === 1 ? e.deltaY : e.deltaY / S.rowH;
    setTop(S.top + rows);
    render();
    scheduleView();
  }, { passive: false });

  function rowAt(ev) {
    var rect = list.getBoundingClientRect();
    var y = ev.clientY - rect.top + (S.top - Math.floor(S.top)) * S.rowH;
    return clamp(Math.floor(S.top) + Math.floor(y / S.rowH), 0, Math.max(0, S.total - 1));
  }
  list.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    list.focus();
    var r = rowAt(e);
    S.cursor = r;
    if (!e.shiftKey) S.anchor = r;
    render();
    scheduleView();
  });

  list.addEventListener('keydown', function (e) {
    var k = e.key;
    var ctrl = e.ctrlKey || e.metaKey;
    var handled = true;
    if (k === 'ArrowDown') moveCursor(S.cursor + 1, e.shiftKey);
    else if (k === 'ArrowUp') moveCursor(S.cursor - 1, e.shiftKey);
    else if (k === 'PageDown') moveCursor(S.cursor + S.vis, e.shiftKey);
    else if (k === 'PageUp') moveCursor(S.cursor - S.vis, e.shiftKey);
    else if (k === 'Home' && ctrl) moveCursor(0, e.shiftKey);
    else if (k === 'End' && ctrl) moveCursor(S.total - 1, e.shiftKey);
    else if (k === 'Home') { list.scrollLeft = 0; }
    else if (k === 'End') { list.scrollLeft = list.scrollWidth; }
    else if (ctrl && (k === 'c' || k === 'C')) send({ type: 'copy', from: S.anchor, to: S.cursor });
    else if (ctrl && (k === 'a' || k === 'A')) { S.anchor = 0; S.cursor = Math.max(0, S.total - 1); render(); }
    else if (ctrl && (k === 'f' || k === 'F')) { $('find').focus(); $('find').select(); }
    else if (ctrl && (k === 'g' || k === 'G')) { $('goto').focus(); $('goto').select(); }
    else if (k === 'F3' && e.shiftKey) doSearch('prev', S.cursor);
    else if (k === 'F3') doSearch('next', S.cursor);
    else if (k === 'F2' && ctrl) send({ type: 'bookmark', row: S.cursor });
    else if (k === 'F2') send({ type: 'bookmarkJump', row: S.cursor, dir: e.shiftKey ? 'prev' : 'next' });
    else if (k === 'Escape') { send({ type: 'cancel' }); S.matchRow = -1; resetCache(); render(); }
    else handled = false;
    if (handled) e.preventDefault();
  });

  // custom scrollbar
  var drag = null;
  thumb.addEventListener('mousedown', function (e) { drag = { y: e.clientY, top: S.top }; e.preventDefault(); });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var h = sb.clientHeight;
    var th = thumb.clientHeight;
    var room = Math.max(1, h - th);
    setTop(drag.top + (e.clientY - drag.y) / room * maxTop());
    render();
  });
  window.addEventListener('mouseup', function () { if (drag) { drag = null; scheduleView(); } });
  sb.addEventListener('mousedown', function (e) {
    if (e.target === thumb) return;
    var rect = thumb.getBoundingClientRect();
    setTop(S.top + (e.clientY < rect.top ? -S.vis : S.vis));
    render(); scheduleView();
  });

  // toolbar
  $('find').addEventListener('input', function () { clearTimeout(S.findTimer); S.findTimer = setTimeout(function () { doSearch('next', S.cursor - 1); }, 250); });
  $('find').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(S.findTimer); doSearch(e.shiftKey ? 'prev' : 'next', S.cursor); }
    else if (e.key === 'Escape') { list.focus(); }
    else if (e.key === 'F3') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next', S.cursor); }
  });
  $('nextBtn').addEventListener('click', function () { doSearch('next', S.cursor); });
  $('prevBtn').addEventListener('click', function () { doSearch('prev', S.cursor); });
  $('filter').addEventListener('input', function () { clearTimeout(S.filterTimer); S.filterTimer = setTimeout(doFilter, 450); });
  $('filter').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doFilter(); } else if (e.key === 'Escape') list.focus(); });
  $('clearBtn').addEventListener('click', function () {
    $('filter').value = '';
    Array.prototype.forEach.call(document.querySelectorAll('.lvbtn'), function (b) { b.setAttribute('aria-pressed', 'false'); });
    S.levels = {};
    send({ type: 'clearFilter', anchor: S.cursor });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.lvbtn'), function (b) {
    b.addEventListener('click', function () {
      var r = Number(b.getAttribute('data-rank'));
      S.levels[r] = !S.levels[r];
      b.setAttribute('aria-pressed', S.levels[r] ? 'true' : 'false');
      doFilter();
    });
  });
  [['optCase', 'c'], ['optWord', 'w'], ['optRegex', 'r']].forEach(function (p) {
    $(p[0]).addEventListener('click', function () {
      S.opt[p[1]] = !S.opt[p[1]];
      $(p[0]).setAttribute('aria-pressed', S.opt[p[1]] ? 'true' : 'false');
      if ($('find').value) doSearch('next', S.cursor - 1);
      if ($('filter').value) doFilter();
    });
  });
  $('goto').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); send({ type: 'goto', text: $('goto').value }); list.focus(); }
    else if (e.key === 'Escape') list.focus();
  });
  $('followBtn').addEventListener('click', function () { send({ type: 'follow', on: !S.follow.on }); });
  $('pauseBtn').addEventListener('click', function () { send({ type: 'pause', on: !S.follow.paused }); });
  $('tableBtn').addEventListener('click', function () { requestTable(Math.floor(S.top), null); });
  $('encBtn').addEventListener('click', function () { send({ type: 'encodingMenu' }); });

  function onResize() { measure(); setTop(S.top); render(); }
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(list);

  measure();
  $('pauseBtn').disabled = true;
  send({ type: 'ready' });
  list.focus();
}());
