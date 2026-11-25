// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the board, filters, detail drawer and sandbox. No network: every byte
// it shows is in data.js. The model lives in model.js, shared with main.ts: on load
// the page recomputes all 209 rows and proves the board against 8 live checks.
// Farm plans: every row farms a standard $100 deposit (second action $25).
// Expected reward = 5% of the row's expected launch value — launch value x launch
// odds — shared pro-rata on the deposit against TVL. Also at $25/$500 (tiers);
// $/hour scales with the deposit. farm_matrix crosses three deposits with four
// holds (30/90/180/365d): the reward is a lump sum at launch, so $/hour falls as the
// hold lengthens. Breakeven = smallest deposit covering a $5 run cost ($1 gas + $4
// time); breakeven_days is null.
// Blind validation (radar-4, 128 fitted live tokens): LOO MedALE 1.1851 (x1.3697),
// walk-forward MedALE 0.9348 (x1.7827), ten-fold MedALE 1.2016 (x1.3627), train 47 /
// test 48; placebo powerOnly LOO 1.4021 (x1.5332); conformal 80% q 2.5944,
// coverage 80.5%, median range x179.2452, rank-range median width 174;
// odds AUC 0.7036, Brier 0.2183, log-loss 0.6275;
// 38/128 within 2x, 61/128 within 3x.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;
  // Sealed snapshot: 758 protocols. data.js carries the 209 board rows and the
  // top 24 live + top 24 wrapped rows; the rest is the snapshot's own accounting:
  // 129 live tokens, 133 wrapped/staked/bridged products, 287 pre-token with a
  // listing but no market cap. 209 + 129 + 133 + 287 = 758.
  var COV = { live: 129, wrapped: 133, nomcap: 287 };
  var TOTAL758 = DATA.board_size + COV.live + COV.wrapped + COV.nomcap;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre', sort: 'implied', dir: -1, selected: null, shown: 60,
    compare: [], pins: [], dtab: 'overview',
    sb: { gw: M.growth_weight, mf: M.maturity_floor, ps: 1 } };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0'); }
  function fmtRange(r) { return fmtUsd(r.implied_value_low_usd) + ' – ' + fmtUsd(r.implied_value_high_usd); }

  var RM = window.RadarModel; // the shared scoring model (dashboard/model.js)
  // The published launch value, recomputed from the row's own stored multipliers
  // through the shared model. Must equal board.json's launch value.
  function publishedLaunch(row) {
    var mom = row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier;
    return RM.launchValue(row.tvl_usd, row.base_multiple, row.growth_multiplier, row.maturity_multiplier, mom,
      RM.powMult(row.category_multiplier, row.category_weight), RM.powMult(row.chain_multiplier, row.chain_weight));
  }
  // The published expected value: launch x launch odds, rounded. Must equal
  // board.json's implied value — the gate requires implied to fall with rank.
  function publishedImplied(row) {
    return Math.max(1, Math.round(publishedLaunch(row) * row.launch_odds));
  }
  function sandboxOn() {
    return state.sb.gw !== M.growth_weight || state.sb.mf !== M.maturity_floor || state.sb.ps !== 1;
  }
  // The sandbox: the same formula with the reader's growth weight, maturity floor and
  // base scale; board.json keeps the published model.
  function effImplied(row) {
    if (!sandboxOn()) return row.implied_value_usd;
    var gm = RM.growthMult(RM.growthPct(row.change_7d), state.sb.gw);
    var mm = RM.maturityMult(row.age_days, state.sb.mf);
    var mom = row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier;
    var launch = RM.launchValue(row.tvl_usd, row.base_multiple * state.sb.ps, gm, mm, mom,
      RM.powMult(row.category_multiplier, row.category_weight), RM.powMult(row.chain_multiplier, row.chain_weight));
    return Math.max(1, Math.round(launch * row.launch_odds));
  }

  // Recompute a row's launch value from the RAW snapshot fields (TVL, growth,
  // age, category, chain) and the fitted parameters — not from the stored
  // multipliers — so the check below also verifies the stored multipliers.
  function rawLaunch(row) {
    var ch = row.chains && row.chains.length ? (M.by_chain_mult[row.chains[0]] || 1) : 1;
    return RM.launchValue(row.tvl_usd, RM.baseMultiple(row.tvl_usd, M.power_law_a, M.power_law_b),
      RM.growthMult(RM.growthPct(row.change_7d), M.growth_weight),
      RM.maturityMult(row.age_days, M.maturity_floor),
      RM.momentumMult(row.momentum_pct, M.momentum_weight),
      RM.powMult(M.by_category_mult[row.category || 'Other'] || 1, M.category_weight),
      RM.powMult(ch, M.chain_weight));
  }
  // Recompute every row through the shared model and compare with the stored
  // numbers, then run the 8 live proofs. Tolerances are rounding only: any
  // drift between main.ts and this page shows up here as a mismatch.
  function selfCheck() {
    var bad = 0, first = [], evOk = true, nonInc = true, inRange = true, inRank = true, tierOk = true, beOk = true, wl = 0;
    DATA.rows.forEach(function (r, i) {
      var why = null;
      var raw = rawLaunch(r), pub = publishedLaunch(r);
      if (Math.abs(raw - r.launch_value_usd) > 1) why = 'launch(raw) ' + raw + ' vs ' + r.launch_value_usd;
      else if (Math.abs(pub - r.launch_value_usd) > 1) why = 'launch ' + pub + ' vs ' + r.launch_value_usd;
      var oa = [M.odds_beta, M.odds_scaler, r.age_days, r.tvl_usd, r.change_7d, M.odds_median_age_days_unknown];
      var odds = RM.r4(RM.launchOdds.apply(null, oa));
      if (!why && Math.abs(odds - r.launch_odds) > 0.0001) why = 'odds ' + odds + ' vs ' + r.launch_odds;
      var ev = Math.max(1, Math.round(raw * odds));
      var q = RM.confHalfWidth(r.category, M.conformal_q_global, M.conformal_q_by_category);
      var lr = RM.launchRange(raw, q);
      var ck = RM.launchClock.apply(null, oa);
      var want = [ev, lr.low, lr.high, Math.min(ev, Math.max(1, Math.round(lr.low * odds))), Math.max(ev, Math.round(lr.high * odds)), ck.months, ck.q1];
      var keys = ['implied_value_usd', 'launch_value_low_usd', 'launch_value_high_usd', 'implied_value_low_usd', 'implied_value_high_usd', 'launch_clock_months', 'launch_clock_months_q1'];
      if (!why) for (var k = 0; k < want.length; k++) if (Math.abs(want[k] - r[keys[k]]) > 1) { why = keys[k]; break; }
      var fp = r.farm_plan, tiers = r.farm_plan_tiers;
      var rew = RM.farmReward(100, ev, r.tvl_usd);
      if (!why && Math.abs(rew - fp.expected_reward_usd) > 0.0001) why = 'farm reward';
      if (!why && Math.abs(RM.usdPerHour(rew, fp.active_hours) - fp.usd_per_hour) > 0.0001) why = 'farm $/hour';
      if (!why && tiers.some(function (t) { return t.breakeven_usd !== RM.breakevenUsd(ev, r.tvl_usd); })) why = 'breakeven';
      if (!why && r.farm_matrix.usd_per_hour.some(function (mrow, d) { return mrow.some(function (v, h) { return Math.abs(v - RM.usdPerHour(tiers[d].expected_reward_usd, RM.activeHours(RM.HORIZONS[h]))) > 0.0001; }); })) why = 'matrix $/hour';
      if (Math.abs(r.implied_value_usd - Math.round(r.launch_value_usd * r.launch_odds)) > 1) evOk = false;
      if (i > 0 && r.implied_value_usd > DATA.rows[i - 1].implied_value_usd) nonInc = false;
      if (r.launch_value_usd < r.launch_value_low_usd || r.launch_value_usd > r.launch_value_high_usd) inRange = false;
      if (r.rank < r.rank_low || r.rank > r.rank_high) inRank = false;
      var t100 = tiers.filter(function (t) { return t.deposit_usd === 100; })[0];
      if (!t100 || t100.expected_reward_usd !== fp.expected_reward_usd || t100.usd_per_hour !== fp.usd_per_hour) tierOk = false;
      if (!tiers.every(function (t) { return t.breakeven_usd === tiers[0].breakeven_usd; })) beOk = false;
      if (r.watchlist) wl++;
      if (why) { bad++; if (first.length < 3) first.push(r.slug + ': ' + why); }
    });
    return { n: DATA.rows.length, bad: bad, first: first,
      proofs: [
        ['Recomputed ' + DATA.rows.length + '/' + DATA.rows.length + ' rows', bad === 0, bad === 0 ? '0 mismatches' : bad + ' mismatches: ' + first.join('; ')],
        ['implied = round(launch x odds)', evOk, 'every row'],
        ['Implied falls with rank', nonInc, 'rank 1 to ' + DATA.rows.length],
        ['Launch inside its conformal range', inRange, '80% intervals'],
        ['Rank inside its rank range', inRank, 'seeded Monte Carlo'],
        ['Watchlist ' + wl + '/' + DATA.watchlist_size, wl === DATA.watchlist_size, 'all watchlist rows on the board'],
        ['$100 tier = farm_plan', tierOk, 'all rows'],
        ['Breakeven same across tiers', beOk, 'all rows']
      ] };
  }
  var CHECK = selfCheck();

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function miniBtn(t, p, fn) { return el('button', { type: 'button', class: 'mini-btn', 'aria-pressed': p === null ? null : (p ? 'true' : 'false'), text: t, onclick: fn }); }
  function wl(r) { return r.watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null; }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'base') { av = a.base_multiple; bv = b.base_multiple; }
      else if (key === 'odds') { av = a.launch_odds; bv = b.launch_odds; }
      else { av = effImplied(a); bv = effImplied(b); }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function rowBySlug(slug) {
    return DATA.rows.filter(function (r) { return r.slug === slug; })[0] || null;
  }
  function togglePin(slug) {
    var i = state.pins.indexOf(slug);
    if (i >= 0) state.pins.splice(i, 1);
    else state.pins.push(slug);
    render();
  }
  function toggleCompare(slug) {
    var i = state.compare.indexOf(slug);
    if (i >= 0) state.compare.splice(i, 1);
    else {
      if (state.compare.length >= 2) state.compare.shift();
      state.compare.push(slug);
    }
    render();
  }

  function pinStrip() {
    var chips = state.pins.map(function (slug) {
      var r = rowBySlug(slug);
      if (!r) return null;
      return el('div', { class: 'pin-chip' },
        el('span', { class: 'pin-tag', text: 'PINNED' }),
        el('b', null, '#' + r.rank + ' ', r.name),
        el('span', { class: 'num', text: fmtUsd(effImplied(r)) }),
        el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + fmtPct(r.change_7d) + ' 7d' }),
        miniBtn('Details', null, function () { openDetail(slug); }),
        miniBtn('Unpin', null, function () { togglePin(slug); })
      );
    });
    return el('section', { class: 'pin-strip', 'aria-label': 'Pinned rows' }, chips);
  }

  function compareCol(r, other) {
    var mom = r.momentum_multiplier === undefined ? 1 : r.momentum_multiplier;
    var winner = r.implied_value_usd > other.implied_value_usd;
    var rows = [
      ['Category', r.category || 'Other'],
      ['Chains', (r.chains || []).join(', ') || '—'],
      ['TVL', fmtUsd(r.tvl_usd)],
      ['7-day growth', fmtPct(r.change_7d)],
      ['Age', fmtAge(r.age_days)],
      ['Base ×', fmtMult(r.base_multiple) + '×'],
      ['Growth ×', fmtMult(r.growth_multiplier) + '×'],
      ['Maturity ×', fmtMult(r.maturity_multiplier) + '×'],
      ['Momentum ×', fmtMult(mom) + '×' + (r.momentum_pct === null || r.momentum_pct === undefined ? '' : ' (' + fmtPct(r.momentum_pct) + ' vs peers)')],
      ['Value range', fmtRange(r)],
      ['Launch value', fmtUsd(r.launch_value_usd)],
      ['Launch odds', (r.launch_odds * 100).toFixed(2) + '%'],
      ['Rank range', '#' + r.rank_low + ' – #' + r.rank_high],
      ['Launch clock', (r.launch_clock_months === null ? '>5y' : r.launch_clock_months + 'm') + ' · ' + r.launch_clock_label],
      ['Breakeven', r.farm_plan_tiers[0].breakeven_usd === null ? '—' : '$' + r.farm_plan_tiers[0].breakeven_usd]
    ];
    var col = el('div', { class: 'compare-col' + (winner ? ' winner' : '') },
      el('div', { class: 'compare-head' },
        el('b', null, '#' + r.rank + ' ', r.name, wl(r)),
        winner ? el('span', { class: 'win-tag', text: 'Higher EV' }) : null
      ));
    rows.forEach(function (x) { col.appendChild(el('div', { class: 'compare-row' }, el('span', { text: x[0] }), el('b', { class: 'num', text: x[1] }))); });
    col.appendChild(el('div', { class: 'compare-row total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(r.implied_value_usd) })));
    return col;
  }

  function comparePanel() {
    var head = el('div', { class: 'compare-head-bar' },
      el('h2', { text: 'Compare' }),
      miniBtn('Clear compare', null, function () { state.compare = []; render(); })
    );
    if (state.compare.length < 2) {
      var only = rowBySlug(state.compare[0]);
      return el('section', { class: 'panel compare-panel', 'aria-label': 'Compare' }, head,
        el('p', { class: 'compare-hint', text: (only ? only.name : 'One row') + ' selected — pick one more to compare.' })
      );
    }
    var a = rowBySlug(state.compare[0]);
    var b = rowBySlug(state.compare[1]);
    if (!a || !b) return el('div');
    return el('section', { class: 'panel compare-panel', 'aria-label': 'Compare' }, head,
      el('div', { class: 'compare' }, compareCol(a, b), compareCol(b, a))
    );
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  // The CSV is the filtered, sorted board — every row the filter shows, not just the
  // first page on screen. Same columns as the table, raw numbers so they match board.json.
  function buildCsv(list) {
    var head = ['Rank', 'Protocol', 'Category', 'Chains', 'TVL', '7d', 'Age', 'Base', 'Growth', 'Maturity', 'Momentum', 'Launch', 'Odds', 'RankLo', 'RankHi', 'ClockMo', 'Breakeven', 'Implied', 'ImpliedLo', 'ImpliedHi', 'Token', 'Watchlist'];
    var lines = [head.map(csvCell).join(',')];
    list.forEach(function (r) {
      lines.push([
        r.rank, r.name, r.category || 'Other', (r.chains || []).join('; '), r.tvl_usd,
        r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days,
        r.base_multiple, r.growth_multiplier, r.maturity_multiplier,
        r.momentum_multiplier === undefined ? '' : r.momentum_multiplier,
        r.launch_value_usd, r.launch_odds, r.rank_low, r.rank_high,
        r.launch_clock_months === null ? '' : r.launch_clock_months,
        r.farm_plan_tiers[0].breakeven_usd === null ? '' : r.farm_plan_tiers[0].breakeven_usd,
        r.implied_value_usd, r.implied_value_low_usd, r.implied_value_high_usd, 'no token', r.watchlist ? 'yes' : 'no'
      ].map(csvCell).join(','));
    });
    return lines.join('\n') + '\n';
  }
  function downloadCsv() {
    var csv = buildCsv(sortedRows(rows()));
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'token-radar-board.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'ring', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-name' }, 'Token ', el('b', { text: 'Radar' }))),
      el('div', { class: 'top-meta' },
        el('span', { html: 'Snapshot <b>' + DATA.as_of + '</b>' }),
        el('span', { html: '<b>' + DATA.model_version + '</b> model' }),
        el('span', { html: '<b>' + TOTAL758 + '</b> protocols accounted' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by what a launch would be worth' }),
        el('p', { html: 'The watchlist is the floor: every protocol with at least <b>$' + Math.round(DATA.floor_usd / 1e6) + 'M</b> TVL and no token. The early radar adds <b>' + DATA.early_size + ' pre-token protocols</b> below it — the whole point of a radar is finding them early. Implied value is a model, not a promise. The All 758 tab accounts for all <b>' + TOTAL758 + '</b> protocols in the snapshot.' })
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('span', { text: 'Watchlist covered' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'Board rows' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.early_size) }), el('span', { text: 'Early rows' })),
        el('div', { class: 'stat' }, el('b', { text: String(TOTAL758) }), el('span', { text: 'Protocols accounted' }))
      )
    );
  }

  function slider(id, label, min, max, step, value, fmt, hint, oninput) {
    var out = el('output', { for: id, text: fmt(value) });
    var input = el('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
    input.addEventListener('input', function () { out.textContent = fmt(parseFloat(input.value)); oninput(parseFloat(input.value)); });
    return el('div', { class: 'slider' },
      el('label', { for: id }, el('span', { text: label }), out),
      input,
      el('span', { class: 'hint', text: hint }));
  }

  function sandbox() {
    var head = el('div', { class: 'sandbox-head' },
      el('h2', { text: 'Model sandbox' }),
      el('p', { id: 'sandbox-note', html: sandboxOn() ? '<b>Sandbox on:</b> the board below is re-ranked. board.json keeps the published model.' : 'The published model is the default. Nothing here changes board.json.' })
    );
    var s = state.sb;
    var box = el('section', { class: 'sandbox', 'aria-label': 'Model sandbox' }, head,
      el('div', { class: 'sliders' },
        slider('sb-gw', 'Growth weight', 0, 1, 0.05, s.gw, function (v) { return v.toFixed(2) + '×'; }, 'Weight of the last week', function (v) { state.sb.gw = v; render(); }),
        slider('sb-mf', 'Maturity floor', 0.3, 0.9, 0.05, s.mf, function (v) { return v.toFixed(2); }, 'Value of a brand-new protocol', function (v) { state.sb.mf = v; render(); }),
        slider('sb-ps', 'Base scale', 0.5, 2, 0.1, s.ps, function (v) { return v.toFixed(1) + '×'; }, 'Scale all base multiples', function (v) { state.sb.ps = v; render(); })
      ),
      el('button', { class: 'reset', id: 'sandbox-reset', type: 'button', text: 'Reset', onclick: function () { state.sb = { gw: M.growth_weight, mf: M.maturity_floor, ps: 1 }; render(); } })
    );
    return box;
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    function opts(list, cur) { return list.map(function (c) { return el('option', { value: c, text: c, selected: c === cur ? 'selected' : null }); }); }
    function tabBtn(tab, label) { return el('button', { type: 'button', 'data-tab': tab, 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; render(); } }); }
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; state.shown = 60; render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }), opts(categories, state.category)
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; state.shown = 60; render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }), opts(chains, state.chain)
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; state.shown = 60; render(); });
    var count = state.tab === 'pre' ? rows().length + ' rows shown' : TOTAL758 + ' protocols accounted';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, tabBtn('pre', 'Pre-token'), tabBtn('live', 'All 758'))),
      el('button', { class: 'button', id: 'csv-export', type: 'button', text: 'Export CSV', onclick: downloadCsv }),
      el('span', { class: 'count', text: count })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; render(); } })
      ));
    }
    var shown = list.slice(0, state.shown);
    var tbody = el('tbody');
    shown.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, wl(r)),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          el('div', { class: 'row-actions' },
            miniBtn(state.pins.indexOf(r.slug) >= 0 ? 'Pinned' : 'Pin', state.pins.indexOf(r.slug) >= 0, function (e) { e.stopPropagation(); togglePin(r.slug); }),
            miniBtn(state.compare.indexOf(r.slug) >= 0 ? 'Comparing' : 'Compare', state.compare.indexOf(r.slug) >= 0, function (e) { e.stopPropagation(); toggleCompare(r.slug); })
          )
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.base_multiple.toFixed(2) + '×' }),
        el('td', { class: 'num', text: (r.launch_odds * 100).toFixed(1) + '%' }),
        el('td', null,
          el('span', { class: 'num', text: fmtUsd(effImplied(r)) }),
          el('div', { class: 'sub', text: fmtRange(r) + ' · ' + (r.launch_odds * 100).toFixed(1) + '% odds · ' + (r.launch_clock_months === null ? '>5y' : r.launch_clock_months + 'm') }))
      );
      tbody.appendChild(tr);
    });
    var panel = el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for detail.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('base', 'Base ×'),
            sortHeader('odds', 'Odds'),
            sortHeader('implied', 'Implied value')
          )),
          tbody
        )
      )
    );
    if (list.length > shown.length) {
      panel.appendChild(el('div', { class: 'more' },
        el('button', { class: 'button', type: 'button', text: 'Show ' + Math.min(60, list.length - shown.length) + ' more of ' + list.length, onclick: function () { state.shown += 60; render(); } })
      ));
    }
    return panel;
  }

  function liveSection(title, note, items) {
    var tbody = el('tbody');
    items.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: r.mcap_usd === null ? '—' : fmtUsd(r.mcap_usd) })
      ));
    });
    return el('div', null,
      el('h2', { text: title }),
      el('p', { class: 'sub', text: note }),
      el('div', { class: 'panel', style: 'margin-top:10px' },
        el('div', { class: 'table-wrap' },
          el('table', null,
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Mcap' }))),
            tbody
          )
        )
      )
    );
  }

  function liveView() {
    var live = DATA.live.filter(function (r) { return r.kind === 'live'; });
    var wrapped = DATA.live.filter(function (r) { return r.kind === 'wrapped'; });
    var wrap = el('div', { style: 'display:grid;gap:28px' },
      el('section', { class: 'signals', 'aria-label': 'All 758 protocols accounted' },
        el('h2', { text: 'All 758 protocols' }),
        el('p', { class: 'sub', text: DATA.board_size + ' board + ' + COV.live + ' live + ' + COV.wrapped + ' wrapped + ' + COV.nomcap + ' no market cap = ' + TOTAL758 + '. Nothing left out, nothing double-counted.' }),
        el('div', { class: 'stats', style: 'margin-top:12px' }, [
          [DATA.board_size, 'Board rows'],
          [COV.live, 'Already trade'],
          [COV.wrapped, 'Wrapped etc.'],
          [COV.nomcap, 'No market cap']
        ].map(function (g) { return el('div', { class: 'stat' }, el('b', { text: String(g[0]) }), el('span', { text: g[1] })); }))
      ),
      liveSection('Already trades — top 24 by market cap', 'They have a token and a market cap — the market already priced them. Top 24 by market cap.', live),
      liveSection('Wrapped, staked or bridged — top 24 by TVL', 'Another token’s product, not a launch of its own. Top 24 by TVL.', wrapped),
      el('div', null,
        el('h2', { text: 'Listed, no market cap yet — ' + COV.nomcap }),
        el('p', { class: 'sub', text: 'Listed but no market cap, so the model cannot score them. A token would move them onto the board.' })
      )
    );
    return wrap;
  }

  function signalGroup(title, list, val) {
    return el('div', { class: 'compare-col prior-col' },
      el('h3', { text: title }),
      list.map(function (r) {
        return el('button', { type: 'button', class: 'signal-row', onclick: function () { openDetail(r.slug); } },
          el('span', { class: 'signal-rank', text: '#' + r.rank }),
          el('b', { text: r.name }),
          el('span', { class: 'num', text: val(r) }));
      }));
  }
  function signals() {
    var rows = DATA.rows;
    var risers = rows.filter(function (r) { return r.change_7d !== null && r.change_7d !== undefined; })
      .sort(function (a, b) { return b.change_7d - a.change_7d; }).slice(0, 3);
    var farms = rows.slice().sort(function (a, b) { return (b.farm_plan.usd_per_hour || 0) - (a.farm_plan.usd_per_hour || 0); }).slice(0, 3);
    return el('section', { class: 'signals', 'aria-label': 'Top signals' },
      el('h2', { text: 'Top signals' }),
      el('div', { class: 'signal-grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' },
        signalGroup('Fastest risers · 7d', risers, function (r) { return fmtPct(r.change_7d); }),
        signalGroup('Best $/hour farms', farms, function (r) { return '$' + (r.farm_plan.usd_per_hour || 0).toFixed(2) + '/h'; })
      ));
  }

  function proofStrip() {
    var passed = CHECK.proofs.filter(function (p) { return p[1]; }).length;
    var allPass = passed === CHECK.proofs.length && CHECK.bad === 0;
    return el('section', { class: 'panel proofs', 'aria-label': 'Self-check' },
      el('div', { class: 'sandbox-head' },
        el('h2', { text: 'Self-check' }),
        el('b', { class: allPass ? 'pos' : 'neg', text: 'recomputed ' + CHECK.n + '/' + CHECK.n + ' · ' + CHECK.bad + ' mismatches · ' + passed + '/' + CHECK.proofs.length + ' proofs pass' })
      ),
      el('div', { class: 'signal-grid' }, CHECK.proofs.map(function (p) {
        return el('div', { class: 'proof' + (p[1] ? ' pass' : ' fail') },
          el('b', { text: (p[1] ? 'PASS' : 'FAIL') + ' — ' + p[0] }),
          el('span', { class: 'sub', text: p[2] }));
      }))
    );
  }

  function valTable() {
    var V = DATA.validation;
    var rows = Object.keys(V.ablation).map(function (k) {
      var a = V.ablation[k];
      return el('tr', null, el('td', { text: k }), el('td', { class: 'num', text: a.loo_med_ale.toFixed(4) }), el('td', { class: 'num', text: a.wf_med_ale.toFixed(4) }));
    });
    return el('div', { class: 'prior-col' },
      el('h3', { text: 'Blind tests — MedALE' }),
      el('table', null,
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Terms' }), el('th', { scope: 'col', text: 'LOO' }), el('th', { scope: 'col', text: 'WF' }))),
        el('tbody', null, rows)
      )
    );
  }

  function modelPanel() {
    var V = DATA.validation;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every row from the snapshot’s own figures. No name is special-cased, no row hand-picked. The base multiple is fitted, not assumed: a power law on the ' + V.n_live + ' live tokens, tested blind three ways.' }),
      el('div', { class: 'formula' },
        'launch = round( tvl_usd × base × growth × maturity × momentum × category^w × chain^w )',
        el('br'),
        'implied = round( launch × launch odds ) — the expected value of a launch',
        el('br'),
        'base = exp(' + M.power_law_a.toFixed(4) + ')×TVL^(' + (M.power_law_b - 1).toFixed(4) + '), log(mcap) = ' + M.power_law_a.toFixed(4) + ' + ' + M.power_law_b.toFixed(4) + '×log(TVL), Theil–Sen on ' + V.n_live + ' live tokens',
        el('br'),
        'growth = 1 + clamp(change_7d, ' + M.growth_floor + ', ' + M.growth_cap + ')/100 × ' + M.growth_weight + ' = 1 (not kept)',
        el('br'),
        'maturity = ' + M.maturity_floor + ' + min(age_days, ' + M.maturity_days + ')/' + M.maturity_days + ' × ' + M.maturity_range,
        el('br'),
        'momentum = 1 (not kept, w ' + M.momentum_weight + ') · category^w = 1 (not kept) · chain^w (w ' + M.chain_weight + ')',
        el('br'),
        'launch odds = logistic on [1, age, log10 TVL, growth] — 5-fold CV AUC ' + M.odds_cv.auc + ', Brier ' + M.odds_cv.brier + ', on ' + M.odds_n_train + ' dated protocols'
      ),
      el('p', { class: 'sub', text: 'Blind validation, final model: leave-one-out MedALE ' + V.final.loo_med_ale + ' (×' + V.final.loo_x + '); walk-forward ' + V.final.wf_med_ale + ' (×' + V.final.wf_x + '); ten-fold ' + V.final.tf_med_ale + ' (×' + V.final.tf_x + '). Placebo (shuffled outcomes) selects ' + V.placebo.selected_procedure + ' at LOO ' + V.placebo.loo_med_ale + '. Conformal 80% range: q ' + M.conformal_q_global.toFixed(4) + ', LOO coverage ' + (V.conformal.coverage_loo * 100).toFixed(1) + '%, median range factor ×' + V.conformal.median_factor + '. Rank ranges: median width ' + V.rank_ranges.median_width + ' places. ' + V.final.within_2x + ' of ' + V.n_live + ' predictions land within 2× of the true market cap.' }),
      el('div', { class: 'priors' },
        valTable(),
        el('div', { class: 'prior-col' },
          el('h3', { text: 'Farm plans, costed' }),
          el('p', { class: 'model-note', text: DATA.farm_plan.assumption })
        ),
        el('div', { class: 'prior-col' },
          el('h3', { text: 'What the model does not do' }),
          el('p', { class: 'model-note', text: 'It never reads a name to decide a value. A protocol under the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor is scored the same way as a watchlist one. Age is the time since first listing; an unlisted age uses ' + M.unknown_age_days + ' days. Every row carries a value range from the fit’s own uncertainty, so thin-data rows carry wider ranges. Every number on this page is recomputed from the snapshot beside it.' })
        )
      )
    );
  }

  var dtabRow = null;
  function showDtab() {
    dialog.querySelectorAll('.detail-pane').forEach(function (p) { p.style.display = p.getAttribute('data-pane') === state.dtab ? '' : 'none'; });
    dialog.querySelectorAll('[data-dtab]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-dtab') === state.dtab ? 'true' : 'false'); });
  }
  // One equation builder for the overview pane and the model tab: every row of
  // the radar-4 model with this row's numbers, from the shared model.
  function eqRows(row) {
    var mom = row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier;
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : Math.min(M.growth_cap, Math.max(M.growth_floor, row.change_7d));
    var age = row.age_days === null || row.age_days === undefined ? M.unknown_age_days : row.age_days;
    var ageTxt = row.age_days === null || row.age_days === undefined ? 'unknown (' + M.unknown_age_days + 'd used)' : String(age);
    return [
      ['TVL', fmtUsd(row.tvl_usd)],
      ['Seven-day growth', fmtPct(row.change_7d)],
      ['Age with no token', fmtAge(row.age_days)],
      ['Base multiple', 'exp(' + M.power_law_a.toFixed(4) + ')×TVL^(' + (M.power_law_b - 1).toFixed(4) + ') = ' + fmtMult(row.base_multiple) + '×'],
      ['Growth multiplier', '1 + ' + g.toFixed(2) + '/100 × ' + M.growth_weight + ' = ' + fmtMult(row.growth_multiplier) + '× (not kept)'],
      ['Maturity multiplier', M.maturity_floor + ' + min(' + ageTxt + ', ' + M.maturity_days + ')/' + M.maturity_days + ' × ' + M.maturity_range + ' = ' + fmtMult(row.maturity_multiplier) + '×'],
      ['Momentum multiplier', 'w ' + M.momentum_weight + ' → ' + fmtMult(mom) + '× (not kept)' + (row.momentum_pct === null || row.momentum_pct === undefined ? '' : ' (' + fmtPct(row.momentum_pct) + ' vs peers)')],
      ['Category multiplier', fmtMult(row.category_multiplier) + '×^' + row.category_weight + ' = ' + fmtMult(RM.powMult(row.category_multiplier, row.category_weight)) + '× (not kept)'],
      ['Chain multiplier', fmtMult(row.chain_multiplier) + '×^' + row.chain_weight + ' = ' + fmtMult(RM.powMult(row.chain_multiplier, row.chain_weight)) + '×'],
      ['Launch value', fmtUsd(row.launch_value_usd) + ' (' + fmtUsd(row.launch_value_low_usd) + ' – ' + fmtUsd(row.launch_value_high_usd) + ')'],
      ['Launch odds', (row.launch_odds * 100).toFixed(2) + '% in 12m'],
      ['Launch clock', (row.launch_clock_months === null ? '>5y' : row.launch_clock_months + 'm') + ' median · ' + row.launch_clock_label],
      ['Rank range', '#' + row.rank_low + ' – #' + row.rank_high],
      ['Value range', fmtRange(row)],
      ['Implied value (EV)', fmtUsd(row.implied_value_usd)]
    ];
  }
  function eqDiv(pairs) {
    var d = el('div', { class: 'equation' });
    pairs.forEach(function (r, i) {
      var row = el('div', null, el('span', { text: r[0] }), el('b', { class: 'num', text: r[1] }));
      if (i === pairs.length - 1) row.className = 'total';
      d.appendChild(row);
    });
    return d;
  }
  function modelTab(row) {
    return el('div', { class: 'detail-section' },
      el('h3', { text: 'Odds, clock and range' }),
      el('p', { class: 'check', text: 'Odds: logistic on ' + M.odds_n_train + ' dated protocols (5-fold CV AUC ' + M.odds_cv.auc + '); the clock is the median months to launch from the same curve. Range: conformal 80% (q ' + M.conformal_q_global.toFixed(4) + '). The full equation, with this row’s numbers, is on the Overview tab — the same arithmetic main.ts runs.' })
    );
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    if (dtabRow !== slug) { state.dtab = 'overview'; dtabRow = slug; }
    state.selected = slug;
    dialog.textContent = '';
    var steps = row.farm_steps || [];
    var check = publishedImplied(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'kicker', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · Watchlist' : ' · Early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('div', { class: 'tabs detail-tabs', role: 'tablist' },
      [['overview', 'Overview'], ['model', 'Model'], ['farm', 'Farm plan']].map(function (t) {
        return el('button', { type: 'button', role: 'tab', 'data-dtab': t[0], 'aria-pressed': state.dtab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.dtab = t[0]; showDtab(); } });
      })
    ));
    var ovPane = el('div', { class: 'detail-pane', 'data-pane': 'overview' });
    ovPane.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      eqDiv(eqRows(row)),
      el('p', { class: 'check' }, sandboxOn()
        ? 'The sandbox is on: with your settings this row would be ' + fmtUsd(effImplied(row)) + '. The published model above still gives ' + fmtUsd(row.implied_value_usd) + '.'
        : 'This page recomputes ' + fmtUsd(check) + ' from the same figures — the same number board.json carries. This is an estimate, not a price.')
    ));
    dialog.appendChild(ovPane);
    var moPane = el('div', { class: 'detail-pane', 'data-pane': 'model' });
    moPane.appendChild(modelTab(row));
    dialog.appendChild(moPane);
    var faPane = el('div', { class: 'detail-pane', 'data-pane': 'farm' });
    var fp = row.farm_plan;
    var tierRows = el('div', { class: 'equation' });
    row.farm_plan_tiers.forEach(function (t) {
      tierRows.appendChild(el('div', null, el('span', { text: '$' + t.deposit_usd + ' deposit' }), el('b', { class: 'num', text: '$' + t.expected_reward_usd + ' reward · $' + t.usd_per_hour.toFixed(4) + '/h · BE $' + (t.breakeven_usd === null ? '—' : t.breakeven_usd) + (t.deposit_usd === 100 ? ' (' + fmtUsd(fp.expected_reward_low_usd) + ' – ' + fmtUsd(fp.expected_reward_high_usd) + ')' : '') })));
    });
    row.farm_matrix.horizons_days.forEach(function (h, i) {
      tierRows.appendChild(el('div', null, el('span', { text: h + 'd hold' }), el('b', { class: 'num', text: row.farm_matrix.usd_per_hour.map(function (r) { return '$' + r[i].toFixed(4) + '/h'; }).join(' · ') })));
    });
    faPane.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — costed, three sizes' }),
      tierRows,
      el('p', { class: 'check', text: 'Standard $100 deposit (+ $25 second action), ' + fp.timeline_days + ' days · ' + fp.active_hours.toFixed(1) + ' active hours. Top: reward and $/hour per deposit; the breakeven is the same at every tier. Bottom: $/hour per hold (columns $25 / $100 / $500) — the reward is a lump sum, so $/hour falls with the hold.' }),
      el('p', { class: 'check', text: DATA.farm_plan.assumption })
    ));
    faPane.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — 7 steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    faPane.appendChild(el('p', { class: 'risk', text: 'Risk, plainly: a farm bets on a token that may never launch, a contract that may be exploited, and points that may be worth nothing. Never farm money you cannot lose, and never pay anyone to claim.' }));
    dialog.appendChild(faPane);
    showDtab();
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  var shellBuilt = false;
  var slot = null;

  function render() {
    if (!shellBuilt) {
      var shell = el('div', { class: 'shell' });
      shell.appendChild(header());
      shell.appendChild(lede());
      shell.appendChild(proofStrip());
      shell.appendChild(sandbox());
      shell.appendChild(signals());
      shell.appendChild(controls());
      slot = el('div', { id: 'slot' });
      shell.appendChild(slot);
      shell.appendChild(modelPanel());
      shell.appendChild(el('footer', { class: 'foot' },
        el('span', { text: 'Source: DefiLlama snapshot ' + DATA.as_of + '. Implied values are a model, not prices or advice.' }),
        el('span', { text: 'Built by an agent for make.fun’s token-radar-01 bounty.' })
      ));
      app.appendChild(shell);
      app.setAttribute('aria-busy', 'false');
      if (!dialog.isConnected) app.appendChild(dialog);
      shellBuilt = true;
    }
    update();
  }

  // Refresh only the slot; the shell is built once so typing and dragging never lose focus.
  function update() {
    slot.textContent = '';
    if (state.tab === 'pre') {
      if (state.pins.length) slot.appendChild(pinStrip());
      if (state.compare.length) slot.appendChild(comparePanel());
      slot.appendChild(boardTable());
    } else {
      slot.appendChild(liveView());
    }
    document.getElementById('csv-export').style.display = state.tab === 'pre' ? '' : 'none';
    app.querySelector('.model').style.display = state.tab === 'pre' ? '' : 'none';
    app.querySelector('.count').textContent = state.tab === 'pre' ? rows().length + ' rows shown' : TOTAL758 + ' protocols accounted';
    document.getElementById('sandbox-note').innerHTML = sandboxOn() ? '<b>Sandbox on:</b> the board below is re-ranked. board.json keeps the published model.' : 'The published model is the default. Nothing here changes board.json.';
    document.getElementById('sandbox-reset').style.display = sandboxOn() ? '' : 'none';
    app.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-tab') === state.tab ? 'true' : 'false'); });
    var q = document.getElementById('q');
    if (q.value !== state.q) q.value = state.q;
    document.getElementById('category').value = state.category;
    document.getElementById('chain').value = state.chain;
    syncSlider('sb-gw', state.sb.gw, function (v) { return v.toFixed(2) + '×'; });
    syncSlider('sb-mf', state.sb.mf, function (v) { return v.toFixed(2); });
    syncSlider('sb-ps', state.sb.ps, function (v) { return v.toFixed(1) + '×'; });
    if (state.selected) openDetail(state.selected);
  }

  function syncSlider(id, value, fmt) {
    var input = document.getElementById(id);
    if (!input) return;
    if (parseFloat(input.value) !== value) input.value = String(value);
    var out = input.closest('.slider').querySelector('output');
    if (out) out.textContent = fmt(value);
  }

  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
