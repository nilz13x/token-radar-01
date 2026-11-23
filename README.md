# Token Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun rank](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![make.fun reward](https://make.fun/badge/token-radar-01/nilz13x/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a frozen DefiLlama snapshot of 758 protocols, ranks the
pre-token ones by what their launch would be worth, and hands in a web dashboard with
the board, a detail view for each protocol, and the steps to farm it.

## The model (radar-2.1)

Implied value is not a house constant. The base multiple is the median
market-cap-to-TVL ratio of the live-token protocols in the same category, blended with
the same median on the protocol's first chain — both read from the snapshot itself,
each shrunk toward the global median so a thin category earns its distance only with
comparables behind it — clamped to [0.10, 0.55]. Seven-day growth, momentum against
its category peers, and age with no token then move it:

```
implied = round(tvl_usd × base × (1 + clamp(change_7d, -60, 120) / 100 × 0.5)
                × clamp(1 + clamp(change_7d - peer_median_7d, -60, 120) / 100 × 0.25, 0.90, 1.20)
                × (0.6 + min(age_days, 1095) / 1095 × 0.4))
```

Momentum is the protocol's 7-day change minus its category peers' median change; a
protocol with no reported change is momentum-neutral (×1).

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
