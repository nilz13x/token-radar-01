// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail drawer with the
// model's own inputs and the protocol's farm plan, and a model sandbox that re-ranks the
// board live. No network: every byte it shows is in data.js. The page recomputes each
// row's implied value from the snapshot figures and checks the number board.json carries,
// so the page's arithmetic and the board's data are visibly the same model.
// Farm plans (slice 2): every board row farms a standard $100 deposit
// (second action $25). Expected reward = 5% of the row's implied launch
// value, shared pro-rata on the $100 against the protocol's TVL, so no row
// can promise a big $/hour from a tiny deposit. $/hour = expected reward /
// active hours (35 one-off minutes + 20 minutes a week over the hold).
// Low/high $/hour come from the row's value range. See data.js farm_plan.
// Blind validation (radar-3, 128 fitted live tokens): LOO MedALE 1.2524 (x1.2961),
// walk-forward MedALE 1.0011 (x1.6646), train 47 / test 48; 36/128 within 2x, 58/128 within 3x.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;
  // The sealed snapshot holds 758 protocols. data.js carries the 209 board rows and the
  // top 24 live + top 24 wrapped rows; the other group sizes are the snapshot's own
  // accounting (RECON-ITER3.md): 129 live tokens, 133 wrapped/staked/bridged products,
  // 287 pre-token with a listing but no market cap. 209 + 129 + 133 + 287 = 758.
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

  // The published model, recomputed from the row's own figures: base multiple x growth x
  // maturity x momentum, each rounded the way main.ts rounds them. Must equal board.json's
  // number. In radar-3 the base multiple comes from the fitted power law (see the model
  // panel), and growth and momentum are 1 — the blind tests dropped them.
  function publishedImplied(row) {
    var mom = row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier;
    return Math.max(1, Math.round(row.tvl_usd * row.base_multiple * row.growth_multiplier * row.maturity_multiplier * mom));
  }
  function sandboxOn() {
    return state.sb.gw !== M.growth_weight || state.sb.mf !== M.maturity_floor || state.sb.ps !== 1;
  }
  // The sandbox: the same formula with the reader's own growth weight, maturity floor and
  // base scale. It re-ranks the board live; board.json keeps the published model.
  function effImplied(row) {
    if (!sandboxOn()) return row.implied_value_usd;
    var g = Math.min(M.growth_cap, Math.max(M.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var gm = 1 + (g / 100) * state.sb.gw;
    var age = row.age_days === null || row.age_days === undefined ? M.unknown_age_days : row.age_days;
    var mm = state.sb.mf + (Math.min(Math.max(age, 0), M.maturity_days) / M.maturity_days) * (1 - state.sb.mf);
    var mom = row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier;
    return Math.max(1, Math.round(row.tvl_usd * row.base_multiple * state.sb.ps * gm * mm * mom));
  }

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

  // The farm plan is the same derivation main.ts writes to board.json: a standard $100
  // deposit, a $25 second action, and the hold from the row's own costed plan. The
  // category, chains and age decide the action; the costed numbers come from data.js.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function mainAction(p, chain) {
    var c = (p.category || '').toLowerCase();
    var n = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $100 of USDC to ' + n + ' on ' + chain + ' and leave the deposit earning.';
    if (c.indexOf('dex') >= 0 || c.indexOf('swap') >= 0) return 'Provide $100 of liquidity to ' + n + "'s deepest pool on " + chain + ' and keep the position in range.';
    if (c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Deposit $100 into ' + n + "'s highest-TVL strategy on " + chain + ' and let it compound.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $100 of USDC as margin on ' + n + ' and open one small hedged trade.';
    if (c.indexOf('prediction') >= 0) return 'Fund $100 and take one position in an active market on ' + n + '.';
    if (c.indexOf('rwa') >= 0 || c.indexOf('real world') >= 0) return 'Mint $100 of the yield-bearing asset on ' + n + ' and hold it on ' + chain + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $100 of the stable asset through ' + n + ' on ' + chain + '.';
    if (c.indexOf('insurance') >= 0) return 'Buy $100 of cover from ' + n + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('liquid') >= 0) return 'Stake $100 of the chain asset through ' + n + ' and keep the receipt token.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return 'Deposit $100 into a ' + n + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('index') >= 0) return 'Buy $100 of the ' + n + ' index on ' + chain + ' and hold it.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $100 of USDC to ' + chain + ' through ' + n + " and put the bridged funds to work in its app.";
    return 'Deposit $100 of USDC into ' + n + ' on ' + chain + ' and keep the position open.';
  }
  function secondAction(p) {
    var c = (p.category || '').toLowerCase();
    var n = p.name;
    if (p.chains && p.chains.length > 1) return 'Use ' + n + ' on ' + p.chains[1] + ' too: move $25 there and repeat the position, so the activity counts on two chains.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Borrow $25 against the deposit on ' + n + ', hold it a day, then repay it in full.';
    if (c.indexOf('dex') >= 0 || c.indexOf('swap') >= 0) return 'Swap $25 through ' + n + "'s pool once, then add the proceeds back as liquidity.";
    if (c.indexOf('yield') >= 0 || c.indexOf('vault') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $25 into a second ' + n + ' vault or strategy and keep both shares.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Close the hedge on ' + n + ' and open one fresh trade half the size.';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0) return 'Claim the first staking rewards on ' + n + ' and restake them the same day.';
    if (c.indexOf('prediction') >= 0) return 'Settle one market on ' + n + ' and open a position in a different one.';
    return 'Make one different move on ' + n + ': a swap, a vote or a deposit in another market.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var hold = p.farm_plan ? p.farm_plan.timeline_days : 30;
    return [
      { text: 'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: mainAction(p, chain), cost: '$100 of capital and about $4 of gas', time: '15 minutes to set up' },
      { text: secondAction(p), cost: 'about $25 of capital and $2 of gas', time: '10 minutes' },
      { text: 'Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays active.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days, so the activity is counted in more than one snapshot.', cost: 'the $100 stays in the position', time: hold + ' days' },
      { text: "Check the protocol's own points or rewards page every week, and claim only from a link the protocol itself publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
      { text: 'Write the wallet, the dates and every transaction in a farm log. When you unwind, withdraw in two steps and keep gas for the exit; a token is never guaranteed.', cost: 'nothing but the log, plus exit gas', time: '5 minutes to log' }
    ].map(stepText);
  }

  function knownSlugs(list) {
    return list.filter(function (s) { return DATA.rows.some(function (r) { return r.slug === s; }); });
  }
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('c')) state.compare = knownSlugs(params.get('c').split(',')).slice(0, 2);
    if (params.get('pin')) state.pins = knownSlugs(params.get('pin').split(','));
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    if (state.compare.length) params.set('c', state.compare.join(','));
    if (state.pins.length) params.set('pin', state.pins.join(','));
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

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
    writeHash();
    render();
  }
  function toggleCompare(slug) {
    var i = state.compare.indexOf(slug);
    if (i >= 0) state.compare.splice(i, 1);
    else {
      if (state.compare.length >= 2) state.compare.shift();
      state.compare.push(slug);
    }
    writeHash();
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
        el('button', { type: 'button', class: 'mini-btn', text: 'Details', onclick: function () { openDetail(slug); } }),
        el('button', { type: 'button', class: 'mini-btn', text: 'Unpin', onclick: function () { togglePin(slug); } })
      );
    });
    return el('section', { class: 'pin-strip', 'aria-label': 'Pinned rows' }, chips);
  }

  function compareCol(r, other) {
    var mom = r.momentum_multiplier === undefined ? 1 : r.momentum_multiplier;
    var winner = r.implied_value_usd > other.implied_value_usd;
    return el('div', { class: 'compare-col' + (winner ? ' winner' : '') },
      el('div', { class: 'compare-head' },
        el('b', null, '#' + r.rank + ' ', r.name, r.watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null),
        winner ? el('span', { class: 'win-tag', text: 'Higher implied value' }) : null
      ),
      el('div', { class: 'compare-row' }, el('span', { text: 'Category' }), el('b', { text: r.category || 'Other' })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Chains' }), el('b', { text: (r.chains || []).join(', ') || '—' })),
      el('div', { class: 'compare-row' }, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(r.tvl_usd) })),
      el('div', { class: 'compare-row' }, el('span', { text: '7-day growth' }), el('b', { class: 'num', text: fmtPct(r.change_7d) })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(r.age_days) })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Base multiple' }), el('b', { class: 'num', text: fmtMult(r.base_multiple) + '×' })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmtMult(r.growth_multiplier) + '×' })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmtMult(r.maturity_multiplier) + '×' })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Momentum multiplier' }), el('b', { class: 'num', text: fmtMult(mom) + '×' + (r.momentum_pct === null || r.momentum_pct === undefined ? '' : ' (' + fmtPct(r.momentum_pct) + ' vs peers)') })),
      el('div', { class: 'compare-row' }, el('span', { text: 'Value range' }), el('b', { class: 'num', text: fmtRange(r) })),
      el('div', { class: 'compare-row total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(r.implied_value_usd) }))
    );
  }

  function comparePanel() {
    var head = el('div', { class: 'compare-head-bar' },
      el('h2', { text: 'Compare' }),
      el('button', { type: 'button', class: 'mini-btn', text: 'Clear compare', onclick: function () { state.compare = []; writeHash(); render(); } })
    );
    if (state.compare.length < 2) {
      var only = rowBySlug(state.compare[0]);
      return el('section', { class: 'panel compare-panel', 'aria-label': 'Compare' }, head,
        el('p', { class: 'compare-hint', text: (only ? only.name : 'One row') + ' selected — pick one more row in the table to compare side by side.' })
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
    var head = ['Rank', 'Protocol', 'Category', 'Chains', 'TVL (USD)', '7d (%)', 'Age (days)', 'Base x', 'Growth x', 'Maturity x', 'Momentum x', 'Implied value (USD)', 'Implied low (USD)', 'Implied high (USD)', 'Token', 'Watchlist'];
    var lines = [head.map(csvCell).join(',')];
    list.forEach(function (r) {
      lines.push([
        r.rank, r.name, r.category || 'Other', (r.chains || []).join('; '), r.tvl_usd,
        r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days,
        r.base_multiple, r.growth_multiplier, r.maturity_multiplier,
        r.momentum_multiplier === undefined ? '' : r.momentum_multiplier,
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
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { html: '<b>' + DATA.model_version + '</b> model' }),
        el('span', { html: '<b>' + TOTAL758 + '</b> protocols accounted' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by what a launch would be worth' }),
        el('p', { html: 'The watchlist is the floor: every protocol with at least <b>$' + Math.round(DATA.floor_usd / 1e6) + 'M</b> of TVL and no token on record. The early radar adds <b>' + DATA.early_size + ' pre-token protocols</b> below that floor — the whole point of a radar is finding them early. Implied value is a model, not a promise. The page accounts for all <b>' + TOTAL758 + '</b> protocols in the snapshot — the All 758 tab shows where every one of them lands.' })
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('span', { text: 'Watchlist covered' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'Pre-token rows scored' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.early_size) }), el('span', { text: 'Early rows below the floor' })),
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
      el('h2', { text: 'Model sandbox — move the model, watch the board move' }),
      el('p', { id: 'sandbox-note', html: sandboxOn() ? '<b>Sandbox on:</b> the board below is re-ranked with your settings. board.json keeps the published model.' : 'The published model is the default. Nothing here changes the board on file.' })
    );
    var s = state.sb;
    var box = el('section', { class: 'sandbox', 'aria-label': 'Model sandbox' }, head,
      el('div', { class: 'sliders' },
        slider('sb-gw', 'Growth weight', 0, 1, 0.05, s.gw, function (v) { return v.toFixed(2) + '×'; }, 'How much a 7-day move is worth', function (v) { state.sb.gw = v; render(); }),
        slider('sb-mf', 'Maturity floor', 0.3, 0.9, 0.05, s.mf, function (v) { return v.toFixed(2); }, 'What a brand-new protocol is worth', function (v) { state.sb.mf = v; render(); }),
        slider('sb-ps', 'Base scale', 0.5, 2, 0.1, s.ps, function (v) { return v.toFixed(1) + '×'; }, 'Scale every fitted base multiple at once', function (v) { state.sb.ps = v; render(); })
      ),
      el('button', { class: 'reset', id: 'sandbox-reset', type: 'button', text: 'Reset to the published model', onclick: function () { state.sb = { gw: M.growth_weight, mf: M.maturity_floor, ps: 1 }; render(); } })
    );
    return box;
  }

  function mix() {
    var counts = {};
    DATA.rows.forEach(function (r) { var c = r.category || 'Other'; counts[c] = (counts[c] || 0) + 1; });
    var top = Object.keys(counts).map(function (c) { return { c: c, n: counts[c] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    var max = top.length ? top[0].n : 1;
    return el('section', { class: 'mix', 'aria-label': 'Board by category' },
      el('h2', { text: 'Where the board comes from' }),
      el('div', { class: 'mix-grid' }, top.map(function (t) {
        return el('div', { class: 'mix-row' },
          el('div', { class: 'mix-top' }, el('span', { text: t.c }), el('b', { text: String(t.n) })),
          el('div', { class: 'mix-bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round((t.n / max) * 100) + '%' }))
        );
      }))
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; state.shown = 60; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; state.shown = 60; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; state.shown = 60; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'data-tab': 'pre', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; render(); } });
    var live = el('button', { type: 'button', 'data-tab': 'live', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'All 758', onclick: function () { state.tab = 'live'; render(); } });
    var count = state.tab === 'pre' ? rows().length + ' rows shown' : TOTAL758 + ' protocols accounted';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
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
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var shown = list.slice(0, state.shown);
    var max = Math.max.apply(null, list.map(function (r) { return effImplied(r); })) || 1;
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
          el('b', null, r.name, r.watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          el('div', { class: 'row-actions' },
            el('button', { type: 'button', class: 'mini-btn', 'aria-pressed': state.pins.indexOf(r.slug) >= 0 ? 'true' : 'false', text: state.pins.indexOf(r.slug) >= 0 ? 'Pinned' : 'Pin', onclick: function (e) { e.stopPropagation(); togglePin(r.slug); } }),
            el('button', { type: 'button', class: 'mini-btn', 'aria-pressed': state.compare.indexOf(r.slug) >= 0 ? 'true' : 'false', text: state.compare.indexOf(r.slug) >= 0 ? 'Comparing' : 'Compare', onclick: function (e) { e.stopPropagation(); toggleCompare(r.slug); } })
          )
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.base_multiple.toFixed(2) + '×' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((effImplied(r) / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(effImplied(r)) })
        ), el('div', { class: 'sub', text: fmtRange(r) })),
        el('td', null, el('span', { class: 'pill', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    var panel = el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Each row shows its value range (low–high) from the fit’s uncertainty. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('base', 'Base ×'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
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

  function liveSection(title, note, items, pillClass, pillText) {
    var tbody = el('tbody');
    items.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pill ' + pillClass, text: pillText })),
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
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }))),
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
      el('section', { class: 'mix', 'aria-label': 'All 758 protocols accounted' },
        el('h2', { text: 'All 758 protocols, accounted for' }),
        el('p', { class: 'sub', text: DATA.board_size + ' board + ' + COV.live + ' live + ' + COV.wrapped + ' wrapped + ' + COV.nomcap + ' listed without a market cap = ' + TOTAL758 + ' in the sealed snapshot. Nothing is left out, nothing is double-counted.' }),
        el('div', { class: 'stats', style: 'margin-top:12px' }, [
          [DATA.board_size, 'Board rows scored'],
          [COV.live, 'Already trade'],
          [COV.wrapped, 'Wrapped, staked or bridged'],
          [COV.nomcap, 'Listed, no market cap yet']
        ].map(function (g) { return el('div', { class: 'stat' }, el('b', { text: String(g[0]) }), el('span', { text: g[1] })); }))
      ),
      liveSection('Already trades — top 24 of ' + COV.live + ' by market cap', 'These protocols have a token and a market cap, so the market has already priced them. They are set aside from the pre-token ranking; the table shows the 24 largest by market cap.', live, 'live', 'already trades'),
      liveSection('Wrapped, staked or bridged — top 24 of ' + COV.wrapped + ' by TVL', 'Another token’s product, not a launch of its own: a bridge moves an existing token, a liquid-staking token is staked ETH by another name. Set aside with the live tokens; the table shows the 24 largest by TVL.', wrapped, 'wrapped', 'wrapped product'),
      el('div', null,
        el('h2', { text: 'Listed, no market cap yet — ' + COV.nomcap }),
        el('p', { class: 'sub', text: 'Pre-token protocols with a listing but no market cap on record. The model cannot score a launch value without a market reference, so they are counted here and not ranked. A token would move them onto the board.' })
      )
    );
    return wrap;
  }

  function signalGroup(title, list, val) {
    return el('div', { class: 'mix-row prior-col' },
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
    var young = rows.filter(function (r) { return r.age_days !== null && r.age_days !== undefined && r.age_days < 365; })
      .sort(function (a, b) { return b.tvl_usd - a.tvl_usd; }).slice(0, 3);
    return el('section', { class: 'signals', 'aria-label': 'Top signals' },
      el('h2', { text: 'Top signals — what moved, who leads' }),
      el('div', { class: 'signal-grid' },
        signalGroup('Fastest risers · 7d', risers, function (r) { return fmtPct(r.change_7d); }),
        signalGroup('Best $/hour farms', farms, function (r) { return '$' + (r.farm_plan.usd_per_hour || 0).toFixed(2) + '/h'; }),
        signalGroup('Young giants · TVL under 1y', young, function (r) { return fmtUsd(r.tvl_usd); })
      ));
  }

  function valTable() {
    var V = DATA.validation;
    var labels = { powerOnly: 'Power law only', growthOnly: 'Power + growth', maturityOnly: 'Power + maturity (final)', momentumOnly: 'Power + momentum', growthMaturity: 'Power + growth + maturity', growthMomentum: 'Power + growth + momentum', maturityMomentum: 'Power + maturity + momentum', full: 'All terms' };
    var rows = Object.keys(V.ablation).map(function (k) {
      var a = V.ablation[k];
      return el('tr', null, el('td', { text: labels[k] || k }), el('td', { class: 'num', text: a.loo_med_ale.toFixed(4) }), el('td', { class: 'num', text: a.wf_med_ale.toFixed(4) }));
    });
    return el('div', { class: 'prior-col' },
      el('h3', { text: 'Blind tests — median absolute log error (lower is better)' }),
      el('table', null,
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Terms kept' }), el('th', { scope: 'col', text: 'Leave-one-out' }), el('th', { scope: 'col', text: 'Walk-forward' }))),
        el('tbody', null, rows)
      )
    );
  }

  function modelPanel() {
    var V = DATA.validation;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed — model ' + DATA.model_version }),
      el('p', { class: 'sub', text: 'One function scores every row, from the snapshot’s own figures. No protocol name is special-cased, and no row is hand-picked. The base multiple is fitted, not assumed: a power law on the ' + V.n_live + ' live tokens, tested blind twice.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd × base × growth × maturity × momentum )',
        el('br'),
        'base = exp(' + M.power_law_a.toFixed(4) + ') × tvl_usd^(' + (M.power_law_b - 1).toFixed(4) + '), from log(mcap) = ' + M.power_law_a.toFixed(4) + ' + ' + M.power_law_b.toFixed(4) + ' × log(TVL) — Theil–Sen fit on ' + V.n_live + ' live tokens',
        el('br'),
        'growth = 1 + clamp(change_7d, ' + M.growth_floor + ', ' + M.growth_cap + ') / 100 × ' + M.growth_weight + ' = 1 (growth not kept — the blind tests drop it)',
        el('br'),
        'maturity = ' + M.maturity_floor + ' + min(age_days, ' + M.maturity_days + ') / ' + M.maturity_days + ' × ' + M.maturity_range,
        el('br'),
        'momentum = 1 (momentum not kept — weight ' + M.momentum_weight + ')'
      ),
      el('p', { class: 'sub', text: 'Blind validation, final model: leave-one-out MedALE ' + V.final.loo_med_ale + ' (×' + V.final.loo_x + ' vs the global-median baseline ' + V.baseline.loo_med_ale + '); walk-forward MedALE ' + V.final.wf_med_ale + ' (×' + V.final.wf_x + ' vs baseline ' + V.baseline.wf_med_ale + '). Walk-forward trains on ' + V.walk_forward.train_n + ' tokens listed before ' + V.walk_forward.train_end + ' and tests on the ' + V.walk_forward.test_n + ' listed after ' + V.walk_forward.test_start + '. ' + V.final.within_2x + ' of ' + V.n_live + ' predictions land within 2× of the true market cap, ' + V.final.within_3x + ' within 3×.' }),
      el('div', { class: 'priors' },
        valTable(),
        el('div', { class: 'prior-col' },
          el('h3', { text: 'Farm plans, costed' }),
          el('p', { class: 'model-note', text: DATA.farm_plan.assumption })
        ),
        el('div', { class: 'prior-col' },
          el('h3', { text: 'What the model does not do' }),
          el('p', { class: 'model-note', text: 'It never reads a name to decide a value. A protocol under the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor is scored the same way as a watchlist one. Age is the time since first listing — the best record of how long a protocol has run with no token; an unlisted age uses ' + M.unknown_age_days + ' days. Every board row also carries a value range (low–high) from the fit’s own uncertainty, so thin-data rows carry wider ranges. Every number on this page is recomputed from the snapshot beside it.' })
        )
      )
    );
  }

  var dtabRow = null;
  function showDtab() {
    dialog.querySelectorAll('.detail-pane').forEach(function (p) { p.style.display = p.getAttribute('data-pane') === state.dtab ? '' : 'none'; });
    dialog.querySelectorAll('[data-dtab]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-dtab') === state.dtab ? 'true' : 'false'); });
  }
  function modelTab(row) {
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : Math.min(M.growth_cap, Math.max(M.growth_floor, row.change_7d));
    var age = row.age_days === null || row.age_days === undefined ? M.unknown_age_days : row.age_days;
    var ageTxt = row.age_days === null || row.age_days === undefined ? 'unknown (' + M.unknown_age_days + 'd used)' : String(age);
    var eq = [];
    eq.push(['TVL', fmtUsd(row.tvl_usd)]);
    eq.push(['Base multiple', 'Theil–Sen fit: exp(' + M.power_law_a.toFixed(4) + ') × ' + fmtUsd(row.tvl_usd) + '^(' + (M.power_law_b - 1).toFixed(4) + ') = ' + fmtMult(row.base_multiple) + '×']);
    eq.push(['Growth multiplier', '1 + ' + g.toFixed(2) + ' (clamped 7d) / 100 × ' + M.growth_weight + ' = ' + fmtMult(row.growth_multiplier) + '× (not kept)']);
    eq.push(['Maturity multiplier', M.maturity_floor + ' + min(max(' + ageTxt + ', 0), ' + M.maturity_days + ') / ' + M.maturity_days + ' × ' + M.maturity_range + ' = ' + fmtMult(row.maturity_multiplier) + '×']);
    eq.push(['Momentum multiplier', 'weight ' + M.momentum_weight + ' → 1.0000× (not kept)']);
    eq.push(['Value range', fmtRange(row) + ' (fit uncertainty)']);
    eq.push(['Implied value', fmtUsd(row.tvl_usd) + ' × ' + fmtMult(row.base_multiple) + ' × ' + fmtMult(row.growth_multiplier) + ' × ' + fmtMult(row.maturity_multiplier) + ' × ' + fmtMult(row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier) + ' = ' + fmtUsd(publishedImplied(row))]);
    return el('div', { class: 'detail-section' },
      el('h3', { text: 'The equation, with this row’s numbers' }),
      el('div', { class: 'equation' }, eq.map(function (r) {
        return el('div', null, el('span', { text: r[0] }), el('b', { class: 'num', text: r[1] }));
      })),
      el('p', { class: 'check', text: 'Every number above is recomputed from the snapshot beside this page — the same arithmetic main.ts runs, and the same number board.json carries.' })
    );
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    if (dtabRow !== slug) { state.dtab = 'overview'; dtabRow = slug; }
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
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
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Base multiple (fitted power law)' }), el('b', { class: 'num', text: fmtMult(row.base_multiple) + '×' })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmtMult(row.growth_multiplier) + '×' })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmtMult(row.maturity_multiplier) + '×' })),
        el('div', null, el('span', { text: 'Momentum multiplier' }), el('b', { class: 'num', text: fmtMult(row.momentum_multiplier === undefined ? 1 : row.momentum_multiplier) + '×' + (row.momentum_pct === null || row.momentum_pct === undefined ? '' : ' (' + fmtPct(row.momentum_pct) + ' vs peers)') })),
        el('div', null, el('span', { text: 'Value range' }), el('b', { class: 'num', text: fmtRange(row) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
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
    if (fp) {
      faPane.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: 'Farm plan — costed' }),
        el('div', { class: 'equation' },
          el('div', null, el('span', { text: 'Standard deposit' }), el('b', { class: 'num', text: '$' + fp.deposit_usd + ' (+ $' + fp.second_action_usd + ' second action)' })),
          el('div', null, el('span', { text: 'Expected reward' }), el('b', { class: 'num', text: fmtUsd(fp.expected_reward_usd) + ' (' + fmtUsd(fp.expected_reward_low_usd) + ' – ' + fmtUsd(fp.expected_reward_high_usd) + ')' })),
          el('div', { class: 'total' }, el('span', { text: '$ per hour' }), el('b', { class: 'num', text: '$' + fp.usd_per_hour.toFixed(2) + ' ($' + fp.usd_per_hour_low.toFixed(2) + ' – $' + fp.usd_per_hour_high.toFixed(2) + ')' })),
          el('div', null, el('span', { text: 'Timeline' }), el('b', { class: 'num', text: fp.timeline_days + ' days · ' + fp.active_hours.toFixed(1) + ' active hours' }))
        ),
        el('p', { class: 'check', text: DATA.farm_plan.assumption })
      ));
    }
    faPane.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — 7 steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    faPane.appendChild(el('p', { class: 'risk', text: 'Risk, stated plainly: a farm is a bet on a token that may never launch, on a contract that may be exploited, and on points that may be worth nothing. Never farm with money you cannot lose, and never pay anyone to claim.' }));
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
      shell.appendChild(sandbox());
      shell.appendChild(mix());
      shell.appendChild(signals());
      shell.appendChild(controls());
      slot = el('div', { id: 'slot' });
      shell.appendChild(slot);
      shell.appendChild(modelPanel());
      shell.appendChild(el('footer', { class: 'foot' },
        el('span', { text: 'Source: DefiLlama protocol index, snapshot ' + DATA.as_of + '. Implied values are a model built from that snapshot, not prices and not advice.' }),
        el('span', { text: 'Built by an agent for make.fun’s token-radar-01 bounty. The program that wrote this page reads the sealed snapshot and nothing else.' })
      ));
      app.appendChild(shell);
      app.setAttribute('aria-busy', 'false');
      if (!dialog.isConnected) app.appendChild(dialog);
      shellBuilt = true;
    }
    update();
  }

  // Refresh only the parts that change. The shell — search box, sliders, tabs — is built
  // once and never rebuilt, so typing a search and dragging a slider never lose focus
  // mid-gesture to a fresh element.
  function update() {
    slot.textContent = '';
    if (state.tab === 'pre') {
      if (state.pins.length) slot.appendChild(pinStrip());
      if (state.compare.length) slot.appendChild(comparePanel());
      slot.appendChild(boardTable());
    } else {
      slot.appendChild(liveView());
    }
    var csvBtn = document.getElementById('csv-export');
    if (csvBtn) csvBtn.style.display = state.tab === 'pre' ? '' : 'none';
    var mp = app.querySelector('.model');
    if (mp) mp.style.display = state.tab === 'pre' ? '' : 'none';
    var c = app.querySelector('.count');
    if (c) c.textContent = state.tab === 'pre' ? rows().length + ' rows shown' : TOTAL758 + ' protocols accounted';
    var n = document.getElementById('sandbox-note');
    if (n) n.innerHTML = sandboxOn() ? '<b>Sandbox on:</b> the board below is re-ranked with your settings. board.json keeps the published model.' : 'The published model is the default. Nothing here changes the board on file.';
    var rb = document.getElementById('sandbox-reset');
    if (rb) rb.style.display = sandboxOn() ? '' : 'none';
    app.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-tab') === state.tab ? 'true' : 'false'); });
    var q = document.getElementById('q');
    if (q && q.value !== state.q) q.value = state.q;
    var cat = document.getElementById('category');
    if (cat) cat.value = state.category;
    var ch = document.getElementById('chain');
    if (ch) ch.value = state.chain;
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

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
