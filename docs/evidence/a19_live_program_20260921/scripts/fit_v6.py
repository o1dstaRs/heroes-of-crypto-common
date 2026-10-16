#!/usr/bin/env python3
"""P17 fit (PREREGISTRATION_FIDELITY_REFIT.md): the v4 fitter (fit_ranked_draft_unit_strength.ts) with per faction x
variant x synergy-level columns added.

Ridge logistic regression by Newton steps on every decisive game, from the candidate's perspective: unpenalized
battle-side (+1 green) and constant columns, creature presence differences (lambda), and for each faction F, variant
v in {1, 2} and level l in {1, 2} (level 3 pooled into 2) the difference of indicators "this army reaches level l of
F and the board fields variant v" (lambda). Lift = beta/4 in pp; offer boards bootstrapped whole; conservative =
point shrunk toward zero by one bootstrap SE.

usage: fit_v6.py --creatures creatures.json --out-prior prior.json --out-table table.json --commit <sha>
                 [--lambda 4] [--bootstrap 200] [--seed 97100001] <records.jsonl ...>
"""
import argparse, hashlib, json, math, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--creatures", required=True)
ap.add_argument("--out-prior", required=True)
ap.add_argument("--out-table", required=True)
ap.add_argument("--commit", required=True)
ap.add_argument("--id", default="ranked-unit-strength-a19-side-v6")
ap.add_argument("--lam", type=float, default=4.0)
ap.add_argument("--bootstrap", type=int, default=200)
ap.add_argument("--seed", type=int, default=97100001)
ap.add_argument("--no-synergy", action="store_true", help="validation: the v4 model exactly (no synergy columns)")
ap.add_argument("records", nargs="+")
args = ap.parse_args()

C = {int(k): v for k, v in json.load(open(args.creatures)).items()}
FACTION_NAME = {1: "Chaos", 2: "Might", 3: "Nature", 4: "Life"}
SYN_FACTIONS = ["Life", "Nature", "Chaos", "Might"]

records, digest, raw_lines = [], hashlib.sha256(), 0
for path in args.records:
    for line in open(path, "rb"):
        if not line.strip():
            continue
        digest.update(line)
        raw_lines += 1
        records.append(json.loads(line))

rows = [r for r in records if r["candidateResult"] != "draw"]
creature_ids = sorted({c for r in rows for side in ("candidate", "opponent") for c in r["armies"][side]["creatureIds"]})
cidx = {c: i for i, c in enumerate(creature_ids)}
syn_cols = [] if args.no_synergy else [(f, v, l) for f in SYN_FACTIONS for v in (1, 2) for l in (1, 2)]
sidx = {k: i for i, k in enumerate(syn_cols)}
RC_LEVELS = [] if args.no_synergy else [0, 1, 2, 3, 5, 6]
NUIS = 2
RC0 = NUIS + len(creature_ids) + len(syn_cols)
P = RC0 + len(RC_LEVELS)
ranged_count = lambda army: sum(1 for c in set(army) if C[c]["ranged"])

def levels(army):
    count = {}
    for c in set(army):
        name = FACTION_NAME.get(C[c]["faction"])
        if name:
            count[name] = count.get(name, 0) + 1
    return {f: min(count.get(f, 0) // 2, 3) for f in SYN_FACTIONS}

X = np.zeros((len(rows), P))
y = np.zeros(len(rows))
board = np.zeros(len(rows), dtype=np.int64)
for i, r in enumerate(rows):
    a, b = r["armies"]["candidate"]["creatureIds"], r["armies"]["opponent"]["creatureIds"]
    X[i, 0] = 1.0 if r["candidateSide"] == "green" else -1.0
    X[i, 1] = 1.0
    for c in set(a):
        X[i, NUIS + cidx[c]] += 1
    for c in set(b):
        X[i, NUIS + cidx[c]] -= 1
    la, lb, var = levels(a), levels(b), r.get("synergyVariants")
    for f in ([] if args.no_synergy else SYN_FACTIONS):
        v = var[f]
        for l in (1, 2):
            X[i, NUIS + len(creature_ids) + sidx[(f, v, l)]] = float(la[f] >= l) - float(lb[f] >= l)
    na, nb = ranged_count(a), ranged_count(b)
    for j, k in enumerate(RC_LEVELS):
        X[i, RC0 + j] = float(na == k) - float(nb == k)
    y[i] = 1.0 if r["candidateResult"] == "win" else 0.0
    board[i] = r["offerBoard"] + 1_000_000 * r.get("shardSeed", 0)

penalty = np.full(P, args.lam)
penalty[:NUIS] = 1e-9

def fit(weights):
    beta = np.zeros(P)
    for _ in range(50):
        z = X @ beta
        p = 1.0 / (1.0 + np.exp(-z))
        g = X.T @ (weights * (y - p)) - penalty * beta
        H = (X * (weights * p * (1 - p))[:, None]).T @ X + np.diag(penalty)
        step = np.linalg.solve(H, g)
        beta += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return beta

point = fit(np.ones(len(rows)))
boards = np.unique(board)
rows_by_board = {bd: np.where(board == bd)[0] for bd in boards}
rng = np.random.default_rng(args.seed)
samples = []
for _ in range(args.bootstrap):
    w = np.zeros(len(rows))
    for bd in rng.choice(boards, size=len(boards), replace=True):
        w[rows_by_board[bd]] += 1
    samples.append(fit(w))
samples = np.array(samples)
to_pp = lambda logit: logit / 4 * 100

creatures = []
for c in creature_ids:
    j = NUIS + cidx[c]
    lift = to_pp(point[j]); draws = to_pp(samples[:, j]); se = float(np.std(draws, ddof=1))
    creatures.append({
        "creatureId": c, "name": C[c]["name"], "level": C[c]["level"], "faction": C[c]["faction"],
        "support": int(np.count_nonzero(X[:, j])),
        "liftPp": float(lift), "standardErrorPp": se,
        "ciLowPp": float(np.quantile(draws, 0.025)), "ciHighPp": float(np.quantile(draws, 0.975)),
        "conservativeLiftPp": float(math.copysign(max(0.0, abs(lift) - se), lift)),
    })
creatures.sort(key=lambda e: (e["level"], -e["liftPp"]))

table, table_detail = {}, {}
for f in ([] if args.no_synergy else SYN_FACTIONS):
    for v in (1, 2):
        j1 = NUIS + len(creature_ids) + sidx[(f, v, 1)]
        j2 = NUIS + len(creature_ids) + sidx[(f, v, 2)]
        cum = []
        for pt, dr in ((point[j1], samples[:, j1]), (point[j1] + point[j2], samples[:, j1] + samples[:, j2])):
            val, se = to_pp(pt), float(np.std(to_pp(dr), ddof=1))
            cum.append((float(val), se, float(math.copysign(max(0.0, abs(val) - se), val))))
        table[f"{f}:{v}"] = [cum[0][2], cum[1][2], cum[1][2]]
        table_detail[f"{f}:{v}"] = {"level1": cum[0][:2], "level2plus": cum[1][:2],
                                    "support": [int(np.count_nonzero(X[:, j1])), int(np.count_nonzero(X[:, j2]))]}

ranged_count_pp, ranged_detail = {"4": 0.0}, {}
for j, k in enumerate(RC_LEVELS):
    val = to_pp(point[RC0 + j]); se = float(np.std(to_pp(samples[:, RC0 + j]), ddof=1))
    ranged_count_pp[str(k)] = float(math.copysign(max(0.0, abs(val) - se), val))
    ranged_detail[str(k)] = (float(val), se, int(np.count_nonzero(X[:, RC0 + j])))

prior = {
    "schemaVersion": 1,
    "id": args.id,
    "source": {"file": ",".join(p.split("/")[-1] for p in args.records), "sha256": digest.hexdigest(),
               "records": raw_lines, "decisiveGames": len(rows), "boards": int(len(boards)),
               "harnessCommit": args.commit},
    "method": {"model": "ridge-logistic-presence-difference-v1+synergy-variant-levels", "ridgeLambda": args.lam,
               "bootstrapSamples": args.bootstrap, "bootstrapUnit": "offer-board",
               "liftScale": "percentage points at p=0.5 (beta/4)",
               "conservative": "ridge point shrunk toward 0 by one bootstrap standard error"},
    "sideLiftPp": float(to_pp(point[0])),
    "seatLiftPp": float(to_pp(point[1])),
    "creatures": creatures,
    **({"rangedCountPp": ranged_count_pp} if RC_LEVELS else {}),
}
json.dump(prior, open(args.out_prior, "w"), indent=2)
json.dump({"table": table, "detail": table_detail}, open(args.out_table, "w"), indent=2)
print(f"rows {len(rows)} boards {len(boards)} creatures {len(creature_ids)} side {to_pp(point[0]):+.2f}pp const {to_pp(point[1]):+.2f}pp")
for k, (val, se, sup) in sorted(ranged_detail.items(), key=lambda e: int(e[0])):
    print(f"  ranged={k}: {val:+6.2f} ± {se:.2f} pp vs 4 (support {sup}) -> {ranged_count_pp[k]:+.2f}")
for key in table:
    d = table_detail[key]
    print(f"  {key:10s} L1 {d['level1'][0]:+6.2f} ± {d['level1'][1]:.2f}  L2+ {d['level2plus'][0]:+6.2f} ± {d['level2plus'][1]:.2f}  support {d['support']}  -> table {['%.2f' % x for x in table[key]]}")
