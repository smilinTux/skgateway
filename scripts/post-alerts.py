#!/usr/bin/env python3
"""Post skgateway client-guard alerts (logs/alerts.jsonl) to NAM Admin.

Usage: post-alerts.py [outbox]   (default ./logs/alerts.jsonl, run from the release folder)

Delivery reuses notify() from ~/comms/cutover/lanes/host-reprobe.py (Windmill f/ops/notify,
room NAM Admin), which reads WM_URL, WM_WORKSPACE and WM_TOKEN_FILE from the environment
(EnvironmentFile=%h/.config/lane-sweep.env, as fwe-budget-collect.service does). The token is
read there and never printed. The byte offset of the last delivered line is kept in
<outbox>.posted; a failed post stops the run and is retried on the next run.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

NOTIFY = Path(os.environ.get('SKGW_NOTIFY_MODULE', Path.home() / 'comms/cutover/lanes/host-reprobe.py'))


def load_notify():
    spec = importlib.util.spec_from_file_location('reprobe', NOTIFY)
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
