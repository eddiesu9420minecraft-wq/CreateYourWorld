"""Seed a Studio TEST database (never the real one) with one job that looks like it was running when Studio
crashed: status=running, heartbeat 10 minutes old, no PID, attempt at the auto-requeue limit — so the next start's
recovery step really recovers it (marks it interrupted) without re-queueing or running anything.

usage: python studio-seed-interrupted.py <test-data-dir>/studio.db
"""
import sqlite3, sys, time, datetime, os

db = sys.argv[1]
real = os.path.join(os.environ.get("APPDATA", ""), "PikaraScienceStudio")
if os.path.abspath(db).lower().startswith(os.path.abspath(real).lower()):
    sys.exit("refusing to touch the real Studio data folder")
c = sqlite3.connect(db)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
old = int(time.time() * 1000) - 10 * 60 * 1000
c.execute("DELETE FROM jobs WHERE id='splash-test-interrupted'")
c.execute(
    "INSERT INTO jobs (id, kind, label, status, attempt, created_at, started_at, heartbeat_at, heartbeat_ms) "
    "VALUES ('splash-test-interrupted', 'qa', '啟動測試：上次中斷的工作', 'running', 5, ?, ?, ?, ?)",
    (now, now, now, old),
)
c.commit()
print("seeded 1 interrupted job into", db)
