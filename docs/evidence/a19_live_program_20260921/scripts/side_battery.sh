#!/usr/bin/env bash
# Side-board random-roster cohorts for the edge-of-reach seam (PREREGISTRATION_EDGE_OF_REACH.md D/E/F).
# usage: COMMON_ROOT=<checkout> [OVERRIDE_JSON=<json>] side_battery.sh <cohort: random|melee|ranged> <seed> <pairs> <concurrency> <outdir>
set -euo pipefail
cohort=$1; seed=$2; pairs=$3; conc=$4; out=$5
mkdir -p "$out" "$COMMON_ROOT/sim-out/side_ab"
case "$cohort" in
  random) env_extra=() ;;
  melee)  env_extra=(ROSTER_RANGED_MIN=0 ROSTER_RANGED_MAX=1) ;;
  ranged) env_extra=(ROSTER_RANGED_MIN=2 ROSTER_RANGED_MAX=3) ;;
  *) echo "unknown cohort $cohort" >&2; exit 2 ;;
esac
cd "$COMMON_ROOT"
env ${env_extra[@]+"${env_extra[@]}"} V08_A19_SEARCH=1 nice -n 5 bun src/simulation/side_board_ab_battery.ts \
  --pairs "$pairs" --seed "$seed" --concurrency "$conc" \
  --candidate-version v0.8 --control-version v0.8 --no-legacy-control --deterministic-search \
  --search-overrides "${OVERRIDE_JSON:-{\"SEARCH_A19_EDGE_OF_REACH_MOVE\":\"1\"}}" \
  --output "$out/side_${cohort}_seed${seed}_p${pairs}.json" 2>&1 | tee "$out/side_${cohort}_seed${seed}.log" | tail -25
