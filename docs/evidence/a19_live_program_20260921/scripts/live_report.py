#!/usr/bin/env python3
"""Replay report for test-server fights: who wins, what each side fields, how its units spend their turns.

Input is an export directory written by export_testserver.py on the test host:
  ts_reports.jsonl  one FIGHT_FINISHED journal row per fight (terminal-match-report payload, gzip+base64 replay)
  ts_actors.jsonl   one row per journal action with actorType (AI | HUMAN | SYSTEM) and aiVersion

    python3 live_report.py <export-dir> [--common <heroes-of-crypto-common checkout>]

The creature catalogue is read from the common checkout (default: the checkout this file lives in). Writes
<export-dir>/fights.json and <export-dir>/turns.jsonl and prints the tables quoted in ../LIVE_ANALYSIS.md.

Joins and conventions (each one was a trap):
  * actor row i belongs to replay journal entry i of the same fight: join by ROW ORDER, not by sequence number;
  * actionType is the server PlayActionType (protobuf/v1/play.proto), mapped in ACTIONS below;
  * the final snapshot drops dead units, so rosters come from the union of every event snapshot;
  * a unit turn is the run of one unit's actions within a lap, closed by END_TURN / WAIT / DEFEND / an attack / a cast;
  * shooter counts use DISTINCT creatures, so a human who splits one Arbalester stack into three still has one;
  * a seat is the bot only if the bot both set it up and fought it: the server's grace/timeout auto-play for an
    absent human counts as that human, and a human-drafted army finished by the bot is "mixed", not AI.
"""
import argparse
import base64
import collections
import datetime
import gzip
import json
import statistics
from pathlib import Path

ACTIONS = {1: "PLACE", 2: "START", 3: "END_TURN", 4: "WAIT", 5: "DEFEND", 6: "SEL_ATK", 7: "MOVE", 8: "MELEE",
           9: "RANGE", 10: "OBSTACLE", 11: "AREA_THROW", 12: "SPELL", 13: "DELETE", 14: "READY", 15: "PING",
           16: "SPLIT", 17: "MOVE_INTENT", 18: "UNPLACE", 19: "MORE_TIME", 20: "AUGMENT", 21: "ABANDON",
           22: "SYNERGY", 23: "ARTIFACT", 24: "GRID"}
FIGHT_ACTIONS = {"MOVE", "MELEE", "RANGE", "OBSTACLE", "AREA_THROW", "SPELL", "WAIT", "DEFEND", "END_TURN"}
TURN_CLOSERS = {"END_TURN", "WAIT", "DEFEND", "MELEE", "RANGE", "OBSTACLE", "AREA_THROW", "SPELL"}
SETUP_ACTIONS = {"PLACE", "START", "READY", "AUGMENT", "SYNERGY", "ARTIFACT", "GRID", "SPLIT", "UNPLACE", "DELETE",
                 "MORE_TIME", "PING", "MOVE_INTENT", "SEL_ATK"}
TEAM = {2: "LEFT", 1: "RIGHT"}
GRID = {1: "NORMAL", 3: "LAVA", 4: "BLOCK"}
SUMMONS = {"Wolf"}
NON_FIGHT_VERSIONS = {"grace", "timeout", "v0.1"}
ABSENT_HUMAN_VERSIONS = {"grace", "timeout"}


def load_catalog(common_root: Path) -> dict:
    catalog = json.loads((common_root / "src" / "configuration" / "creatures.json").read_text())
    creatures = {}
    for faction, entries in catalog.items():
        if faction == "version":
            continue
        for name, props in entries.items():
            creatures[name] = dict(props, faction=faction)
    return creatures


def unit_class(creatures: dict, name: str) -> str:
    props = creatures.get(name)
    if not props:
        return "?"
    return {"RANGE": "ranged", "MAGIC": "caster", "MELEE_MAGIC": "melee_magic", "MELEE": "melee"}.get(
        props["attack_type"], props["attack_type"])


def stack_pool(unit: dict) -> int:
    if unit["dead"] or not unit["amountAlive"]:
        return 0
    return unit["amountAlive"] * unit["maxHp"] - (unit["maxHp"] - unit["hp"])


def turn_outcome(turn: dict) -> str:
    for kind in ("MELEE", "RANGE", "OBSTACLE", "AREA_THROW", "SPELL", "WAIT", "DEFEND"):
        if kind in turn["acts"]:
            moved = turn["moved"] and kind in ("MELEE", "RANGE", "SPELL", "OBSTACLE")
            return ("MOVE+" if moved else "") + kind
    if "END_TURN" in turn["acts"] or turn["moved"]:
        return "MOVE_ONLY" if turn["moved"] else "SKIP"
    return "other"


def read_export(export_dir: Path):
    reports = [json.loads(line) for line in (export_dir / "ts_reports.jsonl").open()]
    actors = collections.defaultdict(list)
    for line in (export_dir / "ts_actors.jsonl").open():
        row = json.loads(line)
        actors[row["f"]].append(row)
    for rows in actors.values():
        rows.sort(key=lambda row: row["s"])
    replays = []
    for report in reports:
        payload = json.loads(report["payload"])
        replay = json.loads(gzip.decompress(base64.b64decode(payload["replayGzipBase64"])))
        replays.append((payload, replay, actors.get(replay["gameId"], [])))
    return replays


def build_fight(creatures: dict, payload: dict, replay: dict, actor_rows: list):
    fid = replay["gameId"][:8]
    events, journal = replay["events"], replay["journal"]
    by_sequence = {event["sequence"]: event for event in events}
    started = events[0]["snapshot"]["serverTimeMs"] if events else 0
    units = {}
    for event in events:
        for unit in event["snapshot"]["units"]:
            units.setdefault(unit["id"], unit)
    final = replay["currentSnapshot"]
    for unit in final["units"]:
        units[unit["id"]] = unit
    roster = {team: sorted(u["name"] for u in units.values() if u["team"] == team and u["name"] not in SUMMONS)
              for team in (1, 2)}
    total_hp = {team: sum((u["amountAlive"] + u["amountDied"]) * u["maxHp"] for u in units.values() if u["team"] == team)
                for team in (1, 2)}
    drivers = {1: collections.Counter(), 2: collections.Counter()}
    setup_drivers = {1: collections.Counter(), 2: collections.Counter()}
    versions = {1: collections.Counter(), 2: collections.Counter()}
    lap_curve, turns, current, previous = {}, [], None, None
    for index, entry in enumerate(journal):
        actor = actor_rows[index] if index < len(actor_rows) else None
        name, team = ACTIONS.get(entry["actionType"], str(entry["actionType"])), entry["team"]
        event = by_sequence.get(entry["sequence"])
        snapshot = event["snapshot"] if event else None
        if snapshot and snapshot["currentLap"] not in lap_curve:
            base = previous or snapshot
            lap_curve[snapshot["currentLap"]] = {
                side: dict(hp=sum(stack_pool(u) for u in base["units"] if u["team"] == side) / max(1, total_hp[side]),
                           x=statistics.mean([u["baseCell"]["x"] for u in base["units"]
                                              if u["team"] == side and not u["dead"]] or [0]))
                for side in (1, 2)}
        if team in (1, 2) and actor and actor["a"] in ("AI", "HUMAN"):
            # The server's grace/timeout auto-play stands in for an absent human: it is the human seat, not the bot.
            who = "HUMAN" if actor["a"] == "HUMAN" or actor["v"] in ABSENT_HUMAN_VERSIONS else "AI"
            if name in SETUP_ACTIONS:
                setup_drivers[team][who] += 1
            else:
                drivers[team][who] += 1
                if actor["v"] and who == "AI":
                    versions[team][actor["v"]] += 1
        action = json.loads(entry["actionJson"])
        uid = action.get("unitId") or (snapshot or {}).get("currentUnitId") or ""
        if name in FIGHT_ACTIONS and team in (1, 2):
            lap = (snapshot or previous or {}).get("currentLap") or (actor or {}).get("lap")
            if current is None or current["uid"] != uid[:8] or current["lap"] != lap:
                if current:
                    turns.append(current)
                unit = units.get(uid, {})
                current = dict(fid=fid, lap=lap, team=TEAM[team], uid=uid[:8], unit=unit.get("name", ""),
                               ucls=unit_class(creatures, unit.get("name", "")),
                               fly=(creatures.get(unit.get("name", "")) or {}).get("movement_type") == "FLY",
                               acts=[], moved=False, target="", tcls="", dmg=0, kill=False, spell="")
            current["acts"].append(name)
            current["moved"] = current["moved"] or name == "MOVE"
            if name == "SPELL":
                current["spell"] = action.get("spellName", "")
            target = units.get(action.get("targetUnitId") or "")
            if target and name in ("MELEE", "RANGE", "SPELL"):
                current["target"], current["tcls"] = target["name"], unit_class(creatures, target["name"])
                if previous and snapshot:
                    before = next((u for u in previous["units"] if u["id"] == target["id"]), None)
                    after = next((u for u in snapshot["units"] if u["id"] == target["id"]), None)
                    if before:
                        current["dmg"] += stack_pool(before) - (stack_pool(after) if after else 0)
                        current["kill"] = current["kill"] or after is None or after["dead"] or after["amountAlive"] == 0
            if name in TURN_CLOSERS:
                turns.append(current)
                current = None
        if snapshot:
            previous = snapshot
    if current:
        turns.append(current)

    def share(counts, who):
        acted = counts["AI"] + counts["HUMAN"]
        return counts[who] / acted if acted else None

    def driver(side):
        """AI only when the bot both set the seat up and fought it; a human draft finished by the bot is mixed."""
        fight_ai, setup_ai = share(drivers[side], "AI"), share(setup_drivers[side], "AI")
        if fight_ai is None:
            return "none"
        if fight_ai > 0.6 and (setup_ai is None or setup_ai > 0.6):
            return "AI"
        if fight_ai < 0.4 and (setup_ai is None or setup_ai < 0.4):
            return "HUMAN"
        return "mixed"

    def version(side):
        named = [v for v, _ in versions[side].most_common() if v not in NON_FIGHT_VERSIONS and not v.startswith("v07-")]
        return named[0] if named else ""

    left_hp = sum(stack_pool(u) for u in final["units"] if u["team"] == 2) / max(1, total_hp[2])
    right_hp = sum(stack_pool(u) for u in final["units"] if u["team"] == 1) / max(1, total_hp[1])
    if not final.get("fightFinished"):
        winner = "unfinished"
    elif right_hp == 0 < left_hp or left_hp > right_hp:
        winner = "LEFT"
    elif left_hp == 0 < right_hp or right_hp > left_hp:
        winner = "RIGHT"
    else:
        winner = "draw"
    fight = dict(fid=fid, t0=started, grid=payload["gridType"], laps=payload["totalLaps"],
                 date=datetime.datetime.fromtimestamp(started / 1000, datetime.timezone.utc).strftime("%m-%d") if started else "?",
                 finished=bool(final.get("fightFinished")), winner=winner, l_hp=left_hp, r_hp=right_hp, lap_curve=lap_curve,
                 left=dict(roster=roster[2], driver=driver(2), version=version(2), setup=payload.get("lowerSetup")),
                 right=dict(roster=roster[1], driver=driver(1), version=version(1), setup=payload.get("upperSetup")))
    classify(fight)
    return fight, turns


def classify(fight: dict) -> None:
    """kind = AIvH / HvH / AIvAI / other; decisive = someone was wiped out, or the fight lasted 4+ laps."""
    left, right = fight["left"]["driver"], fight["right"]["driver"]
    fight["decisive"] = fight["finished"] and fight["winner"] in ("LEFT", "RIGHT") and (
        min(fight["l_hp"], fight["r_hp"]) == 0 or fight["laps"] >= 4)
    fight["ai"] = fight["human"] = None
    if {left, right} == {"AI", "HUMAN"}:
        fight["kind"] = "AIvH"
        fight["ai"], fight["human"] = ("LEFT", "RIGHT") if left == "AI" else ("RIGHT", "LEFT")
        fight["ai_won"] = fight["winner"] == fight["ai"]
    else:
        fight["kind"] = {("AI", "AI"): "AIvAI", ("HUMAN", "HUMAN"): "HvH"}.get((left, right), "other")


def contact_stats(creatures: dict, replays, fights_by_id: dict):
    """For move-only turns: distance to the nearest enemy afterwards, and whether the unit is hit before it acts again."""
    stats, charges = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)

    def chebyshev(a, b):
        return max(abs(a["x"] - b["x"]), abs(a["y"] - b["y"]))

    for _payload, replay, _actors in replays:
        fight = fights_by_id[replay["gameId"][:8]]
        if not fight["decisive"] or fight["kind"] not in ("AIvH", "HvH", "AIvAI"):
            continue

        def driver(team):
            if fight["kind"] == "AIvH":
                return "AI" if TEAM[team] == fight["ai"] else "HUMAN"
            return fight["kind"]

        by_sequence = {event["sequence"]: event for event in replay["events"]}
        flat, previous = [], None
        for index, entry in enumerate(replay["journal"]):
            name = ACTIONS.get(entry["actionType"], "")
            event = by_sequence.get(entry["sequence"])
            snapshot = event["snapshot"] if event else None
            if name in FIGHT_ACTIONS and entry["team"] in (1, 2) and snapshot:
                action = json.loads(entry["actionJson"])
                uid, target = action.get("unitId") or snapshot.get("currentUnitId") or "", action.get("targetUnitId") or ""
                damage = 0
                if target and previous:
                    before = next((u for u in previous["units"] if u["id"] == target), None)
                    after = next((u for u in snapshot["units"] if u["id"] == target), None)
                    if before:
                        damage = stack_pool(before) - (stack_pool(after) if after else 0)
                flat.append(dict(i=index, name=name, uid=uid, team=entry["team"], target=target, snapshot=snapshot,
                                 damage=damage, lap=snapshot["currentLap"]))
            if snapshot:
                previous = snapshot
        turns, current = [], None
        for action in flat:
            if current is None or current["uid"] != action["uid"] or current["lap"] != action["lap"]:
                if current:
                    turns.append(current)
                current = dict(uid=action["uid"], team=action["team"], lap=action["lap"], start=action["i"],
                               end=action["i"], snapshot=action["snapshot"], moved=False, attacked=False)
            current["end"], current["snapshot"] = action["i"], action["snapshot"]
            current["moved"] = current["moved"] or action["name"] == "MOVE"
            current["attacked"] = current["attacked"] or action["name"] in ("MELEE", "RANGE", "SPELL", "OBSTACLE", "AREA_THROW")
            if action["name"] in TURN_CLOSERS:
                turns.append(current)
                current = None
        if current:
            turns.append(current)
        for turn in turns:
            me = next((u for u in turn["snapshot"]["units"] if u["id"] == turn["uid"]), None)
            if not me or me["dead"] or not turn["moved"] or turn["attacked"]:
                continue
            enemies = [u for u in turn["snapshot"]["units"] if u["team"] != me["team"] and not u["dead"] and u["amountAlive"]]
            distance = min((chebyshev(a, b) for u in enemies for a in me["cells"] for b in u["cells"]), default=99)
            bucket = "1" if distance == 1 else "2" if distance == 2 else "3" if distance == 3 else "4+"
            klass = unit_class(creatures, me["name"])
            key = (driver(turn["team"]), "melee" if klass in ("melee", "melee_magic") else klass)
            stats[key][bucket] += 1
            hit = False
            for later in flat:
                if later["i"] <= turn["end"]:
                    continue
                if later["uid"] == turn["uid"]:
                    break
                if later["target"] == turn["uid"] and later["team"] != turn["team"] and later["name"] in ("MELEE", "RANGE", "SPELL"):
                    hit = True
            stats[key][("hit@" if hit else "safe@") + bucket] += 1
        for action in flat:
            if action["name"] == "MELEE" and action["target"]:
                turn = next((t for t in turns if t["start"] <= action["i"] <= t["end"]), None)
                charges[driver(action["team"])]["charge" if turn and turn["moved"] else "in_place"] += 1
    return stats, charges


def pct(part, whole):
    return f"{100 * part / whole:4.1f}%" if whole else "  -  "


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("export_dir", type=Path)
    parser.add_argument("--common", type=Path, default=Path(__file__).resolve().parents[4])
    args = parser.parse_args()
    creatures = load_catalog(args.common)
    replays = read_export(args.export_dir)
    fights, turns = [], []
    for payload, replay, actor_rows in replays:
        fight, fight_turns = build_fight(creatures, payload, replay, actor_rows)
        fights.append(fight)
        turns.extend(fight_turns)
    fights.sort(key=lambda fight: fight["t0"])
    fights_by_id = {fight["fid"]: fight for fight in fights}
    (args.export_dir / "fights.json").write_text(json.dumps(fights))
    with (args.export_dir / "turns.jsonl").open("w") as handle:
        for turn in turns:
            handle.write(json.dumps(turn) + "\n")

    def shooters(side: dict) -> int:
        return sum(1 for name in set(side["roster"]) if unit_class(creatures, name) == "ranged")

    kinds = collections.Counter((fight["kind"], fight["decisive"]) for fight in fights)
    print(f"fights {len(fights)}, unit turns {len(turns)}")
    print("fight classes (kind, decisive):", dict(sorted(kinds.items(), key=str)))
    duel = [fight for fight in fights if fight["kind"] == "AIvH" and fight["decisive"]]
    wins = sum(fight["ai_won"] for fight in duel)
    print(f"\n== AI vs HUMAN, decisive: {len(duel)} fights, AI won {wins} ({pct(wins, len(duel))})")
    for label, key in (("map", lambda f: GRID.get(f["grid"], f["grid"])), ("AI side", lambda f: f["ai"]),
                       ("month", lambda f: f["date"][:2]), ("AI version", lambda f: f[f["ai"].lower()]["version"])):
        groups = collections.defaultdict(lambda: [0, 0])
        for fight in duel:
            groups[key(fight)][0] += fight["ai_won"]
            groups[key(fight)][1] += 1
        print(f"  by {label}: " + ", ".join(f"{k} {w}/{n}" for k, (w, n) in sorted(groups.items(), key=str)))

    print("\n== composition (distinct natively ranged creatures)")
    ai_zero = sum(1 for fight in duel if shooters(fight[fight["ai"].lower()]) == 0)
    print(f"  AI army had 0 shooters in {ai_zero} of {len(duel)}")
    human_counts = collections.Counter(shooters(fight[fight["human"].lower()]) for fight in duel)
    print("  human shooter counts:", dict(sorted(human_counts.items())))
    buckets = collections.defaultdict(lambda: [0, 0])
    for fight in duel:
        ai_r, human_r = shooters(fight[fight["ai"].lower()]), shooters(fight[fight["human"].lower()])
        bucket = "human more" if human_r > ai_r else "equal" if human_r == ai_r else "AI more"
        buckets[bucket][0] += fight["ai_won"]
        buckets[bucket][1] += 1
        if human_r >= 3:
            buckets["human >= 3"][0] += fight["ai_won"]
            buckets["human >= 3"][1] += 1
    print("  AI wins by shooter comparison: " + ", ".join(f"{k} {w}/{n}" for k, (w, n) in sorted(buckets.items())))

    print("\n== unit-turn outcome mix (decisive fights)")
    mixes = collections.defaultdict(collections.Counter)
    for turn in turns:
        fight = fights_by_id[turn["fid"]]
        if not fight["decisive"]:
            continue
        if fight["kind"] == "AIvH":
            mixes["AI (vs humans)" if turn["team"] == fight["ai"] else "humans (vs AI)"][turn_outcome(turn)] += 1
        elif fight["kind"] in ("HvH", "AIvAI"):
            mixes[{"HvH": "humans (vs humans)", "AIvAI": "AI vs AI"}[fight["kind"]]][turn_outcome(turn)] += 1
    columns = ("MELEE", "MOVE+MELEE", "MOVE_ONLY", "WAIT", "RANGE", "SPELL", "SKIP", "DEFEND")
    print(f"  {'driver':20s} {'turns':>6s} " + " ".join(f"{c:>10s}" for c in columns))
    for label in ("AI (vs humans)", "humans (vs AI)", "humans (vs humans)", "AI vs AI"):
        mix = mixes[label]
        total = sum(mix.values())
        print(f"  {label:20s} {total:6d} " + " ".join(f"{pct(mix[c], total):>10s}" for c in columns))

    stats, charges = contact_stats(creatures, replays, fights_by_id)
    print("\n== melee attacks that were charges (the unit moved that turn)")
    for label, counts in sorted(charges.items()):
        total = sum(counts.values())
        print(f"  {label:6s} n={total:5d} charge {pct(counts['charge'], total)}  in place {pct(counts['in_place'], total)}")
    print("\n== move-only turns: distance to the nearest enemy after moving | hit before acting again")
    for (label, klass), counts in sorted(stats.items()):
        total = sum(v for k, v in counts.items() if "@" not in k)
        if total < 15:
            continue
        dist = "  ".join(f"d{b} {pct(counts[b], total)}" for b in ("1", "2", "3", "4+"))
        hits = "  ".join(f"d{b} {counts['hit@' + b]}/{counts['hit@' + b] + counts['safe@' + b]}" for b in ("1", "2", "3", "4+"))
        print(f"  {label:6s} {klass:7s} n={total:4d} | {dist} | {hits}")

    print("\n== AI army / human army HP share at lap start, AI wins vs AI losses (AI vs HUMAN, decisive)")
    for won in (True, False):
        curve = collections.defaultdict(list)
        for fight in duel:
            if fight["ai_won"] != won:
                continue
            ai_team = "2" if fight["ai"] == "LEFT" else "1"
            human_team = "1" if ai_team == "2" else "2"
            for lap, sides in fight["lap_curve"].items():
                sides = {str(k): v for k, v in sides.items()}
                curve[int(lap)].append((sides[ai_team]["hp"], sides[human_team]["hp"]))
        print(f"  AI {'wins  ' if won else 'losses'} " + " ".join(
            f"L{lap} {100 * statistics.mean(a for a, _ in curve[lap]):3.0f}/{100 * statistics.mean(h for _, h in curve[lap]):3.0f}"
            for lap in sorted(curve) if lap <= 8))

    print("\n== setup choices (AI vs HUMAN, decisive): most common level per augment")
    for role in ("ai", "human"):
        choices = collections.defaultdict(collections.Counter)
        for fight in duel:
            for key, value in (fight[fight[role].lower()]["setup"] or {}).items():
                if key.startswith("augment"):
                    choices[key[len("augment"):]][value] += 1
        print(f"  {role:5s} " + "  ".join(f"{k} {dict(v.most_common(3))}" for k, v in sorted(choices.items())))


if __name__ == "__main__":
    main()
