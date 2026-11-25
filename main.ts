// Token Radar, model radar-3: a pre-token protocol is worth what the market already
// pays for the same kind of protocol — fitted, not assumed. The base multiple comes
// from a power law fitted on the live-token protocols in this very snapshot:
// log(market cap) = a + b * log(TVL), fitted robustly (Theil-Sen) on the 128 live
// tokens with a positive market cap and TVL, so a bigger protocol earns a lower
// multiple and a smaller one a higher one. Every other value term — growth, age
// (maturity), momentum against category peers — is fitted on the same live tokens
// and then kept or dropped on two blind tests run inside this program: leave-one-out
// (refit on 127, predict the held-out token) and walk-forward (fit on the older half
// of the dated live tokens, test on the newer half). Terms are added greedily from
// the power law alone: a term joins when it improves both blind tests, or when the
// tests split but the improvement on one exceeds the worsening on the other (a wash)
// and the term was in radar-2.1 — continuity wins a wash, never a clear loss. The
// fitted numbers and the blind-test scores are written to board.json and data.js
// under `validation`, and every board row carries its value range (low-high) from
// the leave-one-out residuals, wider where the category has few live comparables. Wrapped, staked and bridged products are set
// aside with the live tokens: they are another token's product, not a launch of
// their own. A versioned deployment (V2, v3) is still a launch of its own, so it
// ranks. No protocol name is special-cased.
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

export const MODEL_VERSION = 'radar-3';
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;
// Safety rails for the fitted power-law multiple only. On this snapshot the board's
// multiples run 0.039 to 0.638, so the rails never bind; they exist so a fitted law
// can never hand a row an absurd multiple.
const PRIOR_FLOOR = 0.01;
const PRIOR_CAP = 5;
// Grids the blind tests fit the adjustment terms on. A term's grid always contains
// its neutral value (growth 0, maturity floor 1, momentum 0), so the fit can drop
// a term outright when it does not help.
const GROWTH_GRID = [0, 0.3, 0.5, 0.7];
const MAT_FLOOR_GRID = [0.5, 0.6, 0.7, 1.0];
const MOMENTUM_GRID = [0, 0.15, 0.25, 0.35];
const MOMENTUM_MULT_FLOOR = 0.9;
const MOMENTUM_MULT_CAP = 1.2;
const MOMENTUM_PCT_FLOOR = -60;
const MOMENTUM_PCT_CAP = 120;
// The reference priors below (category / chain medians, radar-2.1's arithmetic) are
// no longer what the board ranks on — the power law is — but the dashboard's priors
// table still shows them, so they are still computed and written to data.js.
const PRIOR_CAT_WEIGHT = 0.75;
const MIN_CAT_N = 3;
const MIN_CHAIN_N = 5;
const PRIOR_SHRINK_CAT = 3;
const PRIOR_SHRINK_CHAIN = 4;
const RANGE_SHRINK_K = 3;
const RANGE_THIN_K = 2;
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

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const finite = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Whole days from `listedAt` to the snapshot date, clamped at zero; null when unknown. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

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
}

interface Features {
  base: number;
  growthPct: number;
  age: number | null;
  momentumPct: number | null;
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
 * multiple at this TVL, and the three adjustment inputs. The base multiple is the
 * same number the board stores per row, rounded the way the published model rounds
 * it, so publishedImplied recomputes it exactly. */
function features(p: Proto, asOf: string, pl: PowerLaw, peerMedian: number): Features {
  const base = round4(Math.min(PRIOR_CAP, Math.max(PRIOR_FLOOR, Math.exp(pl.a) * Math.pow(p.tvl_usd, pl.b - 1))));
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0)));
  const age = ageDays(asOf, p.listed_at);
  let momentumPct: number | null = null;
  if (p.change_7d !== null) momentumPct = round3(Math.min(MOMENTUM_PCT_CAP, Math.max(MOMENTUM_PCT_FLOOR, growthPct - peerMedian)));
  return { base, growthPct, age, momentumPct };
}

/** The three adjustment multipliers for one protocol's features under a parameter
 * set. A dropped term is neutral by construction: growth 0 gives 1, a maturity
 * floor of 1 gives 1, momentum 0 gives 1. */
function multipliers(f: Features, params: FittedParams): { growthMult: number; maturityMult: number; momentumMult: number } {
  const growthMult = round4(1 + (f.growthPct / 100) * params.growth);
  const ageForModel = f.age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = round4(params.matFloor + (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS) * (1 - params.matFloor));
  const momentumMult = f.momentumPct === null ? 1 : round4(Math.min(MOMENTUM_MULT_CAP, Math.max(MOMENTUM_MULT_FLOOR, 1 + (f.momentumPct / 100) * params.momentum)));
  return { growthMult, maturityMult, momentumMult };
}

/** The implied value of one protocol's features under a parameter set — the same
 * arithmetic publishedImplied recomputes from the stored multipliers. */
function impliedFromFeatures(p: Proto, f: Features, params: FittedParams): number {
  const { growthMult, maturityMult, momentumMult } = multipliers(f, params);
  return Math.max(1, Math.round(p.tvl_usd * f.base * growthMult * maturityMult * momentumMult));
}

/** Median absolute log error: the median of |log(predicted / actual)| over a set of
 * predictions. Log space, so a token predicted at twice its market cap counts the
 * same as one predicted at half it, and the wild ratios cannot dominate the score. */
function medALE(preds: { pred: number; actual: number }[]): number {
  return median(preds.map(({ pred, actual }) => Math.abs(Math.log(pred / actual))));
}

interface Procedure {
  growth: boolean;
  maturity: boolean;
  momentum: boolean;
}

type Peers = { byCategory: Record<string, number>; global: number };

function peerOf(p: Proto, peers: Peers): number {
  return peers.byCategory[p.category ?? 'Other'] ?? peers.global;
}

/** Grid-fit the active terms of a procedure on a training set, minimising the median
 * absolute log error of the predicted market caps. A term that is not active stays
 * neutral. First strictly-better wins ties, so the choice is deterministic. */
function fitProcedure(train: Proto[], asOf: string, pl: PowerLaw, peers: Peers, proc: Procedure): FittedParams {
  const feats = train.map((p) => ({ p, f: features(p, asOf, pl, peerOf(p, peers)) }));
  const gGrid = proc.growth ? GROWTH_GRID : [0];
  const fGrid = proc.maturity ? MAT_FLOOR_GRID : [1.0];
  const wGrid = proc.momentum ? MOMENTUM_GRID : [0];
  let best: FittedParams & { err: number } | null = null;
  for (const growth of gGrid) {
    for (const matFloor of fGrid) {
      for (const momentum of wGrid) {
        const params = { growth, matFloor, momentum };
        const err = medALE(feats.map(({ p, f }) => ({ pred: impliedFromFeatures(p, f, params), actual: p.mcap_usd! })));
        if (best === null || err < best.err) best = { ...params, err };
      }
    }
  }
  return { growth: best!.growth, matFloor: best!.matFloor, momentum: best!.momentum };
}

const PROCEDURES: Record<string, Procedure> = {
  powerOnly: { growth: false, maturity: false, momentum: false },
  growthOnly: { growth: true, maturity: false, momentum: false },
  maturityOnly: { growth: false, maturity: true, momentum: false },
  momentumOnly: { growth: false, maturity: false, momentum: true },
  growthMaturity: { growth: true, maturity: true, momentum: false },
  growthMomentum: { growth: true, maturity: false, momentum: true },
  maturityMomentum: { growth: false, maturity: true, momentum: true },
  full: { growth: true, maturity: true, momentum: true },
};

const PROC_NAMES = Object.keys(PROCEDURES);

function procKey(p: Procedure): string {
  return PROC_NAMES.find((k) => {
    const q = PROCEDURES[k]!;
    return q.growth === p.growth && q.maturity === p.maturity && q.momentum === p.momentum;
  })!;
}

/** Greedy forward selection over the three adjustment terms, starting from the power
 * law alone. A term is added when it improves BOTH blind tests, or when the tests
 * split but the improvement on one exceeds the worsening on the other (a wash) and
 * the term was in radar-2.1 — continuity wins a wash; it never wins a clear loss.
 * Among addable terms, the largest mean improvement goes first. The final model is
 * one of the eight evaluated procedures, so its blind-test numbers are the ones
 * reported — nothing is refit after selection. */
function selectProcedure(looMed: Record<string, number>, wfErr: Record<string, number>): { proc: Procedure; name: string } {
  const inPrevModel = { growth: true, maturity: true, momentum: true }; // radar-2.1 had all three
  let current: Procedure = { growth: false, maturity: false, momentum: false };
  const terms = ['growth', 'maturity', 'momentum'] as const;
  for (;;) {
    let best: { term: (typeof terms)[number]; meanGain: number } | null = null;
    for (const term of terms) {
      if (current[term]) continue;
      const next = { ...current, [term]: true };
      const ck = procKey(current);
      const nk = procKey(next);
      const looGain = (looMed[ck]! - looMed[nk]!) / looMed[ck]!;
      const wfGain = (wfErr[ck]! - wfErr[nk]!) / wfErr[ck]!;
      const improvesBoth = looGain > 0 && wfGain > 0;
      const wash =
        (looGain > 0.02 && wfGain < 0 && -wfGain <= looGain) ||
        (wfGain > 0.02 && looGain < 0 && -looGain <= wfGain);
      if (!improvesBoth && !(wash && inPrevModel[term])) continue;
      const meanGain = (looGain + wfGain) / 2;
      if (best === null || meanGain > best.meanGain) best = { term, meanGain };
    }
    if (best === null) break;
    current = { ...current, [best.term]: true };
  }
  return { proc: current, name: procKey(current) };
}

/** Leave-one-out for several procedures at once: for each held-out live token, refit
 * everything (power law + each procedure's active terms) on the other 127 and predict
 * the held-out token. The held-out token never touches its own fit — not the power
 * law, not the grid. The power-law fit is shared across procedures within a fold. */
function looAll(live: Proto[], asOf: string, peers: Peers, procs: Record<string, Procedure>): Record<string, { slug: string; category: string; logErr: number }[]> {
  const out: Record<string, { slug: string; category: string; logErr: number }[]> = {};
  for (const k of Object.keys(procs)) out[k] = [];
  for (const held of live) {
    const train = live.filter((p) => p.slug !== held.slug);
    const pl = theilSen(train);
    const heldFeatures = features(held, asOf, pl, peerOf(held, peers));
    for (const [k, proc] of Object.entries(procs)) {
      const params = fitProcedure(train, asOf, pl, peers, proc);
      out[k]!.push({ slug: held.slug, category: held.category ?? 'Other', logErr: Math.log(impliedFromFeatures(held, heldFeatures, params) / held.mcap_usd!) });
    }
  }
  return out;
}

/** Walk-forward for several procedures at once: fit on the older half of the dated
 * live tokens, test on the newer half. Undated live tokens take no part — they cannot
 * be placed in time. */
function wfAll(live: Proto[], asOf: string, peers: Peers, procs: Record<string, Procedure>): Record<string, { trainN: number; testN: number; trainEnd: string; testStart: string; err: number }> {
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length / 2);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const pl = theilSen(train);
  const out: Record<string, { trainN: number; testN: number; trainEnd: string; testStart: string; err: number }> = {};
  for (const [k, proc] of Object.entries(procs)) {
    const params = fitProcedure(train, asOf, pl, peers, proc);
    const err = medALE(test.map((p) => ({ pred: impliedFromFeatures(p, features(p, asOf, pl, peerOf(p, peers)), params), actual: p.mcap_usd! })));
    out[k] = { trainN: train.length, testN: test.length, trainEnd: train[train.length - 1]!.listed_at!, testStart: test[0]!.listed_at!, err };
  }
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

interface Validation {
  n_live: number;
  n_live_excluded_mcap: number;
  n_dated: number;
  fitted: { a: number; b: number; growth: number; maturity_floor: number; momentum_weight: number };
  kept: { growth: boolean; maturity: boolean; momentum: boolean };
  ablation: Record<string, { loo_med_ale: number; wf_med_ale: number }>;
  baseline: { loo_med_ale: number; wf_med_ale: number };
  final: { loo_med_ale: number; wf_med_ale: number; loo_x: number; wf_x: number; within_2x: number; within_3x: number; median_log_err: number };
  walk_forward: { train_n: number; test_n: number; train_end: string; test_start: string };
  ranges: { global_mad: number };
}

/** Fit radar-3 and blind-test it. The three adjustment terms go through greedy
 * forward selection on the two blind tests (see selectProcedure); the final model is
 * then refit on all 128 live tokens, and its blind-test numbers are the ones already
 * measured for that procedure — nothing is refit after selection. Returns the fitted
 * power law, the final parameters, the validation record and the final model's
 * leave-one-out residuals, which calibrate the board's ranges. */
function validateModel(live: Proto[], asOf: string, peers: Peers, nExcludedMcap: number): {
  pl: PowerLaw;
  params: FittedParams;
  validation: Validation;
  looResiduals: { slug: string; category: string; logErr: number }[];
} {
  const loo = looAll(live, asOf, peers, PROCEDURES);
  const wf = wfAll(live, asOf, peers, PROCEDURES);
  const baseLOO = baselineLOO(live);
  const baseWF = baselineWF(live);
  const looMed: Record<string, number> = {};
  const wfErr: Record<string, number> = {};
  for (const k of PROC_NAMES) {
    looMed[k] = median(loo[k]!.map((e) => Math.abs(e.logErr)));
    wfErr[k] = wf[k]!.err;
  }
  const { proc: finalProc, name: finalName } = selectProcedure(looMed, wfErr);
  const pl = theilSen(live);
  const params = fitProcedure(live, asOf, pl, peers, finalProc);
  const finalLOO = loo[finalName]!;
  const finalWF = wf[finalName]!;
  const finalLOOMed = looMed[finalName]!;
  const ablation: Validation['ablation'] = {};
  for (const k of PROC_NAMES) ablation[k] = { loo_med_ale: round4(looMed[k]!), wf_med_ale: round4(wfErr[k]!) };
  const validation: Validation = {
    n_live: live.length,
    n_live_excluded_mcap: nExcludedMcap,
    n_dated: live.filter((p) => p.listed_at !== null).length,
    fitted: { a: pl.a, b: pl.b, growth: params.growth, maturity_floor: params.matFloor, momentum_weight: params.momentum },
    kept: { growth: finalProc.growth, maturity: finalProc.maturity, momentum: finalProc.momentum },
    ablation,
    baseline: { loo_med_ale: round4(baseLOO), wf_med_ale: round4(baseWF) },
    final: {
      loo_med_ale: round4(finalLOOMed),
      wf_med_ale: round4(finalWF.err),
      loo_x: round4(baseLOO / finalLOOMed),
      wf_x: round4(baseWF / finalWF.err),
      within_2x: finalLOO.filter((e) => Math.abs(e.logErr) < Math.log(2)).length,
      within_3x: finalLOO.filter((e) => Math.abs(e.logErr) < Math.log(3)).length,
      median_log_err: round4(median(finalLOO.map((e) => e.logErr))),
    },
    walk_forward: { train_n: finalWF.trainN, test_n: finalWF.testN, train_end: finalWF.trainEnd, test_start: finalWF.testStart },
    ranges: { global_mad: round4(median(finalLOO.map((e) => Math.abs(e.logErr)))) },
  };
  return { pl, params, validation, looResiduals: finalLOO };
}

interface RangeTable {
  globalMAD: number;
  byCategory: Map<string, { n: number; mad: number }>;
  catN: Map<string, number>;
}

/** The range calibration from the final model's leave-one-out residuals: the median
 * absolute log error overall, and per category, shrunk toward the global figure. A
 * category with no live tokens at all has no residual of its own and takes the
 * global spread. */
function rangeTable(looResiduals: { slug: string; category: string; logErr: number }[], live: Proto[]): RangeTable {
  const globalMAD = median(looResiduals.map((e) => Math.abs(e.logErr)));
  const groups = new Map<string, number[]>();
  for (const e of looResiduals) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category)!.push(Math.abs(e.logErr));
  }
  const byCategory = new Map<string, { n: number; mad: number }>();
  for (const [c, xs] of groups) byCategory.set(c, { n: xs.length, mad: median(xs) });
  const catN = new Map<string, number>();
  for (const p of live) {
    const c = p.category ?? 'Other';
    catN.set(c, (catN.get(c) ?? 0) + 1);
  }
  return { globalMAD, byCategory, catN };
}

/** The half-width of a row's value range, in log space. It starts from the
 * leave-one-out spread of the row's category (shrunk toward the global spread) and
 * widens where the category has few live comparables — a category with no live
 * token at all takes the widest range. A category needs at least three live tokens
 * before its own spread is trusted: with one or two, a single wild token would set
 * the whole category's range, so thinner categories take the global spread and the
 * thinness factor does the widening instead. Never below 0.2, so no row's range is
 * degenerate. */
function rangeHalfWidth(category: string | null, table: RangeTable): number {
  const c = category ?? 'Other';
  const n = table.catN.get(c) ?? 0;
  const madCat = n >= 3 ? (table.byCategory.get(c)?.mad ?? table.globalMAD) : table.globalMAD;
  const s = (n * madCat + RANGE_SHRINK_K * table.globalMAD) / (n + RANGE_SHRINK_K);
  return Math.max(0.2, 1.4826 * s * Math.sqrt(1 + RANGE_THIN_K / (n + 1)));
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
  implied: number;
}

/** One protocol's implied value under radar-3, from its own snapshot figures and
 * the fitted power law. The stored multipliers are the same ones impliedFromFeatures
 * uses, so the row's implied value is exactly what publishedImplied recomputes. */
function score(p: Proto, asOf: string, pl: PowerLaw, params: FittedParams, peerMedian: number): Scored {
  const f = features(p, asOf, pl, peerMedian);
  const { growthMult, maturityMult, momentumMult } = multipliers(f, params);
  const implied = Math.max(1, Math.round(p.tvl_usd * f.base * growthMult * maturityMult * momentumMult));
  return { p, age: f.age, base: f.base, growthPct: f.growthPct, growthMult, maturityMult, momentumPct: f.momentumPct, momentumMult, implied };
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
const STANDARD_DEPOSIT_USD = 100;
const SECOND_ACTION_USD = 25;
/** The share of a protocol's implied launch value assumed to go to the farming
 * cohort as an airdrop: 5% is the conservative end of the 5-10% a launch
 * typically allocates to its community. A farmer's share of that pool is
 * pro-rata on the standard deposit against the protocol's TVL, so a $100
 * deposit in a $1B-TVL protocol earns a far smaller share than the same $100
 * in a $10M-TVL one — and no row can ever promise a huge $/hour from a tiny
 * deposit. The largest $/hour on this board is bounded by 5% x $100 x the
 * largest multiple, divided by the shortest plan's active hours. */
const AIRDROP_SHARE = 0.05;

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

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
  const activeHours = round4((35 + (20 * hold) / 7) / 60);
  const rewardFor = (v: number): number => round4(AIRDROP_SHARE * STANDARD_DEPOSIT_USD * (v / p.tvl_usd));
  const rewardLow = rewardFor(low);
  const reward = rewardFor(implied);
  const rewardHigh = rewardFor(high);
  return {
    deposit_usd: STANDARD_DEPOSIT_USD,
    second_action_usd: SECOND_ACTION_USD,
    expected_reward_usd: reward,
    expected_reward_low_usd: rewardLow,
    expected_reward_high_usd: rewardHigh,
    usd_per_hour: round4(reward / activeHours),
    usd_per_hour_low: round4(rewardLow / activeHours),
    usd_per_hour_high: round4(rewardHigh / activeHours),
    timeline_days: hold,
    active_hours: activeHours,
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
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number; momentum_pct: number | null; momentum_multiplier: number; age_days: number | null };
  farm_plan: FarmPlan;
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
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  momentum_pct: number | null;
  momentum_multiplier: number;
  watchlist: boolean;
  farm_plan: FarmPlan;
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

function boardRows(snapshot: Snap, pl: PowerLaw, params: FittedParams, ranges: RangeTable): BoardRow[] {
  const chosen = chosenProtocols(snapshot);
  const peers = peerMedians(chosen);
  const scored = chosen
    .map((p) => score(p, snapshot.as_of, pl, params, peers.byCategory[p.category ?? 'Other'] ?? peers.global))
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    // The row's value range, symmetric in log space around the point estimate, from
    // the leave-one-out spread of its category — wider where the category has few
    // live comparables. The point estimate always sits inside its own range.
    const h = rangeHalfWidth(s.p.category, ranges);
    const low = Math.max(1, Math.round(s.implied * Math.exp(-h)));
    const high = Math.round(s.implied * Math.exp(h));
    const lowUsd = Math.min(low, s.implied);
    const highUsd = Math.max(high, s.implied);
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
      implied_value_usd: s.implied,
      implied_value_low_usd: lowUsd,
      implied_value_high_usd: highUsd,
      model: { base_multiple: s.base, growth_pct: s.growthPct, growth_multiplier: s.growthMult, maturity_multiplier: s.maturityMult, momentum_pct: s.momentumPct, momentum_multiplier: s.momentumMult, age_days: s.age },
      farm_plan: farmPlan(s.p, s.age, s.implied, lowUsd, highUsd),
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

/** Why a board is not one the gate will take, or null. */
function boardIssue(board: BoardRow[], snapshot: Snap): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100 to 4000`;
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
    const fp = r.farm_plan;
    if (fp.deposit_usd !== STANDARD_DEPOSIT_USD || fp.second_action_usd !== SECOND_ACTION_USD) return `${r.slug} does not farm the standard $${STANDARD_DEPOSIT_USD} deposit`;
    if (!(fp.expected_reward_usd >= 0) || !(fp.expected_reward_low_usd >= 0) || !(fp.expected_reward_high_usd >= 0)) return `${r.slug} has a negative expected farm reward`;
    if (fp.expected_reward_low_usd > fp.expected_reward_usd || fp.expected_reward_usd > fp.expected_reward_high_usd) return `${r.slug} has a farm reward range that does not hold its reward`;
    if (!(fp.usd_per_hour >= 0) || !(fp.usd_per_hour_low >= 0) || !(fp.usd_per_hour_high >= 0)) return `${r.slug} has a negative farm $/hour`;
    if (fp.usd_per_hour_low > fp.usd_per_hour || fp.usd_per_hour > fp.usd_per_hour_high) return `${r.slug} has a farm $/hour range that does not hold its $/hour`;
    if (fp.timeline_days <= 0 || !(fp.active_hours > 0)) return `${r.slug} has a farm timeline of ${fp.timeline_days} days and ${fp.active_hours} active hours`;
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
// Fit radar-3 and blind-test it before any row is scored: the board is built from
// the fitted model, and the validation record is written beside it.
const fitLive = liveTokens(snapshot.protocols);
const nExcludedMcap = snapshot.protocols.filter((p) => p.mcap_usd !== null && !(p.mcap_usd > 0 && p.tvl_usd > 0)).length;
const fitPeers = peerMedians(chosenProtocols(snapshot));
const { pl, params, validation, looResiduals } = validateModel(fitLive, snapshot.as_of, fitPeers, nExcludedMcap);
const ranges = rangeTable(looResiduals, fitLive);
const refPriors = referencePriors(snapshot.protocols);
const board = boardRows(snapshot, pl, params, ranges);
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
 * row's implied launch value shared pro-rata on the $100 against the
 * protocol's TVL, and $/hour over the plan's active hours (35 one-off
 * minutes plus 20 minutes a week over the hold). */
const FARM_PLAN = {
  standard_deposit_usd: STANDARD_DEPOSIT_USD,
  second_action_usd: SECOND_ACTION_USD,
  airdrop_share: AIRDROP_SHARE,
  assumption:
    'Every row farms a standard $100 deposit (second action $25). The expected reward is 5% of the row’s implied launch value, shared pro-rata on the $100 against the protocol’s TVL, so no row promises a big $/hour from a tiny deposit. $/hour is the expected reward divided by the plan’s active hours (35 one-off minutes plus 20 minutes a week over the hold); the low/high $/hour come from the row’s value range.',
  formula: 'expected_reward_usd = 0.05 * 100 * (implied_value_usd / tvl_usd); usd_per_hour = expected_reward_usd / active_hours; active_hours = (35 + 20 * timeline_days / 7) / 60',
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
    implied_value_usd: r.implied_value_usd,
    implied_value_low_usd: r.implied_value_low_usd,
    implied_value_high_usd: r.implied_value_high_usd,
    base_multiple: r.model.base_multiple,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    momentum_pct: r.model.momentum_pct,
    momentum_multiplier: r.model.momentum_multiplier,
    watchlist: r.watchlist,
    farm_plan: r.farm_plan,
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
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${early} early, ${live.filter((r) => r.kind === 'live').length} live set aside, ${live.filter((r) => r.kind === 'wrapped').length} wrapped set aside)\n` +
    `token radar: radar-3 fitted on ${validation.n_live} live tokens: log(mcap) = ${pl.a.toFixed(4)} + ${pl.b.toFixed(4)} * log(TVL); growth ${params.growth}, maturity floor ${params.matFloor}, momentum ${params.momentum} (kept: growth ${validation.kept.growth}, maturity ${validation.kept.maturity}, momentum ${validation.kept.momentum})\n` +
    `token radar: blind tests vs global-median baseline — leave-one-out MedALE ${validation.final.loo_med_ale} (x${validation.final.loo_x}), walk-forward MedALE ${validation.final.wf_med_ale} (x${validation.final.wf_x})\n` +
    `token radar: farm plans costed on a standard $${STANDARD_DEPOSIT_USD} deposit (5% airdrop share, pro-rata on TVL): $/hour $${farmPerHour[0]!.toFixed(4)} to $${farmPerHour[farmPerHour.length - 1]!.toFixed(4)}, median $${median(farmPerHour).toFixed(4)}\n` +
    `token radar: top implied $${board[0]!.implied_value_usd.toLocaleString('en-US')} (${board[0]!.name}), wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
