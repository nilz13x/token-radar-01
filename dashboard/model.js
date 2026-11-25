// RadarModel — the ONE scoring model main.ts and this dashboard share.
// main.ts imports it; the page loads it as a plain <script> and recomputes
// every row with it. Fitting stays in main.ts.
var RadarModel = (function () {
  'use strict';
  var GF = -60, GC = 120, MD = 1095, UA = 365, PF = 0.01, PC = 5;
  var OC_LO = 0.01, OC_HI = 0.95, OC_H = 365;
  var MOM_FLOOR = 0.9, MOM_CAP = 1.2, MOM_PF = -60, MOM_PC = 120;
  var SD = 100, SA = 25, AS = 0.05, RC = 5;
  var TIERS = [25, 100, 500], HORIZONS = [30, 90, 180, 365];
  function r4(n) { return Math.round(n * 1e4) / 1e4; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function ageDays(asOf, listedAt) { // whole days to the snapshot date; null unknown
    if (listedAt == null) return null;
    var a = Date.parse(asOf + 'T00:00:00Z'), b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / 86400000));
  }
  function growthPct(c) { return clamp(typeof c === 'number' && isFinite(c) ? c : 0, GF, GC); }
  function baseMultiple(tvl, a, b) { return r4(clamp(Math.exp(a) * Math.pow(tvl, b - 1), PF, PC)); }
  function growthMult(gp, w) { return r4(1 + (gp / 100) * w); }
  function maturityMult(age, floor) {
    var a = age == null ? UA : age;
    return r4(floor + (Math.min(Math.max(a, 0), MD) / MD) * (1 - floor));
  }
  function momentumMult(mp, w) {
    if (mp == null) return 1;
    return r4(clamp(1 + (mp / 100) * w, MOM_FLOOR, MOM_CAP));
  }
  function powMult(m, w) { return r4(Math.pow(m, w)); } // weight 0 drops the term
  function launchValue(tvl, base, gm, mm, mo, cm, hm) {
    return Math.max(1, Math.round(tvl * base * gm * mm * mo * cm * hm));
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function oddsPredict(beta, scaler, x) { // P(has token) under the fitted logistic
    var z0 = (x[0] - scaler.means[0]) / scaler.sds[0];
    var z1 = (x[1] - scaler.means[1]) / scaler.sds[1];
    var z2 = (x[2] - scaler.means[2]) / scaler.sds[2];
    return sigmoid(beta[0] + beta[1] * z0 + beta[2] * z1 + beta[3] * z2);
  }
  function pHasAt(beta, scaler, ageX, tvl, c) {
    return oddsPredict(beta, scaler, [ageX / 365, Math.log10(tvl), growthPct(c) / 100]);
  }
  // P(launch within 12 months) from the cross-sectional launch CDF.
  // Unknown age takes the median age of the dated pre-token protocols.
  function launchOdds(beta, scaler, age, tvl, c, medUnknown) {
    var a = age == null ? medUnknown : age;
    var p0 = pHasAt(beta, scaler, a, tvl, c);
    var p1 = pHasAt(beta, scaler, a + OC_H, tvl, c);
    return clamp((p1 - p0) / Math.max(1e-9, 1 - p0), OC_LO, OC_HI);
  }
  // Months to launch: first month whose cumulative launch probability reaches
  // 25% (q1) and 50% (median), out to 60 months.
  function launchClock(beta, scaler, age, tvl, c, medUnknown) {
    var a = age == null ? medUnknown : age;
    var s0 = 1 - pHasAt(beta, scaler, a, tvl, c);
    var months = null, q1 = null;
    if (s0 <= 1e-9) { months = 1; q1 = 1; } else {
      for (var t = 1; t <= 60; t++) {
        var pt = 1 - (1 - pHasAt(beta, scaler, a + 30.44 * t, tvl, c)) / s0;
        if (q1 == null && pt >= 0.25) q1 = t;
        if (months == null && pt >= 0.5) { months = t; break; }
      }
    }
    var label = months == null ? '>5y' : months < 6 ? 'under 6m' : months <= 12 ? '6-12m' : months <= 24 ? '1-2y' : months <= 36 ? '2-3y' : '3-5y';
    return { months: months, q1: q1, label: label };
  }
  // A row's conformal half-width in log space: its category's 80% LOO quantile
  // shrunk toward the global one (k=3). byCat is a Map (main.ts) or a plain
  // object (data.js) of {n, q}; a missing category takes the global spread.
  function confHalfWidth(cat, qGlobal, byCat) {
    var e = null;
    if (byCat) e = typeof byCat.get === 'function' ? byCat.get(cat || 'Other') : byCat[cat || 'Other'];
    var n = e ? e.n : 0, q = e ? e.q : qGlobal;
    return (n * q + 3 * qGlobal) / (n + 3);
  }
  function launchRange(launch, q) { // conformal 80% launch range
    return { low: Math.min(launch, Math.max(1, Math.round(launch * Math.exp(-q)))), high: Math.max(launch, Math.round(launch * Math.exp(q))) };
  }
  function activeHours(days) { return r4((35 + 20 * days / 7) / 60); } // 35 one-off min + 20/week
  function holdDays(age) { if (age == null) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30; }
  function farmReward(dep, implied, tvl) { return r4(AS * dep * (implied / tvl)); } // pro-rata share of 5%
  function usdPerHour(reward, hours) { return r4(reward / hours); }
  // Smallest whole-dollar deposit whose expected reward covers the $5 run cost,
  // from the UNROUNDED rate — so it is identical at every tier.
  function breakevenUsd(implied, tvl) {
    var rate = AS * (implied / tvl);
    return rate > 0 ? Math.ceil(RC / rate) : null;
  }
  return {
    r4, ageDays, growthPct, baseMultiple, growthMult, maturityMult, momentumMult,
    powMult, launchValue, oddsPredict, pHasAt, launchOdds, launchClock,
    confHalfWidth, launchRange, activeHours, holdDays, farmReward, usdPerHour,
    breakevenUsd,
    GROWTH_FLOOR: GF, GROWTH_CAP: GC, MATURITY_DAYS: MD, UNKNOWN_AGE_DAYS: UA,
    PRIOR_FLOOR: PF, PRIOR_CAP: PC, ODDS_CLIP_LO: OC_LO, ODDS_CLIP_HI: OC_HI,
    ODDS_HORIZON_DAYS: OC_H, STANDARD_DEPOSIT: SD, SECOND_ACTION: SA,
    AIRDROP_SHARE: AS, FARM_RUN_COST: RC, TIERS, HORIZONS
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RadarModel;
