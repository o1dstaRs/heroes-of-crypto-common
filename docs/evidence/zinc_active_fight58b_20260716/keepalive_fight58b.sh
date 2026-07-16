#!/bin/bash
# Overnight 58-dim fight CEM (Rapid Charge w56 + ranged-target w57), mean read from a FILE (robust, no heredoc
# quoting). Seeded from BESTMIX+[0,0], deployment mix. Searches the combined feature set vs BESTMIX baseline.
cd ~/hoc-common || exit 1
ST=~/hoc-common/rl_state; mkdir -p "$ST"
MEAN=$(cat "$ST/mean58.json")
i=0
while true; do
  i=$((i+1)); SEED=$((970000 + i*911))
  echo "=== $(date -u +%H:%M:%S) f58b iter $i seed $SEED START ===" >> "$ST/fight58_keepalive.log"
  FIGHT_MELEE_ROSTERS=0.5 OPT_VERSION=v0.6 BASE_VERSION=v0.4 OPT_WEIGHTS_ENV=V06_WEIGHTS \
    CEM_MEAN="$MEAN" CEM_DIM=58 CEM_HOURS=6 CEM_CORES=44 CEM_BATCH=44 CEM_EVAL_TIMEOUT_MS=1200000 \
    CEM_POP=40 CEM_ELITE=8 CEM_GAMES=3000 CEM_VAL_GAMES=2500 CEM_SEED=$SEED \
    CEM_VAL_SEEDS="$((SEED+11)),$((SEED+17)),$((SEED+19)),$((SEED+23)),$((SEED+29))" \
    bun src/simulation/optimizer/cem.mjs >> "$ST/fight58_keepalive.log" 2>&1
  [ -f sim-out/cem/best.json ] && cp sim-out/cem/best.json "$ST/fight58_best_iter_$i.json"
  echo "=== $(date -u +%H:%M:%S) f58b iter $i DONE ===" >> "$ST/fight58_keepalive.log"
done
