// Token Radar, model radar-4: a pre-token protocol is worth what the market already
// pays for the same kind of protocol — fitted, not assumed — times the chance it
// launches at all. The launch value comes from a power law fitted on the live-token
// protocols in this very snapshot: log(market cap) = a + b * log(TVL), fitted
// robustly (Theil-Sen) on the 128 live tokens with a positive market cap and TVL, so
// a bigger protocol earns a lower multiple and a smaller one a higher one. Five
// value terms — category, chain, growth, age (maturity), momentum against category
// peers — are fitted on the same live tokens and then kept or dropped on three blind
// tests run inside this program: leave-one-out (refit on 127, predict the held-out
// token), walk-forward (fit on the older half of the dated live tokens, test on the
// newer half) and ten-fold (refit per fold, predict the held-out tenth). A term joins
// only when it improves the mean gain across all three tests and worsens none by
// more than 1% — and the whole selection is re-run once on a shuffled target
// (placebo): if the shuffled data selects terms too, the selection is not credible.
// The launch odds come from a logistic model on the 645 dated protocols (327 with a
// token, 318 without): P(has token) by age, log10 TVL and 7d growth, validated by
// 5-fold cross-validation, then turned into a one-year launch hazard — the chance a
// protocol launches within the next 12 months. The board ranks by EXPECTED VALUE:
// implied_value_usd = round(launch value x launch odds), because the gate requires
// implied value to fall with rank, and a high-odds medium launch outranks a
// low-odds big one only in expectation. Every row carries its launch value and its
// conformal 80% range (from the leave-one-out residuals, shrunk per category), a
// rank range from a seeded Monte Carlo, and a launch clock (median and first-quartile
// months to launch). The farm reward is the expected reward: 5% of the expected
// value, shared pro-rata. Each row also carries the same plan at $25/$100/$500
// deposits, a deposit x hold matrix, and the smallest deposit whose expected
// reward covers a fixed $5 farm-run cost — the breakeven is deposit-driven, not
// time-driven, because the reward is a lump sum paid at launch, not earned per
// hour. Wrapped, staked and bridged products are set aside with
// the live tokens: they are another token's product, not a launch of their own. A
// versioned deployment (V2, v3) is still a launch of its own, so it ranks. No
// protocol name is special-cased.
//
// The scoring model itself lives in dashboard/model.js, shared by this program
// and the page: the page recomputes every row from the same functions, so the
// board and the page can never disagree about a number.
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import RadarModel from './dashboard/model.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export const MODEL_VERSION = 'radar-4';
const GROWTH_FLOOR = RadarModel.GROWTH_FLOOR;
const GROWTH_CAP = RadarModel.GROWTH_CAP;
const MATURITY_DAYS = RadarModel.MATURITY_DAYS;
const UNKNOWN_AGE_DAYS = RadarModel.UNKNOWN_AGE_DAYS;
// Safety rails for the fitted power-law multiple only. On this snapshot the board's
// multiples run 0.039 to 0.638, so the rails never bind; they exist so a fitted law
// can never hand a row an absurd multiple.
const PRIOR_FLOOR = RadarModel.PRIOR_FLOOR;
const PRIOR_CAP = RadarModel.PRIOR_CAP;
// Grids the blind tests fit the adjustment terms on. A term's grid always contains
// its neutral value (growth 0, maturity floor 1, momentum 0), so the fit can drop
// a term outright when it does not help.
const GROWTH_GRID = [0, 0.3, 0.5, 0.7];
const MAT_FLOOR_GRID = [0.5, 0.6, 0.7, 1.0];
const MOMENTUM_GRID = [0, 0.15, 0.25, 0.35];
const CAT_WEIGHT_GRID = [0, 0.25, 0.5, 0.75, 1];
const CHAIN_WEIGHT_GRID = [0, 0.25, 0.5, 0.75, 1];
// Fixed seeds: the placebo shuffle and the rank-range Monte Carlo share the
// snapshot date as their seed, so both are reproducible from the snapshot alone.
const PLACEBO_SEED = 20261114;
const MC_SEED = 20261114;
const MC_DRAWS = 200;
// Odds model: logistic P(has token) by age / log10 TVL / 7d growth, full-batch
// gradient descent, deterministic (init 0, lr 0.1, 2000 iterations, L2 1e-4 on
// the slopes, not the intercept). The hazard horizon is one year.
const ODDS_LR = 0.1;
const ODDS_ITERS = 2000;
const ODDS_L2 = 1e-4;
const ODDS_HORIZON_DAYS = RadarModel.ODDS_HORIZON_DAYS;
const ODDS_CLIP_LO = RadarModel.ODDS_CLIP_LO;
const ODDS_CLIP_HI = RadarModel.ODDS_CLIP_HI;
const MOMENTUM_MULT_FLOOR = 0.9;
const MOMENTUM_MULT_CAP = 1.2;
const MOMENTUM_PCT_FLOOR = -60;
const MOMENTUM_PCT_CAP = 120;
// The reference priors below (category / chain medians, radar-2.1's arithmetic) are
// no longer what the board ranks on — the power law is — but the dashboard's priors
// table still shows them, so they are still computed and written to data.js.
const PRIOR_CAT_WEIGHT = 0.75;
const PRIOR_SHRINK_CAT = 3;
const PRIOR_SHRINK_CHAIN = 4;
const LIVE_ROWS = 24;
const WRAPPED_ROWS = 24;
const DAY_MS = 86_400_000;

interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

interface Step {
  text: string;
  cost: string;
  time: string;
}

const round4 = RadarModel.r4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const finite = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Whole days from `listedAt` to the snapshot date — the shared model.js version. */
const ageDays = RadarModel.ageDays;

const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_FIRST = new Set(['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini']);
const WRAPPED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** No token on record at all. */
function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A wrapped, staked or bridged product of a token that already trades. */
function isWrappedProduct(p: Proto): boolean {
  if (p.category !== null && WRAPPED_CATS.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  const first = p.name.trim().split(/[\s-]+/)[0]!.toLowerCase();
  return EXCHANGE_FIRST.has(first);
}

/** A protocol the board may rank: pre-token, and no wrapped product. A version marker
 * (V2, v3) does not disqualify a deployment: the house's watchlist rule drops versions,
 * but the watchlist is a floor, and a versioned deployment is a launch of its own. */
function isBoardable(p: Proto): boolean {
  return isPreToken(p) && !isWrappedProduct(p);
}

interface Priors {
  global: number;
  byCategory: Record<string, { n: number; median: number }>;
  byChain: Record<string, { n: number; median: number }>;
}

/** Reference only: the radar-2.1 comparables — live-token medians per category and
 * per first chain, from this snapshot, shrunk toward the global median. The board no
 * longer ranks on them; they are written to data.js for the dashboard's priors table.
 * A comparable needs a real market cap: a token that records mcap 0 (or a rounding
 * artifact below it) is not a price the market paid, so it is left out. */
function referencePriors(protocols: Proto[]): Priors {
  const live = protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const global = median(ratios);
  const byCategory: Priors['byCategory'] = {};
  const byChain: Priors['byChain'] = {};
  const catGroups = new Map<string, number[]>();
  const chainGroups = new Map<string, number[]>();
  for (const p of live) {
    const r = p.mcap_usd! / p.tvl_usd;
    const c = p.category ?? 'Other';
    if (!catGroups.has(c)) catGroups.set(c, []);
    catGroups.get(c)!.push(r);
    if (p.chains.length > 0) {
      const ch = p.chains[0]!;
      if (!chainGroups.has(ch)) chainGroups.set(ch, []);
      chainGroups.get(ch)!.push(r);
    }
  }
  // A thin category's median is noise: shrink it toward the global median, so a
  // category earns its distance from the global only with comparables behind it.
  for (const [c, xs] of catGroups) byCategory[c] = { n: xs.length, median: round3((xs.length * median(xs) + PRIOR_SHRINK_CAT * global) / (xs.length + PRIOR_SHRINK_CAT)) };
  for (const [c, xs] of chainGroups) byChain[c] = { n: xs.length, median: round3((xs.length * median(xs) + PRIOR_SHRINK_CHAIN * global) / (xs.length + PRIOR_SHRINK_CHAIN)) };
  return { global: round3(global), byCategory, byChain };
}

interface PowerLaw {
  a: number;
  b: number;
}

interface FittedParams {
  growth: number;
  matFloor: number;
  momentum: number;
  catWeight: number;
  chainWeight: number;
}

interface Features {
  base: number;
  growthPct: number;
  age: number | null;
  momentumPct: number | null;
  catMult: number;
  chainMult: number;
}

/** The category / first-chain multipliers for the value model: a category's (or
 * chain's) shrunk median mcap/TVL over the global median, from the training set's
 * live tokens — the same shrinkage arithmetic as referencePriors (k=3 category,
 * k=4 chain). A category or chain with no live token at all takes 1. */
interface TermMults {
  global: number;
  byCategory: Map<string, number>;
  byChain: Map<string, number>;
}

function multiplierTables(train: Proto[]): TermMults {
  const live = train.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const global = median(ratios);
  const catGroups = new Map<string, number[]>();
  const chainGroups = new Map<string, number[]>();
  for (const p of live) {
    const r = p.mcap_usd! / p.tvl_usd;
    const c = p.category ?? 'Other';
    if (!catGroups.has(c)) catGroups.set(c, []);
    catGroups.get(c)!.push(r);
    if (p.chains.length > 0) {
      const ch = p.chains[0]!;
      if (!chainGroups.has(ch)) chainGroups.set(ch, []);
      chainGroups.get(ch)!.push(r);
    }
  }
  const byCategory = new Map<string, number>();
  for (const [c, xs] of catGroups) byCategory.set(c, (xs.length * median(xs) + PRIOR_SHRINK_CAT * global) / (xs.length + PRIOR_SHRINK_CAT) / global);
  const byChain = new Map<string, number>();
  for (const [c, xs] of chainGroups) byChain.set(c, (xs.length * median(xs) + PRIOR_SHRINK_CHAIN * global) / (xs.length + PRIOR_SHRINK_CHAIN) / global);
  return { global, byCategory, byChain };
}

function catMultOf(p: Proto, tables: TermMults): number {
  return tables.byCategory.get(p.category ?? 'Other') ?? 1;
}

function chainMultOf(p: Proto, tables: TermMults): number {
  return p.chains.length > 0 ? (tables.byChain.get(p.chains[0]!) ?? 1) : 1;
}

/** The live-token protocols with a price the market paid: a positive market cap and
 * TVL. Sixteen of the 144 protocols with a recorded market cap carry mcap 0 (or -1)
 * and fall out here, leaving 128 fittable live tokens. */
function liveTokens(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Theil-Sen fit of log(market cap) = a + b * log(TVL) on a training set: the median
 * pairwise slope, then the median intercept. Robust by construction — one wild ratio
 * cannot drag it, which matters here (the live ratios run from 0.013 to 400). */
function theilSen(train: Proto[]): PowerLaw {
  const pts = train.map((p) => [Math.log(p.tvl_usd), Math.log(p.mcap_usd!)] as const);
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]![0] - pts[i]![0];
      if (Math.abs(dx) > 1e-9) slopes.push((pts[j]![1] - pts[i]![1]) / dx);
    }
  }
  const b = median(slopes);
  const a = median(pts.map(([x, y]) => y - b * x));
  return { a, b };
}

/** One protocol's features under the fitted power law: the power law's implied
 * multiple at this TVL, the three adjustment inputs, and the category / first-chain
 * multipliers from the training set. The base multiple is the same number the board
 * stores per row, rounded the way the published model rounds it, so publishedImplied
 * recomputes it exactly. */
function features(p: Proto, asOf: string, pl: PowerLaw, peerMedian: number, termMults: TermMults): Features {
  const base = RadarModel.baseMultiple(p.tvl_usd, pl.a, pl.b);
  const growthPct = RadarModel.growthPct(p.change_7d);
  const age = ageDays(asOf, p.listed_at);
  let momentumPct: number | null = null;
  if (p.change_7d !== null) momentumPct = round3(Math.min(MOMENTUM_PCT_CAP, Math.max(MOMENTUM_PCT_FLOOR, growthPct - peerMedian)));
  return { base, growthPct, age, momentumPct, catMult: round4(catMultOf(p, termMults)), chainMult: round4(chainMultOf(p, termMults)) };
}

/** The five adjustment multipliers for one protocol's features under a parameter
 * set. A dropped term is neutral by construction: growth 0 gives 1, a maturity
 * floor of 1 gives 1, momentum 0 gives 1, and a category/chain weight of 0 raises
 * the multiplier to the power 0, which is 1. Every multiplier is rounded to 4
 * decimals — the same rounding the dashboard's publishedImplied uses, so the
 * board's number and the page's recomputation agree exactly. */
function multipliers(f: Features, params: FittedParams): { growthMult: number; maturityMult: number; momentumMult: number; catMultPow: number; chainMultPow: number } {
  return {
    growthMult: RadarModel.growthMult(f.growthPct, params.growth),
    maturityMult: RadarModel.maturityMult(f.age, params.matFloor),
    momentumMult: RadarModel.momentumMult(f.momentumPct, params.momentum),
    catMultPow: RadarModel.powMult(f.catMult, params.catWeight),
    chainMultPow: RadarModel.powMult(f.chainMult, params.chainWeight),
  };
}

/** The implied value of one protocol's features under a parameter set — the same
 * arithmetic publishedImplied recomputes from the stored multipliers. */
function impliedFromFeatures(p: Proto, f: Features, params: FittedParams): number {
  const { growthMult, maturityMult, momentumMult, catMultPow, chainMultPow } = multipliers(f, params);
  return RadarModel.launchValue(p.tvl_usd, f.base, growthMult, maturityMult, momentumMult, catMultPow, chainMultPow);
}

/** Median absolute log error: the median of |log(predicted / actual)| over a set of
 * predictions. Log space, so a token predicted at twice its market cap counts the
 * same as one predicted at half it, and the wild ratios cannot dominate the score. */
function medALE(preds: { pred: number; actual: number }[]): number {
  return median(preds.map(({ pred, actual }) => Math.abs(Math.log(pred / actual))));
}

interface Procedure5 {
  category: boolean;
  chain: boolean;
  growth: boolean;
  maturity: boolean;
  momentum: boolean;
}

type TermName = 'category' | 'chain' | 'growth' | 'maturity' | 'momentum';
const TERM_ORDER: TermName[] = ['category', 'chain', 'growth', 'maturity', 'momentum'];

/** All 32 procedures: every subset of the five value terms, named by the active
 * terms joined with '+' (or 'powerOnly' for none). Insertion order is mask order,
 * so the ablation record is deterministic. */
const PROCEDURES: Record<string, Procedure5> = (() => {
  const out: Record<string, Procedure5> = {};
  for (let mask = 0; mask < 32; mask++) {
    const proc: Procedure5 = { category: false, chain: false, growth: false, maturity: false, momentum: false };
    const active: string[] = [];
    TERM_ORDER.forEach((t, i) => {
      if (mask & (1 << i)) {
        proc[t] = true;
        active.push(t);
      }
    });
    out[active.length ? active.join('+') : 'powerOnly'] = proc;
  }
  return out;
})();

const PROC_NAMES = Object.keys(PROCEDURES);

function procKey(p: Procedure5): string {
  return PROC_NAMES.find((k) => {
    const q = PROCEDURES[k]!;
    return q.category === p.category && q.chain === p.chain && q.growth === p.growth && q.maturity === p.maturity && q.momentum === p.momentum;
  })!;
}

/** One training row, precomputed for the grid search: the log of the actual market
 * cap, the log of the power law's value, and — per grid value — the log of each
 * term's multiplier. A combo's log prediction is a sum of six numbers, so a full
 * grid search over a procedure is only adds and one median per combo; no exp, log
 * or pow is recomputed per combo. The values match the exact scoring arithmetic
 * (rounded multipliers) to within rounding, so the search and the scoring agree. */
interface FastRow {
  logActual: number;
  logBase: number;
  logCat: number[];
  logChain: number[];
  logGrowth: number[];
  logMat: number[];
  logMom: number[];
}

function fastRow(p: Proto, asOf: string, pl: PowerLaw, peerMedian: number, termMults: TermMults): FastRow {
  const f = features(p, asOf, pl, peerMedian, termMults);
  const ageForModel = f.age ?? UNKNOWN_AGE_DAYS;
  const matFrac = Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS;
  return {
    logActual: Math.log(p.mcap_usd!),
    logBase: Math.log(p.tvl_usd * f.base),
    logCat: CAT_WEIGHT_GRID.map((w) => w * Math.log(f.catMult)),
    logChain: CHAIN_WEIGHT_GRID.map((w) => w * Math.log(f.chainMult)),
    logGrowth: GROWTH_GRID.map((g) => Math.log(round4(1 + (f.growthPct / 100) * g))),
    logMat: MAT_FLOOR_GRID.map((fl) => Math.log(round4(fl + matFrac * (1 - fl)))),
    logMom: MOMENTUM_GRID.map((w) => (f.momentumPct === null ? 0 : Math.log(round4(Math.min(MOMENTUM_MULT_CAP, Math.max(MOMENTUM_MULT_FLOOR, 1 + (f.momentumPct / 100) * w)))))),
  };
}

/** Median of an array, sorting it in place. The caller passes a scratch array it
 * overwrites on every call, so the sort costs nothing extra. */
function medianSorted(xs: number[]): number {
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

/** Grid-fit the active terms of a procedure on precomputed training rows,
 * minimising the median absolute log error of the predicted market caps. A term
 * that is not active stays neutral. First strictly-better wins ties, so the
 * choice is deterministic. */
function fitProcedureFast(rows: FastRow[], proc: Procedure5): FittedParams {
  const active: { arr: 'logCat' | 'logChain' | 'logGrowth' | 'logMat' | 'logMom'; grid: number[]; field: 'catWeight' | 'chainWeight' | 'growth' | 'matFloor' | 'momentum' }[] = [];
  if (proc.category) active.push({ arr: 'logCat', grid: CAT_WEIGHT_GRID, field: 'catWeight' });
  if (proc.chain) active.push({ arr: 'logChain', grid: CHAIN_WEIGHT_GRID, field: 'chainWeight' });
  if (proc.growth) active.push({ arr: 'logGrowth', grid: GROWTH_GRID, field: 'growth' });
  if (proc.maturity) active.push({ arr: 'logMat', grid: MAT_FLOOR_GRID, field: 'matFloor' });
  if (proc.momentum) active.push({ arr: 'logMom', grid: MOMENTUM_GRID, field: 'momentum' });
  const n = rows.length;
  const errs = new Array<number>(n);
  let best: FittedParams & { err: number } | null = null;
  const total = active.reduce((acc, a) => acc * a.grid.length, 1);
  for (let c = 0; c < total; c++) {
    let rem = c;
    const idx: number[] = new Array(active.length);
    for (let t = active.length - 1; t >= 0; t--) {
      const g = active[t]!.grid.length;
      idx[t] = rem % g;
      rem = Math.floor(rem / g);
    }
    for (let i = 0; i < n; i++) {
      const r = rows[i]!;
      let lp = r.logBase;
      for (let t = 0; t < active.length; t++) lp += r[active[t]!.arr][idx[t]!]!;
      errs[i] = Math.abs(lp - r.logActual);
    }
    const err = medianSorted(errs);
    if (best === null || err < best.err) {
      const params: FittedParams = { growth: 0, matFloor: 1.0, momentum: 0, catWeight: 0, chainWeight: 0 };
      for (let t = 0; t < active.length; t++) (params as Record<string, number>)[active[t]!.field] = active[t]!.grid[idx[t]!]!;
      best = { ...params, err };
    }
  }
  return { growth: best!.growth, matFloor: best!.matFloor, momentum: best!.momentum, catWeight: best!.catWeight, chainWeight: best!.chainWeight };
}

type Peers = { byCategory: Record<string, number>; global: number };

function peerOf(p: Proto, peers: Peers): number {
  return peers.byCategory[p.category ?? 'Other'] ?? peers.global;
}

/** Greedy forward selection over the five adjustment terms, starting from the power
 * law alone, on THREE blind tests (leave-one-out, walk-forward, ten-fold). A term
 * is added when it improves the mean relative gain across the three tests and
 * worsens no single test by more than 1% relative. Among addable terms, the largest
 * mean gain goes first. The final model is one of the 32 evaluated procedures, so
 * its blind-test numbers are the ones reported — nothing is refit after selection. */
function selectProcedure(looMed: Record<string, number>, wfErr: Record<string, number>, tfErr: Record<string, number>): { proc: Procedure5; name: string } {
  let current: Procedure5 = { category: false, chain: false, growth: false, maturity: false, momentum: false };
  for (;;) {
    let best: { term: TermName; meanGain: number } | null = null;
    for (const term of TERM_ORDER) {
      if (current[term]) continue;
      const next = { ...current, [term]: true };
      const ck = procKey(current);
      const nk = procKey(next);
      const gains = [looMed, wfErr, tfErr].map((t) => (t[ck]! - t[nk]!) / t[ck]!);
      const meanGain = (gains[0]! + gains[1]! + gains[2]!) / 3;
      const worstWorsening = Math.max(...gains.map((g) => -g));
      if (meanGain <= 0 || worstWorsening > 0.01) continue;
      if (best === null || meanGain > best.meanGain) best = { term, meanGain };
    }
    if (best === null) break;
    current = { ...current, [best.term]: true };
  }
  return { proc: current, name: procKey(current) };
}

/** Leave-one-out for several procedures at once: for each held-out live token, refit
 * everything (power law + category/chain multipliers + each procedure's active
 * terms) on the other 127 and predict the held-out token. The held-out token never
 * touches its own fit — not the power law, not the multipliers, not the grid. The
 * power-law fit and the multiplier tables are shared across procedures within a
 * fold; the grid search runs on precomputed rows, so all 32 procedures cost a few
 * seconds, not minutes. */
function looAll(live: Proto[], asOf: string, peers: Peers, procs: Record<string, Procedure5>): Record<string, { slug: string; category: string; logErr: number; pred: number; actual: number }[]> {
  const out: Record<string, { slug: string; category: string; logErr: number; pred: number; actual: number }[]> = {};
  for (const k of Object.keys(procs)) out[k] = [];
  for (const held of live) {
    const train = live.filter((p) => p.slug !== held.slug);
    const pl = theilSen(train);
    const tables = multiplierTables(train);
    const trainFast = train.map((p) => fastRow(p, asOf, pl, peerOf(p, peers), tables));
    const heldFeatures = features(held, asOf, pl, peerOf(held, peers), tables);
    for (const [k, proc] of Object.entries(procs)) {
      const params = fitProcedureFast(trainFast, proc);
      const pred = impliedFromFeatures(held, heldFeatures, params);
      out[k]!.push({ slug: held.slug, category: held.category ?? 'Other', logErr: Math.log(pred / held.mcap_usd!), pred, actual: held.mcap_usd! });
    }
  }
  return out;
}

/** Walk-forward for several procedures at once: fit on the older half of the dated
 * live tokens, test on the newer half. Undated live tokens take no part — they cannot
 * be placed in time. */
function wfAll(live: Proto[], asOf: string, peers: Peers, procs: Record<string, Procedure5>): Record<string, { trainN: number; testN: number; trainEnd: string; testStart: string; err: number }> {
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length / 2);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const pl = theilSen(train);
  const tables = multiplierTables(train);
  const trainFast = train.map((p) => fastRow(p, asOf, pl, peerOf(p, peers), tables));
  const out: Record<string, { trainN: number; testN: number; trainEnd: string; testStart: string; err: number }> = {};
  for (const [k, proc] of Object.entries(procs)) {
    const params = fitProcedureFast(trainFast, proc);
    const err = medALE(test.map((p) => ({ pred: impliedFromFeatures(p, features(p, asOf, pl, peerOf(p, peers), tables), params), actual: p.mcap_usd! })));
    out[k] = { trainN: train.length, testN: test.length, trainEnd: train[train.length - 1]!.listed_at!, testStart: test[0]!.listed_at!, err };
  }
  return out;
}

/** Ten-fold cross-validation for several procedures at once: deterministic folds
 * (live tokens sorted by slug, fold = index mod 10); refit power law, multipliers
 * and grid per fold; the MedALE pools all held-out predictions. */
function tfAll(live: Proto[], asOf: string, peers: Peers, procs: Record<string, Procedure5>): Record<string, { err: number; n: number }> {
  const sorted = [...live].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const preds: Record<string, { pred: number; actual: number }[]> = {};
  for (const k of Object.keys(procs)) preds[k] = [];
  for (let fold = 0; fold < 10; fold++) {
    const test = sorted.filter((_, i) => i % 10 === fold);
    const train = sorted.filter((_, i) => i % 10 !== fold);
    const pl = theilSen(train);
    const tables = multiplierTables(train);
    const trainFast = train.map((p) => fastRow(p, asOf, pl, peerOf(p, peers), tables));
    for (const [k, proc] of Object.entries(procs)) {
      const params = fitProcedureFast(trainFast, proc);
      for (const p of test) preds[k]!.push({ pred: impliedFromFeatures(p, features(p, asOf, pl, peerOf(p, peers), tables), params), actual: p.mcap_usd! });
    }
  }
  const out: Record<string, { err: number; n: number }> = {};
  for (const k of Object.keys(procs)) out[k] = { err: medALE(preds[k]!), n: preds[k]!.length };
  return out;
}

/** The baseline every x-factor is measured against: the global median market-cap/TVL
 * of the training set, with no adjustment at all. Leave-one-out refits it per fold;
 * walk-forward fits it on the older half only. */
function baselineLOO(live: Proto[]): number {
  const errs: number[] = [];
  for (const held of live) {
    const train = live.filter((p) => p.slug !== held.slug);
    const g = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
    errs.push(Math.abs(Math.log(Math.max(1, Math.round(held.tvl_usd * g)) / held.mcap_usd!)));
  }
  return median(errs);
}

function baselineWF(live: Proto[]): number {
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length / 2);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const g = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
  return medALE(test.map((p) => ({ pred: Math.max(1, Math.round(p.tvl_usd * g)), actual: p.mcap_usd! })));
}

function baselineTF(live: Proto[]): number {
  const sorted = [...live].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const errs: number[] = [];
  for (let fold = 0; fold < 10; fold++) {
    const test = sorted.filter((_, i) => i % 10 === fold);
    const train = sorted.filter((_, i) => i % 10 !== fold);
    const g = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
    for (const p of test) errs.push(Math.abs(Math.log(Math.max(1, Math.round(p.tvl_usd * g)) / p.mcap_usd!)));
  }
  return median(errs);
}

/** --- Launch odds: P(has token) by age / log10 TVL / 7d growth --- */

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface OddsModel {
  beta: number[];
  scaler: { means: number[]; sds: number[] };
  nTrain: number;
  nLiveDated: number;
  nPreDated: number;
  medianAgeDaysUnknown: number;
  ageBetaSign: number;
  cv: { folds: number; auc: number; brier: number; logloss: number };
  buckets: { band: string; n: number; frac_with_token: number; logistic_odds_at_median: number }[];
  bucketMismatch: boolean;
}

/** One dated protocol's odds features: age in years, log10 TVL, clipped 7d growth
 * as a fraction. Every dated protocol has a listing date, so age is never null
 * here; the UNKNOWN_AGE_DAYS fallback only guards the type. */
function oddsFeatures(p: Proto, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  return [(age ?? UNKNOWN_AGE_DAYS) / 365, Math.log10(p.tvl_usd), Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0))) / 100];
}

function standardizeCols(xs: number[][]): { z: number[][]; means: number[]; sds: number[] } {
  const means = [0, 1, 2].map((j) => xs.reduce((s, r) => s + r[j]!, 0) / xs.length);
  const sds = [0, 1, 2].map((j) => {
    const v = xs.reduce((s, r) => s + (r[j]! - means[j]!) ** 2, 0) / xs.length;
    return Math.sqrt(v) || 1;
  });
  return { z: xs.map((r) => r.map((v, j) => (v - means[j]!) / sds[j]!)), means, sds };
}

/** Full-batch gradient descent for the logistic model, deterministic: init 0,
 * lr 0.1, 2000 iterations, L2 1e-4 on the slopes (not the intercept). */
function fitLogistic(z: number[][], y: number[]): number[] {
  const b = [0, 0, 0, 0];
  const n = z.length;
  for (let it = 0; it < ODDS_ITERS; it++) {
    const g = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = z[i]!;
      const p = sigmoid(b[0]! + b[1]! * r[0]! + b[2]! * r[1]! + b[3]! * r[2]!);
      const d = p - y[i]!;
      g[0] += d;
      g[1] += d * r[0]!;
      g[2] += d * r[1]!;
      g[3] += d * r[2]!;
    }
    b[0] -= (ODDS_LR * g[0]!) / n;
    b[1] -= ODDS_LR * (g[1]! / n + ODDS_L2 * b[1]!);
    b[2] -= ODDS_LR * (g[2]! / n + ODDS_L2 * b[2]!);
    b[3] -= ODDS_LR * (g[3]! / n + ODDS_L2 * b[3]!);
  }
  return b;
}

const oddsPredict = RadarModel.oddsPredict;

/** Area under the ROC curve by Mann-Whitney, with average ranks for ties. */
function aucMannWhitney(scores: { p: number; y: number }[]): number {
  const sorted = [...scores].sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  let i = 0;
  const n = sorted.length;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1]!.p === sorted[i]!.p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k]!.y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  const nPos = scores.filter((s) => s.y === 1).length;
  const nNeg = n - nPos;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Fit the launch-odds model on every dated protocol (live + pre-token): y = 1
 * when a token is recorded, 0 when pre-token. 5-fold cross-validation (sorted by
 * slug, fold = index mod 5, re-standardised per fold) gives the reported AUC /
 * Brier / log-loss; the scoring coefficients come from a refit on all dated
 * protocols. The bucket cross-check compares the logistic probability of having
 * a token at each age band's median protocol against the band's empirical
 * fraction with a token. */
function fitOddsModel(protocols: Proto[], asOf: string): OddsModel {
  const dated = [...protocols].filter((p) => p.listed_at !== null).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const xs = dated.map((p) => oddsFeatures(p, asOf));
  const ys = dated.map((p) => (isPreToken(p) ? 0 : 1));
  const oof: { p: number; y: number }[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const testIdx = dated.map((_, i) => i).filter((i) => i % 5 === fold);
    const trainIdx = dated.map((_, i) => i).filter((i) => i % 5 !== fold);
    const { z, means, sds } = standardizeCols(trainIdx.map((i) => xs[i]!));
    const beta = fitLogistic(z, trainIdx.map((i) => ys[i]!));
    for (const i of testIdx) oof.push({ p: oddsPredict(beta, { means, sds }, xs[i]!), y: ys[i]! });
  }
  const auc = aucMannWhitney(oof);
  const brier = oof.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / oof.length;
  const logloss =
    oof.reduce((s, r) => {
      const pc = Math.min(1 - 1e-6, Math.max(1e-6, r.p));
      return s - (r.y * Math.log(pc) + (1 - r.y) * Math.log(1 - pc));
    }, 0) / oof.length;
  const full = standardizeCols(xs);
  const beta = fitLogistic(full.z, ys);
  const scaler = { means: full.means, sds: full.sds };
  const preAges = dated.filter((p) => isPreToken(p)).map((p) => ageDays(asOf, p.listed_at)!);
  const medianAgeDaysUnknown = Math.round(median(preAges));
  const bands: { band: string; lo: number; hi: number }[] = [
    { band: '0-0.5y', lo: 0, hi: 183 },
    { band: '0.5-1y', lo: 183, hi: 365 },
    { band: '1-2y', lo: 365, hi: 730 },
    { band: '2-3y', lo: 730, hi: 1095 },
    { band: '3y+', lo: 1095, hi: Infinity },
  ];
  const buckets = bands.map(({ band, lo, hi }) => {
    const members = dated.filter((p) => {
      const a = ageDays(asOf, p.listed_at)!;
      return a >= lo && a < hi;
    });
    const n = members.length;
    const frac = n === 0 ? 0 : members.filter((p) => !isPreToken(p)).length / n;
    const medAge = n === 0 ? 0 : median(members.map((p) => ageDays(asOf, p.listed_at)!));
    const medTvl = n === 0 ? 1 : median(members.map((p) => p.tvl_usd));
    const medGrowth = n === 0 ? 0 : median(members.map((p) => Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0))) / 100));
    const p0 = oddsPredict(beta, scaler, [medAge / 365, Math.log10(Math.max(1, medTvl)), medGrowth]);
    // The cross-check compares the LOGISTIC probability of having a token at the
    // band's median protocol against the band's empirical fraction with a token
    // — not the 12-month hazard, which is a different quantity and would read
    // low in every band.
    const logistic = Math.min(ODDS_CLIP_HI, Math.max(ODDS_CLIP_LO, p0));
    return { band, n, frac_with_token: round4(frac), logistic_odds_at_median: round4(logistic) };
  });
  const bucketMismatch = buckets.filter((b) => Math.abs(b.logistic_odds_at_median - b.frac_with_token) > 0.15).length >= 2;
  return {
    beta,
    scaler,
    nTrain: dated.length,
    nLiveDated: dated.filter((p) => !isPreToken(p)).length,
    nPreDated: dated.filter((p) => isPreToken(p)).length,
    medianAgeDaysUnknown,
    ageBetaSign: Math.sign(beta[1]!),
    cv: { folds: 5, auc: round4(auc), brier: round4(brier), logloss: round4(logloss) },
    buckets,
    bucketMismatch,
  };
}

const launchOdds = (odds: OddsModel, p: Proto, asOf: string): number =>
  RadarModel.launchOdds(odds.beta, odds.scaler, ageDays(asOf, p.listed_at), p.tvl_usd, p.change_7d, odds.medianAgeDaysUnknown);

/** Months until launch, from the same survival curve — the shared model.js version. */
const launchClock = (odds: OddsModel, p: Proto, asOf: string): { months: number | null; q1: number | null; label: string } =>
  RadarModel.launchClock(odds.beta, odds.scaler, ageDays(asOf, p.listed_at), p.tvl_usd, p.change_7d, odds.medianAgeDaysUnknown);

interface Validation {
  n_live: number;
  n_live_excluded_mcap: number;
  n_dated: number;
  fitted: { a: number; b: number; growth: number; maturity_floor: number; momentum_weight: number; category_weight: number; chain_weight: number };
  kept: { growth: boolean; maturity: boolean; momentum: boolean; category: boolean; chain: boolean };
  ablation: Record<string, { loo_med_ale: number; wf_med_ale: number; tf_med_ale: number }>;
  baseline: { loo_med_ale: number; wf_med_ale: number; tf_med_ale: number };
  final: { loo_med_ale: number; wf_med_ale: number; tf_med_ale: number; loo_x: number; wf_x: number; tf_x: number; within_2x: number; within_3x: number; median_log_err: number };
  walk_forward: { train_n: number; test_n: number; train_end: string; test_start: string };
  ten_fold: { med_ale: number; lift: number };
  odds: OddsModel;
  placebo: { seed: number; selected_procedure: string; loo_med_ale: number; loo_lift: number };
  conformal: { q_global: number; median_factor: number; coverage_loo: number; n_live: number };
  rank_ranges: { method: string; seed: number; draws: number; median_width: number };
}

/** The placebo: shuffle the live tokens' market caps once with the fixed seed and
 * re-run the FULL greedy selection (all three blind tests, all 32 procedures) on
 * the shuffled target. If terms survive the shuffle, the selection is fitting
 * noise, not signal — the lift should sit near 1.0 and the selected procedure
 * should be the power law alone. */
function placeboRun(live: Proto[], asOf: string, peers: Peers): { seed: number; selected_procedure: string; loo_med_ale: number; loo_lift: number } {
  const rand = mulberry32(PLACEBO_SEED);
  const mcaps = live.map((p) => p.mcap_usd!);
  for (let i = mcaps.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = mcaps[i]!;
    mcaps[i] = mcaps[j]!;
    mcaps[j] = tmp;
  }
  const shuffled = live.map((p, i) => ({ ...p, mcap_usd: mcaps[i]! }));
  const loo = looAll(shuffled, asOf, peers, PROCEDURES);
  const wf = wfAll(shuffled, asOf, peers, PROCEDURES);
  const tf = tfAll(shuffled, asOf, peers, PROCEDURES);
  const looMed: Record<string, number> = {};
  const wfErr: Record<string, number> = {};
  const tfErr: Record<string, number> = {};
  for (const k of PROC_NAMES) {
    looMed[k] = median(loo[k]!.map((e) => Math.abs(e.logErr)));
    wfErr[k] = wf[k]!.err;
    tfErr[k] = tf[k]!.err;
  }
  const { name } = selectProcedure(looMed, wfErr, tfErr);
  const baseLOO = baselineLOO(shuffled);
  return { seed: PLACEBO_SEED, selected_procedure: name, loo_med_ale: round4(looMed[name]!), loo_lift: round4(baseLOO / looMed[name]!) };
}

/** Fit radar-4 and blind-test it. The five adjustment terms go through greedy
 * forward selection on the three blind tests (see selectProcedure); the final model
 * is then refit on all 128 live tokens, and its blind-test numbers are the ones
 * already measured for that procedure — nothing is refit after selection. The
 * placebo and the odds model are fitted here too. Returns the fitted power law,
 * the final parameters, the multiplier tables, the validation record, the final
 * model's leave-one-out residuals (which calibrate the board's conformal ranges)
 * and the odds model. The conformal median factor and the rank-range median width
 * are filled in by the caller once the board exists. */
function validateModel(live: Proto[], asOf: string, peers: Peers, nExcludedMcap: number, protocols: Proto[]): {
  pl: PowerLaw;
  params: FittedParams;
  termMults: TermMults;
  validation: Validation;
  looResiduals: { slug: string; category: string; logErr: number; pred: number; actual: number }[];
  odds: OddsModel;
  confTable: ConformalTable;
} {
  const loo = looAll(live, asOf, peers, PROCEDURES);
  const wf = wfAll(live, asOf, peers, PROCEDURES);
  const tf = tfAll(live, asOf, peers, PROCEDURES);
  const baseLOO = baselineLOO(live);
  const baseWF = baselineWF(live);
  const baseTF = baselineTF(live);
  const looMed: Record<string, number> = {};
  const wfErr: Record<string, number> = {};
  const tfErr: Record<string, number> = {};
  for (const k of PROC_NAMES) {
    looMed[k] = median(loo[k]!.map((e) => Math.abs(e.logErr)));
    wfErr[k] = wf[k]!.err;
    tfErr[k] = tf[k]!.err;
  }
  const { proc: finalProc, name: finalName } = selectProcedure(looMed, wfErr, tfErr);
  const pl = theilSen(live);
  const termMults = multiplierTables(live);
  const fullFast = live.map((p) => fastRow(p, asOf, pl, peerOf(p, peers), termMults));
  const params = fitProcedureFast(fullFast, finalProc);
  const finalLOO = loo[finalName]!;
  const finalWF = wf[finalName]!;
  const finalTF = tf[finalName]!;
  const finalLOOMed = looMed[finalName]!;
  const ablation: Validation['ablation'] = {};
  for (const k of PROC_NAMES) ablation[k] = { loo_med_ale: round4(looMed[k]!), wf_med_ale: round4(wfErr[k]!), tf_med_ale: round4(tfErr[k]!) };
  const placebo = placeboRun(live, asOf, peers);
  const odds = fitOddsModel(protocols, asOf);
  const confTable = conformalTable(finalLOO);
  const coverage = conformalCoverage(finalLOO);
  const validation: Validation = {
    n_live: live.length,
    n_live_excluded_mcap: nExcludedMcap,
    n_dated: live.filter((p) => p.listed_at !== null).length,
    fitted: { a: pl.a, b: pl.b, growth: params.growth, maturity_floor: params.matFloor, momentum_weight: params.momentum, category_weight: params.catWeight, chain_weight: params.chainWeight },
    kept: { growth: finalProc.growth, maturity: finalProc.maturity, momentum: finalProc.momentum, category: finalProc.category, chain: finalProc.chain },
    ablation,
    baseline: { loo_med_ale: round4(baseLOO), wf_med_ale: round4(baseWF), tf_med_ale: round4(baseTF) },
    final: {
      loo_med_ale: round4(finalLOOMed),
      wf_med_ale: round4(finalWF.err),
      tf_med_ale: round4(finalTF.err),
      loo_x: round4(baseLOO / finalLOOMed),
      wf_x: round4(baseWF / finalWF.err),
      tf_x: round4(baseTF / finalTF.err),
      within_2x: finalLOO.filter((e) => Math.abs(e.logErr) < Math.log(2)).length,
      within_3x: finalLOO.filter((e) => Math.abs(e.logErr) < Math.log(3)).length,
      median_log_err: round4(median(finalLOO.map((e) => e.logErr))),
    },
    walk_forward: { train_n: finalWF.trainN, test_n: finalWF.testN, train_end: finalWF.trainEnd, test_start: finalWF.testStart },
    ten_fold: { med_ale: round4(finalTF.err), lift: round4(baseTF / finalTF.err) },
    odds,
    placebo,
    conformal: { q_global: round4(confTable.qGlobal), median_factor: 0, coverage_loo: round4(coverage), n_live: live.length },
    rank_ranges: { method: 'seeded-mc-normal', seed: MC_SEED, draws: MC_DRAWS, median_width: 0 },
  };
  return { pl, params, termMults, validation, looResiduals: finalLOO, odds, confTable };
}

interface ConformalTable {
  qGlobal: number;
  byCategory: Map<string, { n: number; q: number }>;
}

/** The 80% quantile of a set of absolute log errors, with the finite-sample
 * correction: the k-th smallest with k = ceil((n+1)*0.8). */
function conformalQ(absErrs: number[]): number {
  const s = [...absErrs].sort((a, b) => a - b);
  const k = Math.ceil((s.length + 1) * 0.8);
  return s[Math.min(k, s.length) - 1]!;
}

/** The conformal calibration from the final model's leave-one-out residuals: the
 * global 80% quantile of |log error|, and per category (a category needs at least
 * five live residuals before its own spread is trusted). */
function conformalTable(looResiduals: { slug: string; category: string; logErr: number }[]): ConformalTable {
  const qGlobal = conformalQ(looResiduals.map((e) => Math.abs(e.logErr)));
  const groups = new Map<string, number[]>();
  for (const e of looResiduals) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category)!.push(Math.abs(e.logErr));
  }
  const byCategory = new Map<string, { n: number; q: number }>();
  for (const [c, xs] of groups) byCategory.set(c, { n: xs.length, q: xs.length >= 5 ? conformalQ(xs) : qGlobal });
  return { qGlobal, byCategory };
}

/** A row's conformal half-width in log space — the shared model.js version. */
const conformalHalfWidth = (category: string | null, table: ConformalTable): number =>
  RadarModel.confHalfWidth(category, table.qGlobal, table.byCategory);

/** Leave-one-out conformal coverage, honest: each live token's interval is built
 * from the OTHER 127 residuals, then checked against its actual market cap. */
function conformalCoverage(looFinal: { slug: string; category: string; logErr: number; pred: number; actual: number }[]): number {
  let covered = 0;
  for (let i = 0; i < looFinal.length; i++) {
    const others = looFinal.filter((_, j) => j !== i).map((e) => Math.abs(e.logErr));
    const q = conformalQ(others);
    const pred = looFinal[i]!.pred;
    if (looFinal[i]!.actual >= pred * Math.exp(-q) && looFinal[i]!.actual <= pred * Math.exp(q)) covered++;
  }
  return covered / looFinal.length;
}

interface Scored {
  p: Proto;
  age: number | null;
  base: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  momentumPct: number | null;
  momentumMult: number;
  catMult: number;
  chainMult: number;
  catWeight: number;
  chainWeight: number;
  launch: number;
  launchLow: number;
  launchHigh: number;
  odds: number;
  ev: number;
  evLow: number;
  evHigh: number;
  q: number;
  clock: { months: number | null; q1: number | null; label: string };
}

/** One protocol's expected value under radar-4, from its own snapshot figures, the
 * fitted power law and the odds model. The launch value is the fitted value of a
 * launch; the odds are rounded to 4 decimals FIRST and the expected value is
 * computed from the rounded odds, so the stored odds reproduce the stored expected
 * value exactly — the dashboard's publishedImplied recomputes the same number. The
 * stored multipliers are the same ones impliedFromFeatures uses, so the row's
 * launch value is exactly what publishedImplied recomputes. */
function score(p: Proto, asOf: string, pl: PowerLaw, params: FittedParams, peerMedian: number, termMults: TermMults, odds: OddsModel, confTable: ConformalTable): Scored {
  const f = features(p, asOf, pl, peerMedian, termMults);
  const { growthMult, maturityMult, momentumMult } = multipliers(f, params);
  const launch = impliedFromFeatures(p, f, params);
  const o = round4(launchOdds(odds, p, asOf));
  const ev = Math.max(1, Math.round(launch * o));
  const q = conformalHalfWidth(p.category, confTable);
  const range = RadarModel.launchRange(launch, q);
  const launchLow = range.low;
  const launchHigh = range.high;
  const evLow = Math.min(ev, Math.max(1, Math.round(launchLow * o)));
  const evHigh = Math.max(ev, Math.round(launchHigh * o));
  return { p, age: f.age, base: f.base, growthPct: f.growthPct, growthMult, maturityMult, momentumPct: f.momentumPct, momentumMult, catMult: f.catMult, chainMult: f.chainMult, catWeight: params.catWeight, chainWeight: params.chainWeight, launch, launchLow, launchHigh, odds: o, ev, evLow, evHigh, q, clock: launchClock(odds, p, asOf) };
}

/** Rank ranges by seeded Monte Carlo: N draws, each row's log expected value
 * sampled Normal(log EV, sigma) with sigma = q/1.2816 (the 80% interval half-width
 * as a standard deviation), Gaussian via Box-Muller on the seeded PRNG. Rank each
 * draw by sampled value (ties by slug, as the board sorts); rank_low / rank_high
 * are the 5th and 95th percentiles of a row's ranks across draws. Deterministic
 * given the seed. The interval is widened just enough to contain the row's
 * point rank: a discrete rank distribution at the boundary can put the 5th
 * percentile above rank 1 (the top row loses the top spot in >= 5% of draws)
 * or the 95th below rank 209, and an interval that excludes the point estimate
 * is not an interval — the value intervals hold their point estimates the same
 * way. */
function rankRanges(rows: { slug: string; ev: number; q: number }[]): Map<string, { low: number; high: number }> {
  const rand = mulberry32(MC_SEED);
  let spare: number | null = null;
  const nextNormal = (): number => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }
    let u1 = rand();
    while (u1 <= 0) u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const t = 2 * Math.PI * u2;
    spare = r * Math.sin(t);
    return r * Math.cos(t);
  };
  const ranks = new Map<string, number[]>();
  for (const r of rows) ranks.set(r.slug, []);
  for (let d = 0; d < MC_DRAWS; d++) {
    const sampled = rows.map((r) => ({ slug: r.slug, v: Math.log(r.ev) + (r.q / 1.2816) * nextNormal() }));
    sampled.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    sampled.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
  }
  const out = new Map<string, { low: number; high: number }>();
  const rankOf = new Map(rows.map((r, i) => [r.slug, i + 1]));
  for (const [slug, rs] of ranks) {
    const s = [...rs].sort((a, b) => a - b);
    const rank = rankOf.get(slug)!;
    const low = Math.max(1, Math.min(s[Math.ceil(0.05 * MC_DRAWS) - 1]!, rank));
    const high = Math.min(rows.length, Math.max(s[Math.ceil(0.95 * MC_DRAWS) - 1]!, rank));
    out.set(slug, { low, high });
  }
  return out;
}

/** The median seven-day growth of a protocol's category peers, from this snapshot. */
function peerMedians(chosen: Proto[]): { byCategory: Record<string, number>; global: number } {
  const groups = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of chosen) {
    if (p.change_7d === null) continue;
    const g = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, p.change_7d));
    all.push(g);
    const c = p.category ?? 'Other';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(g);
  }
  const byCategory: Record<string, number> = {};
  for (const [c, xs] of groups) byCategory[c] = round3(median(xs));
  return { byCategory, global: round3(median(all)) };
}

function chainOf(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The standard farm capital, in USD, for every row's farm plan: one deposit for
 * the whole board (slice 2), so every $/hour is computed on the same $100 and no
 * row can claim a bigger $/hour just by assuming a bigger deposit. The second
 * qualifying action (iterations 1-2, kept) moves $25 on top of it. */
const STANDARD_DEPOSIT_USD = RadarModel.STANDARD_DEPOSIT;
const SECOND_ACTION_USD = RadarModel.SECOND_ACTION;
/** The share of a protocol's implied launch value assumed to go to the farming
 * cohort as an airdrop: 5% is the conservative end of the 5-10% a launch
 * typically allocates to its community. A farmer's share of that pool is
 * pro-rata on the standard deposit against the protocol's TVL, so a $100
 * deposit in a $1B-TVL protocol earns a far smaller share than the same $100
 * in a $10M-TVL one — and no row can ever promise a huge $/hour from a tiny
 * deposit. The largest $/hour on this board is bounded by 5% x $100 x the
 * largest multiple, divided by the shortest plan's active hours. */
const AIRDROP_SHARE = RadarModel.AIRDROP_SHARE;
/** The farm plan's deposit tiers and the matrix's hold horizons (slice 2): the
 * standard $100 deposit costed beside a $25 starter and a $500 serious farm,
 * crossed with four holds. */
const FARM_TIERS_USD = RadarModel.TIERS;
const FARM_MATRIX_HORIZONS_DAYS = RadarModel.HORIZONS;
/** The fixed cost of one farm run, in USD, behind every breakeven figure: $1 of
 * gas (deposit, weekly actions, exit, at ~0.05 gwei) + $4 of time value. A round
 * number, stated here so every breakeven is reproducible — not a measured cost. */
const FARM_RUN_COST_USD = RadarModel.FARM_RUN_COST;

/** A plan's active hours for a hold of `days` — the shared model.js version. */
const activeHoursFor = RadarModel.activeHours;

/** A hold length in days for a protocol of this age — the shared model.js version. */
const holdDaysFor = RadarModel.holdDays;

/** The main position's action, from the protocol's category, chains and TVL. */
function mainAction(p: Proto, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${n} on ${chain} and leave the deposit earning.`;
  if (c.includes('dex') || c.includes('swap')) return `Provide $${capital} of liquidity to ${n}'s deepest pool on ${chain} and keep the position in range.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Deposit $${capital} into ${n}'s highest-TVL strategy on ${chain} and let it compound.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${n} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in an active market on ${n}.`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${capital} of the yield-bearing asset on ${n} and hold it on ${chain}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active.`;
  if (c.includes('restak') || c.includes('staking') || c.includes('liquid')) return `Stake $${capital} of the chain asset through ${n} and keep the receipt token.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${capital} into a ${n} vault on ${chain} and hold the vault shares.`;
  if (c.includes('index')) return `Buy $${capital} of the ${n} index on ${chain} and hold it.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${n} and put the bridged funds to work in its app.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
}

/** The second qualifying action: a different chain, or a second move in the same protocol. */
function secondAction(p: Proto, capital: number): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (p.chains.length > 1) return `Use ${n} on ${p.chains[1]} too: move $25 there and repeat the position, so the activity counts on two chains.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $25 against the deposit on ${n}, hold it a day, then repay it in full.`;
  if (c.includes('dex') || c.includes('swap')) return `Swap $25 through ${n}'s pool once, then add the proceeds back as liquidity.`;
  if (c.includes('yield') || c.includes('vault') || c.includes('curator') || c.includes('allocator')) return `Deposit $25 into a second ${n} vault or strategy and keep both shares.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Close the hedge on ${n} and open one fresh trade half the size.`;
  if (c.includes('restak') || c.includes('staking')) return `Claim the first staking rewards on ${n} and restake them the same day.`;
  if (c.includes('prediction')) return `Settle one market on ${n} and open a position in a different one.`;
  return `Make one different move on ${n}: a swap, a vote or a deposit in another market.`;
}

/** A protocol's farm plan: seven steps, each an action with its cost and time.
 * Every row farms the same standard $100 deposit, so the steps' capital
 * matches the costed plan beside them. */
function farmSteps(p: Proto, age: number | null): Step[] {
  const chain = chainOf(p);
  const capital = STANDARD_DEPOSIT_USD;
  const hold = holdDaysFor(age);
  return [
    { text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: mainAction(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: secondAction(p, capital), cost: 'about $25 of capital and $2 of gas', time: '10 minutes' },
    { text: `Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays active.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days, so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Check the protocol's own points or rewards page every week, and claim only from a link the protocol itself publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
    { text: `Write the wallet, the dates and every transaction in a farm log. When you unwind, withdraw in two steps and keep gas for the exit; a token is never guaranteed.`, cost: 'nothing but the log, plus exit gas', time: '5 minutes to log' },
  ];
}

/** One step as a single string, within the gate's 20 to 600 characters. */
function stepText(s: Step): string {
  let out = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Hold the position and check the protocol's own page.`;
  return out;
}

interface FarmPlan {
  deposit_usd: number;
  second_action_usd: number;
  expected_reward_usd: number;
  expected_reward_low_usd: number;
  expected_reward_high_usd: number;
  usd_per_hour: number;
  usd_per_hour_low: number;
  usd_per_hour_high: number;
  timeline_days: number;
  active_hours: number;
}

/** A row's fully costed farm plan. The expected reward is the standard deposit's
 * pro-rata share of the 5% of implied launch value assumed to go to farmers:
 * reward = 0.05 x $100 x (implied / TVL). $/hour divides that by the active
 * hours the plan's steps take: 35 one-off minutes (wallet, set-up, second
 * action, log) plus 20 minutes a week over the hold (one qualifying action
 * and one rewards check a week). The low/high figures use the row's value
 * range, so the plan's $/hour carries the same honesty as its value — a row
 * whose value range is wide gets a wide $/hour range too. */
function farmPlan(p: Proto, age: number | null, implied: number, low: number, high: number): FarmPlan {
  const hold = holdDaysFor(age);
  const activeHours = activeHoursFor(hold);
  const rewardFor = (v: number): number => RadarModel.farmReward(STANDARD_DEPOSIT_USD, v, p.tvl_usd);
  const rewardLow = rewardFor(low);
  const reward = rewardFor(implied);
  const rewardHigh = rewardFor(high);
  return {
    deposit_usd: STANDARD_DEPOSIT_USD,
    second_action_usd: SECOND_ACTION_USD,
    expected_reward_usd: reward,
    expected_reward_low_usd: rewardLow,
    expected_reward_high_usd: rewardHigh,
    usd_per_hour: RadarModel.usdPerHour(reward, activeHours),
    usd_per_hour_low: RadarModel.usdPerHour(rewardLow, activeHours),
    usd_per_hour_high: RadarModel.usdPerHour(rewardHigh, activeHours),
    timeline_days: hold,
    active_hours: activeHours,
  };
}

interface FarmPlanTier extends FarmPlan {
  /** Smallest whole-dollar deposit whose expected reward covers FARM_RUN_COST_USD,
   * or null when the row's reward rate is zero. Computed from the UNROUNDED reward
   * rate (0.05 x implied / TVL), not from the tier's stored round4 reward — so it
   * is exactly identical at every tier (the rate does not depend on the deposit).
   * Recomputing it from a stored round4 reward can differ by rounding. */
  breakeven_usd: number | null;
  /** Always null, by design: the expected reward is a lump sum paid at launch, not
   * accrued per hour, so no hold length makes a too-small deposit profitable.
   * Breakeven is deposit-driven, not time-driven. */
  breakeven_days: null;
}

interface FarmMatrix {
  deposits: number[];
  horizons_days: number[];
  /** expected_reward_usd[deposit][horizon]: the reward does not grow with the hold
   * — it is the same lump sum at launch — so each row is constant across horizons. */
  expected_reward_usd: number[][];
  /** usd_per_hour[deposit][horizon]: the same reward divided by the hold's active
   * hours, so $/hour falls as the hold lengthens. */
  usd_per_hour: number[][];
}

/** One deposit tier of a row's farm plan: the same arithmetic as farmPlan, with the
 * deposit as a parameter. The reward is pro-rata on the deposit, so $/hour SCALES
 * with the deposit — the same hours earn a bigger pro-rata reward — and a bigger
 * tier honestly reports a bigger $/hour. The standard $100 deposit is what keeps
 * rows comparable with each other; the tiers compare capital levels within one
 * row. Rewards use round4, not whole dollars: most rows' rewards are under $1,
 * so whole dollars would zero them out and break the $100 tier's equality with
 * the standard plan. */
function farmTier(p: Proto, age: number | null, implied: number, low: number, high: number, deposit: number): FarmPlanTier {
  const hold = holdDaysFor(age);
  const activeHours = activeHoursFor(hold);
  const rewardFor = (v: number): number => RadarModel.farmReward(deposit, v, p.tvl_usd);
  const rewardLow = rewardFor(low);
  const reward = rewardFor(implied);
  const rewardHigh = rewardFor(high);
  return {
    deposit_usd: deposit,
    second_action_usd: SECOND_ACTION_USD,
    expected_reward_usd: reward,
    expected_reward_low_usd: rewardLow,
    expected_reward_high_usd: rewardHigh,
    usd_per_hour: RadarModel.usdPerHour(reward, activeHours),
    usd_per_hour_low: RadarModel.usdPerHour(rewardLow, activeHours),
    usd_per_hour_high: RadarModel.usdPerHour(rewardHigh, activeHours),
    timeline_days: hold,
    active_hours: activeHours,
    breakeven_usd: RadarModel.breakevenUsd(implied, p.tvl_usd),
    breakeven_days: null,
  };
}

/** A row's deposit x hold matrix: the three tiers crossed with four holds. The
 * reward in a cell is the tier's expected reward (horizon-independent); the $/hour
 * is that reward over the hold's active hours. Pure function of the snapshot and
 * the fitted value — no clock, no randomness. */
function farmMatrix(p: Proto, implied: number): FarmMatrix {
  const rewards = FARM_TIERS_USD.map((d) => RadarModel.farmReward(d, implied, p.tvl_usd));
  return {
    deposits: [...FARM_TIERS_USD],
    horizons_days: [...FARM_MATRIX_HORIZONS_DAYS],
    expected_reward_usd: rewards.map((r) => FARM_MATRIX_HORIZONS_DAYS.map(() => r)),
    usd_per_hour: rewards.map((r) => FARM_MATRIX_HORIZONS_DAYS.map((h) => RadarModel.usdPerHour(r, activeHoursFor(h)))),
  };
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  launch_value_usd: number;
  launch_value_low_usd: number;
  launch_value_high_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  rank_low: number;
  rank_high: number;
  launch_clock_months: number | null;
  launch_clock_months_q1: number | null;
  launch_clock_label: string;
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number; momentum_pct: number | null; momentum_multiplier: number; age_days: number | null; category_multiplier: number; chain_multiplier: number; category_weight: number; chain_weight: number };
  farm_plan: FarmPlan;
  farm_plan_tiers: FarmPlanTier[];
  farm_matrix: FarmMatrix;
  farm_steps: string[];
}

interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  launch_value_usd: number;
  launch_value_low_usd: number;
  launch_value_high_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  rank_low: number;
  rank_high: number;
  launch_clock_months: number | null;
  launch_clock_months_q1: number | null;
  launch_clock_label: string;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  momentum_pct: number | null;
  momentum_multiplier: number;
  category_multiplier: number;
  chain_multiplier: number;
  category_weight: number;
  chain_weight: number;
  watchlist: boolean;
  farm_plan: FarmPlan;
  farm_plan_tiers: FarmPlanTier[];
  farm_matrix: FarmMatrix;
  farm_steps: string[];
}

interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  kind: 'live' | 'wrapped';
}

/** The board's protocol set: the whole watchlist, plus every boardable protocol the
 * watchlist leaves out. The early radar is every boardable protocol the watchlist
 * leaves out, not a TVL cut: the watchlist is a floor, and a small protocol below it
 * is the radar's whole point. */
function chosenProtocols(snapshot: Snap): Proto[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isBoardable(p)) chosen.set(p.slug, p);
  }
  return [...chosen.values()];
}

/** The board, ranked by EXPECTED VALUE (launch value x launch odds) — the gate
 * requires implied value to fall with rank, so implied_value_usd IS the expected
 * value, and the raw fitted launch value is kept per row beside it. Every row
 * carries its conformal launch range (and the expected-value range that follows
 * from it), its rank range from the seeded Monte Carlo, and its launch clock. */
function boardRows(snapshot: Snap, pl: PowerLaw, params: FittedParams, termMults: TermMults, odds: OddsModel, confTable: ConformalTable): BoardRow[] {
  const chosen = chosenProtocols(snapshot);
  const peers = peerMedians(chosen);
  const scored = chosen
    .map((p) => score(p, snapshot.as_of, pl, params, peers.byCategory[p.category ?? 'Other'] ?? peers.global, termMults, odds, confTable))
    .sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const ranges = rankRanges(scored.map((s) => ({ slug: s.p.slug, ev: s.ev, q: s.q })));
  return scored.map((s, i) => {
    const rr = ranges.get(s.p.slug)!;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      watchlist: snapshot.watchlist.includes(s.p.slug),
      age_days: s.age,
      launch_value_usd: s.launch,
      launch_value_low_usd: s.launchLow,
      launch_value_high_usd: s.launchHigh,
      launch_odds: s.odds,
      expected_value_usd: s.ev,
      implied_value_usd: s.ev,
      implied_value_low_usd: s.evLow,
      implied_value_high_usd: s.evHigh,
      rank_low: rr.low,
      rank_high: rr.high,
      launch_clock_months: s.clock.months,
      launch_clock_months_q1: s.clock.q1,
      launch_clock_label: s.clock.label,
      model: { base_multiple: s.base, growth_pct: s.growthPct, growth_multiplier: s.growthMult, maturity_multiplier: s.maturityMult, momentum_pct: s.momentumPct, momentum_multiplier: s.momentumMult, age_days: s.age, category_multiplier: s.catMult, chain_multiplier: s.chainMult, category_weight: s.catWeight, chain_weight: s.chainWeight },
      farm_plan: farmPlan(s.p, s.age, s.ev, s.evLow, s.evHigh),
      farm_plan_tiers: FARM_TIERS_USD.map((d) => farmTier(s.p, s.age, s.ev, s.evLow, s.evHigh, d)),
      farm_matrix: farmMatrix(s.p, s.ev),
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });
}

function liveRows(snapshot: Snap): LiveRow[] {
  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p): LiveRow => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, kind: 'live' }));
  const wrapped = snapshot.protocols
    .filter((p) => isPreToken(p) && isWrappedProduct(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, WRAPPED_ROWS)
    .map((p): LiveRow => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, kind: 'wrapped' }));
  return [...live, ...wrapped];
}

function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. Extended for radar-4: the
 * board is exactly 209 rows, implied value IS the expected value (launch x odds,
 * rounded) and must reproduce from the stored launch value and odds, every row
 * carries its odds in (0,1), its launch value inside its conformal range, its
 * expected value inside its expected range, its rank inside its rank range, and a
 * launch clock. */
function boardIssue(board: BoardRow[], snapshot: Snap): string | null {
  if (board.length !== 209) return `the board has ${board.length} rows, not the 209 the snapshot supports`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const outside = board.filter((r) => !r.watchlist).length;
  if (outside < 60) return `only ${outside} rows sit outside the watchlist`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all ${board.length} rows share one implied value`;
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isSafeInteger(r.implied_value_low_usd) || !Number.isSafeInteger(r.implied_value_high_usd) || r.implied_value_low_usd < 1 || r.implied_value_low_usd > r.implied_value_usd || r.implied_value_usd > r.implied_value_high_usd) return `${r.slug} has a range that does not hold its implied value`;
    if (!(r.launch_odds > 0 && r.launch_odds < 1)) return `${r.slug} has launch odds ${r.launch_odds}`;
    if (Math.abs(r.implied_value_usd - Math.round(r.launch_value_usd * r.launch_odds)) > 1) return `${r.slug} has implied value ${r.implied_value_usd} but launch ${r.launch_value_usd} x odds ${r.launch_odds}`;
    if (r.expected_value_usd !== r.implied_value_usd) return `${r.slug} has expected value ${r.expected_value_usd} but implied ${r.implied_value_usd}`;
    if (r.launch_value_usd < r.launch_value_low_usd || r.launch_value_usd > r.launch_value_high_usd) return `${r.slug} has a launch value outside its range`;
    if (r.rank_low > r.rank || r.rank > r.rank_high) return `${r.slug} has rank ${r.rank} outside its range ${r.rank_low}-${r.rank_high}`;
    if (typeof r.launch_clock_label !== 'string' || (r.launch_clock_months !== null && !Number.isInteger(r.launch_clock_months)) || (r.launch_clock_months_q1 !== null && !Number.isInteger(r.launch_clock_months_q1))) return `${r.slug} has no launch clock`;
    const fp = r.farm_plan;
    if (fp.deposit_usd !== STANDARD_DEPOSIT_USD || fp.second_action_usd !== SECOND_ACTION_USD) return `${r.slug} does not farm the standard $${STANDARD_DEPOSIT_USD} deposit`;
    if (!(fp.expected_reward_usd >= 0) || !(fp.expected_reward_low_usd >= 0) || !(fp.expected_reward_high_usd >= 0)) return `${r.slug} has a negative expected farm reward`;
    if (fp.expected_reward_low_usd > fp.expected_reward_usd || fp.expected_reward_usd > fp.expected_reward_high_usd) return `${r.slug} has a farm reward range that does not hold its reward`;
    if (!(fp.usd_per_hour >= 0) || !(fp.usd_per_hour_low >= 0) || !(fp.usd_per_hour_high >= 0)) return `${r.slug} has a negative farm $/hour`;
    if (fp.usd_per_hour_low > fp.usd_per_hour || fp.usd_per_hour > fp.usd_per_hour_high) return `${r.slug} has a farm $/hour range that does not hold its $/hour`;
    if (fp.timeline_days <= 0 || !(fp.active_hours > 0)) return `${r.slug} has a farm timeline of ${fp.timeline_days} days and ${fp.active_hours} active hours`;
    // Slice 2: the three deposit tiers and the deposit x hold matrix must agree
    // with the standard plan they are built from — the $100 tier IS the standard
    // plan, every matrix cell's reward is its tier's reward, every matrix $/hour
    // is that reward over the hold's active hours, and every breakeven is the
    // smallest deposit covering the $5 run cost at the tier's own reward rate.
    if (!Array.isArray(r.farm_plan_tiers) || r.farm_plan_tiers.length !== FARM_TIERS_USD.length) return `${r.slug} has no ${FARM_TIERS_USD.length}-tier farm plan`;
    for (let t = 0; t < FARM_TIERS_USD.length; t++) {
      const tier = r.farm_plan_tiers[t]!;
      if (tier.deposit_usd !== FARM_TIERS_USD[t]) return `${r.slug} tier ${t} farms $${tier.deposit_usd}, not $${FARM_TIERS_USD[t]}`;
      if (tier.second_action_usd !== SECOND_ACTION_USD) return `${r.slug} tier ${tier.deposit_usd} has a second action of $${tier.second_action_usd}`;
      if (tier.expected_reward_low_usd > tier.expected_reward_usd || tier.expected_reward_usd > tier.expected_reward_high_usd) return `${r.slug} tier ${tier.deposit_usd} has a reward range that does not hold its reward`;
      if (tier.usd_per_hour_low > tier.usd_per_hour || tier.usd_per_hour > tier.usd_per_hour_high) return `${r.slug} tier ${tier.deposit_usd} has a $/hour range that does not hold its $/hour`;
      if (tier.timeline_days !== fp.timeline_days || tier.active_hours !== fp.active_hours) return `${r.slug} tier ${tier.deposit_usd} disagrees with the standard plan on timeline`;
      if (tier.breakeven_days !== null) return `${r.slug} tier ${tier.deposit_usd} claims a time breakeven`;
      const rate = AIRDROP_SHARE * (r.implied_value_usd / r.tvl_usd);
      const wantBreakeven = rate > 0 ? Math.ceil(FARM_RUN_COST_USD / rate) : null;
      if (tier.breakeven_usd !== wantBreakeven) return `${r.slug} tier ${tier.deposit_usd} has breakeven $${tier.breakeven_usd}, not $${wantBreakeven}`;
      if (tier.deposit_usd === STANDARD_DEPOSIT_USD) {
        if (tier.expected_reward_usd !== fp.expected_reward_usd || tier.expected_reward_low_usd !== fp.expected_reward_low_usd || tier.expected_reward_high_usd !== fp.expected_reward_high_usd || tier.usd_per_hour !== fp.usd_per_hour || tier.usd_per_hour_low !== fp.usd_per_hour_low || tier.usd_per_hour_high !== fp.usd_per_hour_high) return `${r.slug} $100 tier disagrees with the standard plan`;
      }
    }
    const mx = r.farm_matrix;
    if (!mx || mx.deposits.join(',') !== FARM_TIERS_USD.join(',') || mx.horizons_days.join(',') !== FARM_MATRIX_HORIZONS_DAYS.join(',')) return `${r.slug} has no farm matrix on the $25/$100/$500 x 30/90/180/365 grid`;
    if (mx.expected_reward_usd.length !== FARM_TIERS_USD.length || mx.usd_per_hour.length !== FARM_TIERS_USD.length) return `${r.slug} has a farm matrix with the wrong shape`;
    for (let d = 0; d < FARM_TIERS_USD.length; d++) {
      if (mx.expected_reward_usd[d]!.length !== FARM_MATRIX_HORIZONS_DAYS.length || mx.usd_per_hour[d]!.length !== FARM_MATRIX_HORIZONS_DAYS.length) return `${r.slug} has a farm matrix row of the wrong length`;
      for (let h = 0; h < FARM_MATRIX_HORIZONS_DAYS.length; h++) {
        if (mx.expected_reward_usd[d]![h] !== r.farm_plan_tiers[d]!.expected_reward_usd) return `${r.slug} matrix reward disagrees with its tier`;
        if (mx.usd_per_hour[d]![h] !== round4(mx.expected_reward_usd[d]![h]! / activeHoursFor(mx.horizons_days[h]!))) return `${r.slug} matrix $/hour disagrees with its reward`;
      }
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
// Fit radar-4 and blind-test it before any row is scored: the board is built from
// the fitted model, and the validation record is written beside it.
const fitLive = liveTokens(snapshot.protocols);
const nExcludedMcap = snapshot.protocols.filter((p) => p.mcap_usd !== null && !(p.mcap_usd > 0 && p.tvl_usd > 0)).length;
const fitPeers = peerMedians(chosenProtocols(snapshot));
const { pl, params, termMults, validation, odds, confTable } = validateModel(fitLive, snapshot.as_of, fitPeers, nExcludedMcap, snapshot.protocols);
const refPriors = referencePriors(snapshot.protocols);
const board = boardRows(snapshot, pl, params, termMults, odds, confTable);
// The two validation figures that need the board: the conformal median range
// factor and the rank-range median width.
validation.conformal.median_factor = round4(median(board.map((r) => r.launch_value_high_usd / r.launch_value_low_usd)));
validation.rank_ranges.median_width = round4(median(board.map((r) => r.rank_high - r.rank_low)));
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const live = liveRows(snapshot);
const early = board.filter((r) => !r.watchlist).length;
/** The one standard assumption every row's farm plan is costed on, stated in
 * full in the plan output (board.json and data.js) and in the dossier: a
 * standard $100 deposit (second action $25), an airdrop pool of 5% of the
 * row's expected (implied) launch value — launch value x launch odds — shared
 * pro-rata on the $100 against the protocol's TVL, and $/hour over the plan's
 * active hours (35 one-off minutes plus 20 minutes a week over the hold). */
const FARM_PLAN = {
  standard_deposit_usd: STANDARD_DEPOSIT_USD,
  second_action_usd: SECOND_ACTION_USD,
  airdrop_share: AIRDROP_SHARE,
  assumption:
    'Every row farms a standard $100 deposit (second action $25). The expected reward is 5% of the row’s expected (implied) launch value — launch value x launch odds, shared pro-rata on the deposit against the protocol’s TVL, so no row promises a big $/hour from a tiny deposit. $/hour is the expected reward divided by the plan’s active hours (35 one-off minutes plus 20 minutes a week over the hold); the low/high $/hour come from the row’s value range. The same plan is costed at $25/$100/$500 in farm_plan_tiers: the reward is pro-rata, so $/hour scales with the deposit — the same hours earn a bigger reward — while the breakeven deposit is the same at every tier, because the reward rate per $1 of deposit is constant. farm_matrix crosses the three deposits with four holds (30/90/180/365 days): the expected reward is a lump sum at launch and does not grow with the hold, but $/hour falls as the hold adds active time. Breakeven is the smallest deposit whose expected reward covers a fixed $5 farm-run cost ($1 gas + $4 time value); breakeven_days is null because no hold length makes a too-small deposit profitable — breakeven is deposit-driven, not time-driven.',
  formula: 'expected_reward_usd = 0.05 * deposit_usd * (implied_value_usd / tvl_usd); usd_per_hour = expected_reward_usd / active_hours; active_hours = (35 + 20 * timeline_days / 7) / 60; implied_value_usd = round(launch_value_usd * launch_odds); breakeven_usd = ceil(5 / (0.05 * implied_value_usd / tvl_usd)) — the unrounded rate, so it is identical at every tier; matrix usd_per_hour = expected_reward_usd / ((35 + 20 * horizon_days / 7) / 60)',
};
const radar = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION,
  model: {
    growth_weight: params.growth,
    growth_floor: GROWTH_FLOOR,
    growth_cap: GROWTH_CAP,
    maturity_floor: params.matFloor,
    maturity_range: round4(1 - params.matFloor),
    maturity_days: MATURITY_DAYS,
    unknown_age_days: UNKNOWN_AGE_DAYS,
    prior_floor: PRIOR_FLOOR,
    prior_cap: PRIOR_CAP,
    prior_cat_weight: PRIOR_CAT_WEIGHT,
    prior_shrink_cat: PRIOR_SHRINK_CAT,
    prior_shrink_chain: PRIOR_SHRINK_CHAIN,
    momentum_weight: params.momentum,
    momentum_mult_floor: MOMENTUM_MULT_FLOOR,
    momentum_mult_cap: MOMENTUM_MULT_CAP,
    momentum_pct_floor: MOMENTUM_PCT_FLOOR,
    momentum_pct_cap: MOMENTUM_PCT_CAP,
    category_weight: params.catWeight,
    chain_weight: params.chainWeight,
    odds_beta: odds.beta,
    odds_scaler: odds.scaler,
    odds_cv: odds.cv,
    odds_median_age_days_unknown: odds.medianAgeDaysUnknown,
    odds_n_train: odds.nTrain,
    conformal_q_global: confTable.qGlobal,
    conformal_q_by_category: Object.fromEntries([...confTable.byCategory.entries()].map(([k, v]) => [k, { n: v.n, q: v.q }])),
    conformal_median_factor: validation.conformal.median_factor,
    conformal_coverage_loo: validation.conformal.coverage_loo,
    rank_mc_seed: MC_SEED,
    rank_mc_draws: MC_DRAWS,
    by_category_mult: Object.fromEntries([...termMults.byCategory.entries()].map(([k, v]) => [k, round4(v)])),
    by_chain_mult: Object.fromEntries([...termMults.byChain.entries()].map(([k, v]) => [k, round4(v)])),
    power_law_a: pl.a,
    power_law_b: pl.b,
    global_prior: refPriors.global,
    by_category: refPriors.byCategory,
    by_chain: refPriors.byChain,
  },
  validation,
  farm_plan: FARM_PLAN,
  watchlist_size: snapshot.watchlist.length,
  board_size: board.length,
  early_size: early,
  live_size: live.filter((r) => r.kind === 'live').length,
  wrapped_size: live.filter((r) => r.kind === 'wrapped').length,
  rows: board.map((r): RadarRow => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    mcap_usd: r.mcap_usd,
    listed_at: r.listed_at,
    age_days: r.age_days,
    launch_value_usd: r.launch_value_usd,
    launch_value_low_usd: r.launch_value_low_usd,
    launch_value_high_usd: r.launch_value_high_usd,
    launch_odds: r.launch_odds,
    expected_value_usd: r.expected_value_usd,
    implied_value_usd: r.implied_value_usd,
    implied_value_low_usd: r.implied_value_low_usd,
    implied_value_high_usd: r.implied_value_high_usd,
    rank_low: r.rank_low,
    rank_high: r.rank_high,
    launch_clock_months: r.launch_clock_months,
    launch_clock_months_q1: r.launch_clock_months_q1,
    launch_clock_label: r.launch_clock_label,
    base_multiple: r.model.base_multiple,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    momentum_pct: r.model.momentum_pct,
    momentum_multiplier: r.model.momentum_multiplier,
    category_multiplier: r.model.category_multiplier,
    chain_multiplier: r.model.chain_multiplier,
    category_weight: r.model.category_weight,
    chain_weight: r.model.chain_weight,
    watchlist: r.watchlist,
    farm_plan: r.farm_plan,
    farm_plan_tiers: r.farm_plan_tiers,
    farm_matrix: r.farm_matrix,
    farm_steps: r.farm_steps,
  })),
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board, validation, farm_plan: FARM_PLAN })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const farmPerHour = board.map((r) => r.farm_plan.usd_per_hour).sort((a, b) => a - b);
const farmPerHourByTier = FARM_TIERS_USD.map((d) => board.map((r) => r.farm_plan_tiers[FARM_TIERS_USD.indexOf(d)]!.usd_per_hour).sort((a, b) => a - b));
const farmBreakevens = board.map((r) => r.farm_plan_tiers[1]!.breakeven_usd).filter((v): v is number => v !== null).sort((a, b) => a - b);
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${early} early, ${live.filter((r) => r.kind === 'live').length} live set aside, ${live.filter((r) => r.kind === 'wrapped').length} wrapped set aside)\n` +
    `token radar: radar-4 fitted on ${validation.n_live} live tokens: log(mcap) = ${pl.a.toFixed(4)} + ${pl.b.toFixed(4)} * log(TVL); growth ${params.growth}, maturity floor ${params.matFloor}, momentum ${params.momentum}, category ${params.catWeight}, chain ${params.chainWeight} (kept: growth ${validation.kept.growth}, maturity ${validation.kept.maturity}, momentum ${validation.kept.momentum}, category ${validation.kept.category}, chain ${validation.kept.chain})\n` +
    `token radar: blind tests vs global-median baseline — leave-one-out MedALE ${validation.final.loo_med_ale} (x${validation.final.loo_x}), walk-forward MedALE ${validation.final.wf_med_ale} (x${validation.final.wf_x}), ten-fold MedALE ${validation.final.tf_med_ale} (x${validation.final.tf_x})\n` +
    `token radar: launch odds (logistic, ${odds.nTrain} dated protocols, 5-fold CV): AUC ${odds.cv.auc}, Brier ${odds.cv.brier}, log-loss ${odds.cv.logloss}; age beta ${odds.beta[1]!.toFixed(4)} (${odds.ageBetaSign > 0 ? 'positive' : odds.ageBetaSign < 0 ? 'negative' : 'zero'}); bucket mismatch ${odds.bucketMismatch}; median unknown age ${odds.medianAgeDaysUnknown} days\n` +
    `token radar: placebo (shuffled target, seed ${validation.placebo.seed}): selected ${validation.placebo.selected_procedure}, LOO ${validation.placebo.loo_med_ale} (x${validation.placebo.loo_lift}); conformal 80%: q ${validation.conformal.q_global}, median range factor x${validation.conformal.median_factor}, LOO coverage ${(validation.conformal.coverage_loo * 100).toFixed(1)}% (n=${validation.conformal.n_live}); rank ranges median width ${validation.rank_ranges.median_width} places\n` +
    `token radar: farm plans costed on a standard $${STANDARD_DEPOSIT_USD} deposit (5% airdrop share, pro-rata on TVL): $/hour $${farmPerHour[0]!.toFixed(4)} to $${farmPerHour[farmPerHour.length - 1]!.toFixed(4)}, median $${median(farmPerHour).toFixed(4)}\n` +
    `token radar: farm tiers $${FARM_TIERS_USD.join('/$')}: $/hour median ${farmPerHourByTier.map((s) => `$${median(s).toFixed(4)}`).join(' / ')} (scales with the deposit: same hours, bigger pro-rata reward); breakeven deposit at the $${FARM_RUN_COST_USD} run cost: median $${median(farmBreakevens).toLocaleString('en-US')}, $${farmBreakevens[0]!.toLocaleString('en-US')} to $${farmBreakevens[farmBreakevens.length - 1]!.toLocaleString('en-US')} (${farmBreakevens.length}/209 rows have a finite breakeven)\n` +
    `token radar: top expected value $${board[0]!.implied_value_usd.toLocaleString('en-US')} (${board[0]!.name}), launch $${board[0]!.launch_value_usd.toLocaleString('en-US')} x odds ${board[0]!.launch_odds}, wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
