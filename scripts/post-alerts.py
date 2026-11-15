#!/usr/bin/env python3
"""Post skgateway evidence and budget monitoring alerts from the outbox to chat.

Usage: post-alerts.py [outbox]   (default ./logs/alerts.jsonl)

The gateway writes one JSON line per alert to the outbox (alerts.outbox in the
client caps file; docs/EVIDENCE-BUDGET-MONITORING.md has the record format).
Delivery is the operator's: SKGW_NOTIFY_MODULE names a Python file that defines
notify(title, summary) -> bool (True when delivered). Its own settings and
credentials come from its environment, never from this script, and are never
printed. The byte offset of the last delivered line is kept in
<outbox>.posted; a failed post stops the run and is retried on the next run.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path


def load_notify():
    path = os.environ.get('SKGW_NOTIFY_MODULE', '').strip()
    if not path:
        sys.exit('post-alerts: set SKGW_NOTIFY_MODULE to a Python file defining notify(title, summary)')
    spec = importlib.util.spec_from_file_location('skgw_notify', Path(path).expanduser())
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.notify


def run(outbox, notify):
    outbox = Path(outbox)
    marker = Path(str(outbox) + '.posted')
    if not outbox.exists():
        return 0
    offset = int(marker.read_text().strip() or 0) if marker.exists() else 0
    data = outbox.read_bytes()
    sent = 0
    while True:
        end = data.find(b'\n', offset)
        if end < 0:
            break                                   # partial last line: wait for the writer
        line = data[offset:end]
        try:
            rec = json.loads(line)
            ok = notify(rec['title'], rec['summary'])
        except (ValueError, KeyError):
            ok = True                               # unreadable line: skip it, never loop on it
        if not ok:
            break
        offset = end + 1
        marker.write_text(str(offset) + '\n')
        sent += 1
    return sent


if __name__ == '__main__':
    print('posted', run(sys.argv[1] if len(sys.argv) > 1 else './logs/alerts.jsonl', load_notify()))
