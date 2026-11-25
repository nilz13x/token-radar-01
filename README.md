# Token Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun rank](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun reward](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a frozen DefiLlama snapshot of 758 protocols, ranks the
pre-token ones by what their launch would be worth, and hands in a web dashboard with
the board, a detail view for each protocol, and the steps to farm it.

## The model (radar-3)

Implied value is fitted, not assumed. The base multiple comes from a power
law fitted on the live-token protocols in this very snapshot — log(market
cap) = 6.4097 + 0.5554 · log(TVL), fitted robustly (Theil-Sen) on the 128
live tokens with a positive market cap and TVL — so a bigger protocol earns
a lower multiple and a smaller one a higher one. Every other value term
(growth, age, momentum against category peers) was fitted on the same live
tokens and then kept or dropped on two blind tests: leave-one-out (MedALE
1.2524, ×1.2961 against the global-median baseline) and walk-forward
(MedALE 1.0011, ×1.6646; fitted on the older 47 dated tokens, tested on
the newer 48). The blind tests dropped growth and momentum, so the board
ranks on the power law plus a maturity term; 36 of the 128 held-out tokens
land within 2× of their true market cap, 58 within 3×.

Each row carries its value range (low–high) from the leave-one-out
residuals, wider where the category has few live comparables. Every board
row also has a fully costed farm plan on a standard $100 deposit (second
action $25): the expected reward is 5% of the row's implied launch value
shared pro-rata on the $100 against the protocol's TVL, and $/hour is that
reward over the plan's active hours (35 one-off minutes plus 20 minutes a
week over the hold); the low/high $/hour come from the row's value range.

All 758 protocols in the snapshot are accounted for: 209 board rows, 129
live tokens set aside, 133 wrapped/staked/bridged products set aside, and
287 pre-token protocols with a listing but no market cap.

Wrapped, staked and bridged products are set aside with the live-token protocols: they
are another token's product, not a launch of their own. No protocol name is
special-cased. The dashboard re-ranks live in its model sandbox, and its detail view
recomputes each row from the same figures board.json carries.

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
