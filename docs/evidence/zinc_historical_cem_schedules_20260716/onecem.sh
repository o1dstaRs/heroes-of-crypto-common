#!/bin/bash
# One-shot cem.mjs run to test the subprocess-timeout fix: does the search now progress PAST gen 3
# (the hanging candidate gets killed at the timeout and pruned) instead of stalling forever?
cd ~/hoc-common || exit 1
ST=~/hoc-common/rl_state
MEAN=$(cat "$ST/mean58.json")
: > /tmp/cemtest.log
FIGHT_MELEE_ROSTERS=0.5 OPT_VERSION=v0.6 BASE_VERSION=v0.4 OPT_WEIGHTS_ENV=V06_WEIGHTS \
  CEM_MEAN="$MEAN" CEM_DIM=58 CEM_HOURS=0 CEM_CORES=44 CEM_BATCH=44 \
  CEM_POP=40 CEM_ELITE=8 CEM_GAMES=3000 CEM_VAL_GAMES=2500 CEM_SEED=555001 \
  CEM_VAL_SEEDS=555012,555018,555020,555024,555030 CEM_EVAL_TIMEOUT_MS=45000 \
  bun src/simulation/optimizer/cem.mjs >> /tmp/cemtest.log 2>&1
echo "=== ONECEM EXIT $? $(date -u +%H:%M:%S) ===" >> /tmp/cemtest.log
