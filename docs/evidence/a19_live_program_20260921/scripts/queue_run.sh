#!/usr/bin/env bash
# Run ranked_draft_shard.ts jobs from a queue file with at most P at a time.
# usage: queue_run.sh <common-root> <queue-file> <out-dir> <parallel>
# queue line: <job-name> <ranked_draft_shard flags...>   (lines starting with # are skipped)
# A job is done when <out-dir>/<job-name>.jsonl exists; re-running the script resumes. Jobs are claimed with an
# atomic mkdir so two runners on the same queue never run the same job.
set -u
ROOT="$1"; QUEUE="$2"; OUT="$3"; P="$4"
mkdir -p "$OUT/logs" "$OUT/claims"
run_job() {
    local name="$1"; shift
    if bun "$ROOT/docs/evidence/a19_live_program_20260921/scripts/ranked_draft_shard.ts" --common "$ROOT" \
        --records "$OUT/$name.jsonl.tmp" "$@" > "$OUT/logs/$name.out" 2> "$OUT/logs/$name.log"; then
        mv "$OUT/$name.jsonl.tmp" "$OUT/$name.jsonl"
        echo "[$(date -u +%FT%TZ)] DONE $name" >> "$OUT/queue.log"
    else
        echo "[$(date -u +%FT%TZ)] FAIL $name exit $?" >> "$OUT/queue.log"
        rmdir "$OUT/claims/$name" 2>/dev/null
    fi
}
while true; do
    started=0
    while read -r name args; do
        [[ -z "$name" || "$name" == \#* ]] && continue
        [[ -f "$OUT/$name.jsonl" ]] && continue
        [[ -f "$OUT/STOP" ]] && break 2
        while (( $(jobs -rp | wc -l) >= P )); do sleep 20; done
        mkdir "$OUT/claims/$name" 2>/dev/null || continue
        echo "[$(date -u +%FT%TZ)] START $name on $(hostname)" >> "$OUT/queue.log"
        eval "run_job $name $args" &
        started=1
        sleep 2
    done < "$QUEUE"
    (( started == 0 )) && break
done
wait
echo "[$(date -u +%FT%TZ)] RUNNER EXIT $(hostname)" >> "$OUT/queue.log"
