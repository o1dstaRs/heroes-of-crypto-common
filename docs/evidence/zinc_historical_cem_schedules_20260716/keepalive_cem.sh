#!/bin/bash
# Persistent RL runner for agent-zinc — keeps the node highly utilized, auto-restarting.
# Mixed-distribution (50% melee/50% random) v0.6 fight CEM from the baked champion, fresh seeds each iter.
# BATCH=8 PER_CONC=5 (CEM_CORES=40): gens (POP=40, 8-at-a-time x5=40) and panel (8 seeds x5=40) SATURATE
# ~40 cores; the per-gen trajectory eval uses 5 cores (short dip) instead of 1. Leaves ~8 of 48 for the owner.
cd ~/hoc-common || exit 1
ST=~/hoc-common/rl_state; mkdir -p "$ST"
MEAN=$(cat "$ST/mean.json")
i=0
while true; do
  i=$((i+1)); SEED=$((730000 + i*911))
  echo "=== $(date -u +%H:%M:%S) iter $i seed $SEED START ===" >> "$ST/keepalive.log"
  FIGHT_MELEE_ROSTERS=0.5 OPT_VERSION=v0.6 BASE_VERSION=v0.4 OPT_WEIGHTS_ENV=V06_WEIGHTS \
    CEM_MEAN="$MEAN" CEM_DIM=56 CEM_HOURS=6 CEM_CORES=40 CEM_BATCH=8 \
    CEM_POP=40 CEM_ELITE=8 CEM_GAMES=3000 CEM_VAL_GAMES=2500 CEM_SEED=$SEED \
    CEM_VAL_SEEDS="$((SEED+11)),$((SEED+17)),$((SEED+19)),$((SEED+23)),$((SEED+29)),$((SEED+31)),$((SEED+37)),$((SEED+41))" \
    bun src/simulation/optimizer/cem.mjs >> "$ST/keepalive.log" 2>&1
  [ -f sim-out/cem/best.json ] && cp sim-out/cem/best.json "$ST/best_iter_$i.json"
  echo "=== $(date -u +%H:%M:%S) iter $i DONE ===" >> "$ST/keepalive.log"
done
