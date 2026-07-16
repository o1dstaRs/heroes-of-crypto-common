#!/bin/bash
# Setup-on-MELEE-deployment CEM: retrain the 7-dim setup policy (perk budget + augment spend) on the melee
# armies our baked draft actually fields, comparing candidates to the SHIPPED baked default (frozen anchor).
# A win here = a setup that beats the shipped one on our deployment (the same seam that produced BESTMIX for fight).
cd ~/hoc-common || exit 1
ST=~/hoc-common/rl_state; mkdir -p "$ST"
i=0
while true; do
  i=$((i+1)); SEED=$((820000 + i*911))
  echo "=== $(date -u +%H:%M:%S) setup-melee iter $i seed $SEED START ===" >> "$ST/setup_keepalive.log"
  FIGHT_MELEE_ROSTERS=1 CEM_DIM=7 CEM_POP=44 CEM_ELITE=8 CEM_GENS=15 CEM_GAMES=4000 CEM_VAL_GAMES=6000 CEM_CONC=1 CEM_SEED=$SEED \
    bun src/simulation/optimizer/cem_setup.mjs >> "$ST/setup_keepalive.log" 2>&1
  [ -f sim-out/cem_setup/best.json ] && cp sim-out/cem_setup/best.json "$ST/setup_best_iter_$i.json"
  echo "=== $(date -u +%H:%M:%S) setup-melee iter $i DONE ===" >> "$ST/setup_keepalive.log"
done
