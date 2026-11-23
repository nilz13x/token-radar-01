// Token Radar, model radar-2: a pre-token protocol is worth what the market already
// pays for the same kind of protocol. The base multiple is not a house constant: it is
// the median market-cap-to-TVL ratio of the live-token protocols in the same category,
// blended with the same median on the protocol's first chain, both read from this very
// snapshot, clamped to [0.10, 0.55]. Growth and age then move it the way the rules state.
// Wrapped, staked and bridged products are set aside with the live tokens: they are
// another token's product, not a launch of their own. No protocol name is special-cased.
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

export const MODEL_VERSION = 'radar-2';
const GROWTH_WEIGHT = 0.5;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const MATURITY_FLOOR = 0.6;
const MATURITY_RANGE = 0.4;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;
const PRIOR_FLOOR = 0.1;
const PRIOR_CAP = 0.55;
const PRIOR_CAT_WEIGHT = 0.75;
const MIN_CAT_N = 3;
const MIN_CHAIN_N = 5;
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

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
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

/** A protocol the board may rank: pre-token, and no wrapped product, version or exchange. */
function isRankable(p: Proto): boolean {
  return isPreToken(p) && !isWrappedProduct(p) && !VERSIONED.test(p.name);
}

interface Priors {
  global: number;
  byCategory: Record<string, { n: number; median: number }>;
  byChain: Record<string, { n: number; median: number }>;
}

/** The comparables: live-token medians per category and per first chain, from this snapshot.
 * A comparable needs a real market cap: a token that records mcap 0 (or a rounding
 * artifact below it) is not a price the market paid, so it is left out. */
function computePriors(protocols: Proto[]): Priors {
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
  for (const [c, xs] of catGroups) byCategory[c] = { n: xs.length, median: round3(median(xs)) };
  for (const [c, xs] of chainGroups) byChain[c] = { n: xs.length, median: round3(median(xs)) };
  return { global: round3(global), byCategory, byChain };
}

/** The blended base multiple for one protocol, from the snapshot's own live medians. */
function baseMultiple(p: Proto, priors: Priors): number {
  const cat = priors.byCategory[p.category ?? 'Other'];
  const catPrior = cat !== undefined && cat.n >= MIN_CAT_N ? cat.median : priors.global;
  let chainPrior = priors.global;
  if (p.chains.length > 0) {
    const ch = priors.byChain[p.chains[0]!];
    if (ch !== undefined && ch.n >= MIN_CHAIN_N) chainPrior = ch.median;
  }
  const blended = PRIOR_CAT_WEIGHT * catPrior + (1 - PRIOR_CAT_WEIGHT) * chainPrior;
  return round4(Math.min(PRIOR_CAP, Math.max(PRIOR_FLOOR, blended)));
}

interface Scored {
  p: Proto;
  age: number | null;
  base: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  implied: number;
}

/** One protocol's implied value under radar-2, from its own snapshot figures. */
function score(p: Proto, asOf: string, priors: Priors): Scored {
  const age = ageDays(asOf, p.listed_at);
  const base = baseMultiple(p, priors);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0)));
  const growthMult = round4(1 + (growthPct / 100) * GROWTH_WEIGHT);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = round4(MATURITY_FLOOR + (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE);
  const implied = Math.max(1, Math.round(p.tvl_usd * base * growthMult * maturityMult));
  return { p, age, base, growthPct, growthMult, maturityMult, implied };
}

function chainOf(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

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

/** A protocol's farm plan: seven steps, each an action with its cost and time. */
function farmSteps(p: Proto, age: number | null): Step[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
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
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number; age_days: number | null };
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
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  watchlist: boolean;
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

function boardRows(snapshot: Snap, priors: Priors): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar is every rankable protocol the watchlist leaves out, not a TVL cut:
  // the watchlist is a floor, and a small protocol below it is the radar's whole point.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()]
    .map((p) => score(p, snapshot.as_of, priors))
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
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
    model: { base_multiple: s.base, growth_pct: s.growthPct, growth_multiplier: s.growthMult, maturity_multiplier: s.maturityMult, age_days: s.age },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
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
const priors = computePriors(snapshot.protocols);
const board = boardRows(snapshot, priors);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const live = liveRows(snapshot);
const early = board.filter((r) => !r.watchlist).length;
const radar = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION,
  model: {
    growth_weight: GROWTH_WEIGHT,
    growth_floor: GROWTH_FLOOR,
    growth_cap: GROWTH_CAP,
    maturity_floor: MATURITY_FLOOR,
    maturity_range: MATURITY_RANGE,
    maturity_days: MATURITY_DAYS,
    unknown_age_days: UNKNOWN_AGE_DAYS,
    prior_floor: PRIOR_FLOOR,
    prior_cap: PRIOR_CAP,
    prior_cat_weight: PRIOR_CAT_WEIGHT,
    global_prior: priors.global,
    by_category: priors.byCategory,
    by_chain: priors.byChain,
  },
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
    base_multiple: r.model.base_multiple,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    watchlist: r.watchlist,
  })),
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
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

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${early} early, ${live.filter((r) => r.kind === 'live').length} live set aside, ${live.filter((r) => r.kind === 'wrapped').length} wrapped set aside)\n` +
    `token radar: top implied $${board[0]!.implied_value_usd.toLocaleString('en-US')} (${board[0]!.name}), wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
