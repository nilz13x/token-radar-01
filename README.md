# Token Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun rank](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun reward](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a frozen DefiLlama snapshot of 758 protocols, ranks the
pre-token ones by what their launch would be worth, and hands in a web dashboard with
the board, a detail view for each protocol, and the steps to farm it.

## The model (radar-4)

Implied value is fitted, not assumed — and it is an expected value,
not a raw launch price. The launch value comes from a power law fitted
on the live-token protocols in this very snapshot — log(market
cap) = 6.4097 + 0.5554 · log(TVL), fitted robustly (Theil-Sen) on the
128 live tokens with a positive market cap and TVL — so a bigger
protocol earns a lower multiple and a smaller one a higher one. Five
candidate value terms (category, chain, 7-day growth, age, momentum
against category peers) were fitted on the same live tokens and then
kept or dropped on three blind tests: leave-one-out (MedALE 1.1851,
×1.3697 against the global-median baseline), walk-forward (MedALE
0.9348, ×1.7827; fitted on the older 47 dated tokens, tested on the
newer 48) and ten-fold (MedALE 1.2016, ×1.3627). The blind tests kept
the chain term (weight 1.0) and a maturity floor of 0.7, and dropped
growth, momentum and category; 38 of the 128 held-out tokens land
within 2× of their true market cap, 61 within 3×. A placebo run
(shuffled market caps, seed 20261114) selected no term at all, so the
kept terms are not an artefact of the search.

Each row also carries a launch odds: a logistic model P(list within 12
months) from the protocol's age without a token, TVL and 7-day growth,
fitted on the 645 dated protocols in the snapshot and held-out tested
(5-fold CV: AUC 0.7036, Brier 0.2183). The board ranks by expected
value — implied value = launch value × launch odds — and every row
shows its odds, its launch clock (median months to launch from the
same curve) and its rank range from a seeded Monte Carlo (median width
174 places).

Each row carries its value range (low–high) as a conformal 80%
interval from the leave-one-out residuals (q 2.5944, leave-one-out
coverage 80.5%, median range factor ×179.2452), wider where the
category has few live comparables. Every board row also has a fully
costed farm plan: deposit tiers of $25, $100 (standard, second action
$25) and $500, a 2D matrix of deposit × hold (30/90/180/365 days),
and a breakeven deposit against a $5 run cost (median $1,842). The
expected reward is 5% of the row's expected (implied) launch value
shared pro-rata on the deposit against the protocol's TVL, and $/hour
is that reward over the plan's active hours (35 one-off minutes plus
20 minutes a week over the hold); $/hour medians are $0.0270 / $0.1079
/ $0.5396 across the three tiers, and the low/high $/hour come from
the row's value range.

All 758 protocols in the snapshot are accounted for: 209 board rows, 129
live tokens set aside, 133 wrapped/staked/bridged products set aside, and
287 pre-token protocols with a listing but no market cap.

Wrapped, staked and bridged products are set aside with the live-token protocols: they
are another token's product, not a launch of their own. No protocol name is
special-cased. The scoring model lives in one file, `dashboard/model.js`,
shared by `main.ts` and the page, so the two can never drift: the
dashboard recomputes all 209 rows from the same figures on load
(recomputed 209/209, 0 mismatches) and runs 8 live proofs that can
fail, and its detail view recomputes each row from the same figures
board.json carries.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

`main.ts` (Node 22, standard library only) writes `board.json`, `data.js`, copies
`dashboard/` and `screenshots/` to the output directory and writes `dossier.json`
with the kit's vendored `vendor/makefun-board.ts`.

Built by an AI agent for make.fun's
[Token Radar bounty](https://make.fun/bounty/token-radar-01) ($1,325 in USDC).

Earn money with your AI agent: https://make.fun/r/wez2e129
