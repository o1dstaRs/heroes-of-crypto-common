#!/usr/bin/env python3
"""Export finished-fight replays and per-action actor rows from the test server's Arango journal.

Run ON the test host (TEST_HOST in the server repo's deploy/deploy.ts). The Arango credentials live only in the pm2
process environment of the `testapi` app, so they are read from `pm2 jlist` on stdin and never printed:

    pm2 jlist | python3 export_testserver.py reports <out.jsonl>   # FIGHT_FINISHED rows (terminal-match-report)
    pm2 jlist | python3 export_testserver.py actors  <out.jsonl>   # every journal row: actorType, aiVersion, ...

Copy both files into one local directory named ts_reports.jsonl / ts_actors.jsonl and run live_report.py on it.
"""
import base64
import json
import sys
import urllib.request


def main() -> None:
    mode, out_path = sys.argv[1], sys.argv[2]
    env = next(app for app in json.load(sys.stdin) if app["name"] == "testapi")["pm2_env"]
    base = f"http://{env['HOC_ARANGODB_HOST']}:{env['HOC_ARANGODB_PORT']}/_db/{env['HOC_ARANGODB_DB']}/_api/cursor"
    auth = "Basic " + base64.b64encode(f"{env['HOC_ARANGODB_USER']}:{env['HOC_ARANGODB_PASSWORD']}".encode()).decode()

    def aql(query):
        request = urllib.request.Request(base, data=json.dumps({"query": query, "batchSize": 5000}).encode(),
                                         method="POST", headers={"Authorization": auth, "Content-Type": "application/json"})
        page = json.load(urllib.request.urlopen(request))
        rows = page["result"]
        while page.get("hasMore"):
            more = urllib.request.Request(f"{base}/{page['id']}", method="PUT", headers={"Authorization": auth})
            page = json.load(urllib.request.urlopen(more))
            rows += page["result"]
        return rows

    names = aql("FOR c IN COLLECTIONS() RETURN c.name")
    journal = "JournalEntriesTest1" if "JournalEntriesTest1" in names else next(n for n in names if n.startswith("JournalEntries"))
    if mode == "reports":
        rows = aql(f"FOR d IN {journal} FILTER d.eventSubtype == 'FIGHT_FINISHED' "
                   "RETURN {fightId: d.fightId, created: d.created, payload: d.payload}")
    elif mode == "actors":
        rows = aql(f"FOR d IN {journal} FILTER d.actorType != null "
                   "RETURN {f: d.fightId, s: d.sequence, a: d.actorType, v: d.aiVersion, t: d.actionType, lap: d.lapNumber}")
    else:
        raise SystemExit("mode must be reports or actors")
    with open(out_path, "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    print(f"{journal}: wrote {len(rows)} {mode} rows to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
