#!/usr/bin/env python3
"""Leaf refit for a19's search (V07_VALUE_WEIGHTS_V2 basis): logistic regression over the deployed 60-dim V2 basis
(raw 30 + rangedness copy), ridge-shrunk toward the production weights, lambda chosen by grouped cross-validation
(groups = battle seed, so a board's two mirrored fights never straddle folds).

usage: fit_leaf.py --current current_weights.json --out out.json [--folds 5] <vd_*.jsonl ...>
current_weights.json: {"b": float, "w": [60 floats]} (the sealed production V07_VALUE_WEIGHTS_V2)
"""
import argparse, json, math
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--current", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--folds", type=int, default=5)
ap.add_argument("--lams", default="0.3,1,3,10,30,100,300,1000")
ap.add_argument("files", nargs="+")
args = ap.parse_args()

OWN_RF, ENEMY_RF = 20, 21
rows, labels, groups = [], [], []
for path in args.files:
    for line in open(path):
        if not line.strip():
            continue
        r = json.loads(line)
        raw = r["features"]
        rg = (raw[OWN_RF] + raw[ENEMY_RF]) / 2
        rows.append(raw + [x * rg if rg else 0.0 for x in raw])
        labels.append(float(r["label"]))
        groups.append(r["seed"])
X = np.array(rows); y = np.array(labels); g = np.array(groups)
cur = json.load(open(args.current)); w0 = np.array(cur["w"]); b0 = float(cur["b"])
assert X.shape[1] == len(w0) == 60, (X.shape, len(w0))
theta0 = np.concatenate([[b0], w0])
Xb = np.hstack([np.ones((len(X), 1)), X])

def logloss(theta, A, t):
    z = A @ theta
    return float(np.mean(np.logaddexp(0, z) - t * z))

def fit(A, t, lam):
    theta = theta0.copy()
    reg = np.full(len(theta), lam / len(t)); reg[0] = 1e-6 / len(t)
    for _ in range(60):
        z = A @ theta; p = 1 / (1 + np.exp(-z))
        grad = A.T @ (p - t) / len(t) + 2 * reg * (theta - theta0)
        H = (A * (p * (1 - p))[:, None]).T @ A / len(t) + np.diag(2 * reg)
        step = np.linalg.solve(H, grad)
        theta -= step
        if np.max(np.abs(step)) < 1e-9:
            break
    return theta

ug = np.unique(g); rng = np.random.default_rng(20260924); perm = rng.permutation(len(ug))
fold_of = {ug[i]: k % args.folds for k, i in enumerate(perm)}
f = np.array([fold_of[x] for x in g])
print(f"rows {len(y)} fights(seed groups) {len(ug)} base rate {y.mean():.4f}")
print(f"production leaf: logloss {logloss(theta0, Xb, y):.5f}  acc {np.mean(((Xb @ theta0) > 0) == (y > 0.5)):.4f}")
best = None
for lam in [float(x) for x in args.lams.split(",")]:
    ll = 0.0; acc = 0.0
    for k in range(args.folds):
        tr, te = f != k, f == k
        th = fit(Xb[tr], y[tr], lam)
        ll += logloss(th, Xb[te], y[te]) * te.sum()
        acc += np.sum(((Xb[te] @ th) > 0) == (y[te] > 0.5))
    ll /= len(y); acc /= len(y)
    print(f"  lambda {lam:8.2f}: cv logloss {ll:.5f}  acc {acc:.4f}")
    if best is None or ll < best[1]:
        best = (lam, ll)
theta = fit(Xb, y, best[0])
print(f"chosen lambda {best[0]}: cv logloss {best[1]:.5f} vs production {logloss(theta0, Xb, y):.5f} (in-sample for production)")
# calibration by decile of the refit vs production
for name, th in (("production", theta0), ("refit", theta)):
    p = 1 / (1 + np.exp(-(Xb @ th)))
    q = np.quantile(p, np.linspace(0, 1, 11))
    cells = []
    for i in range(10):
        m = (p >= q[i]) & (p <= q[i + 1])
        cells.append(f"{p[m].mean():.2f}/{y[m].mean():.2f}")
    print(f"  calibration {name:10s} (pred/actual by decile): {' '.join(cells)}")
json.dump({"b": float(theta[0]), "w": [float(x) for x in theta[1:]], "lambda": best[0], "cvLogloss": best[1],
           "rows": int(len(y)), "fights": int(len(ug))}, open(args.out, "w"))
