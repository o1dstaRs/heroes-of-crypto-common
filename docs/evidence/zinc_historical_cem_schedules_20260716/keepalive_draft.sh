#!/bin/bash
# Draft CO-EVOLUTION vs the SHIPPED champion (DEFAULT_DRAFT_W), using the shipped v0.6/BESTMIX fight.
# Candidates must BEAT the shipped draft (frozen=champion) to score >50% — a real improvement search on the
# biggest lever (army composition), re-checked against the improved fight. Best → fresh-seed validate vs shipped.
cd ~/hoc-common || exit 1
ST=~/hoc-common/rl_state; mkdir -p "$ST"
CHAMP='[22.1106,0.5343,-90.8122,-2.8907,3.3891,7.2954,-9.0207,47.2111,74.5008,35.7793,5.6801]'
i=0
while true; do
  i=$((i+1)); SEED=$((920000 + i*911))
  echo "=== $(date -u +%H:%M:%S) draftco iter $i seed $SEED START ===" >> "$ST/draft_keepalive.log"
  CEM_FIGHT_VERSION=v0.6 CEM_DRAFT_FROZEN="$CHAMP" CEM_DRAFT_MEAN="$CHAMP" \
    CEM_POP=44 CEM_ELITE=8 CEM_GENS=15 CEM_GAMES=4000 CEM_VAL_GAMES=6000 CEM_CONC=1 CEM_SEED=$SEED \
    bun src/simulation/optimizer/cem_draft.mjs >> "$ST/draft_keepalive.log" 2>&1
  for d in sim-out/cem_draft sim-out/cem; do [ -f "$d/best.json" ] && cp "$d/best.json" "$ST/draft_best_iter_$i.json" && break; done
  echo "=== $(date -u +%H:%M:%S) draftco iter $i DONE ===" >> "$ST/draft_keepalive.log"
done
