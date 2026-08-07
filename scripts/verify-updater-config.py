#!/usr/bin/env python3
"""Fail a release if a built binary is missing an updater endpoint or the public key.

Why this exists: the updater config is the one part of the app that, if it silently goes
missing or wrong, strands every installed user forever — they simply stop being offered
updates, with no error anywhere. Nothing in the build would have told us.

Why it is not a grep: on x86_64, LLVM lowers a known-length String allocation into a series
of 8-byte immediate stores, so a 46-byte URL never appears as one contiguous run of bytes in
the executable even though it is completely present. A plain `grep -aF` therefore rejects
every correct Intel build. This checks for the contiguous form first, then for the ordered
nearby 8-byte chunks that immediate materialization produces.

    python3 scripts/verify-updater-config.py <built-binary> <tauri.conf.json>
"""
import json
import pathlib
import sys

# How far apart consecutive 8-byte chunks may sit and still count as one materialized
# string. The stores are emitted back to back, so this is generous.
MAX_CHUNK_GAP = 128


def occurrences(blob: bytes, part: bytes) -> list:
    found, start = [], 0
    while True:
        at = blob.find(part, start)
        if at < 0:
            return found
        found.append(at)
        start = at + 1


def materialization(blob: bytes, value: str):
    """Return how `value` is represented in the binary, or None if it is absent."""
    needle = value.encode("utf-8")
    if needle in blob:
        return "contiguous"

    parts = [needle[i:i + 8] for i in range(0, len(needle), 8)]
    hits = [occurrences(blob, part) for part in parts]
    if any(not candidates for candidates in hits):
        return None

    # The stores may run forwards or backwards through the buffer depending on codegen.
    for direction in (-1, 1):
        for first in hits[0]:
            previous = first
            for candidates in hits[1:]:
                nearby = [at for at in candidates if 0 < direction * (at - previous) <= MAX_CHUNK_GAP]
                if not nearby:
                    break
                previous = min(nearby, key=lambda at: abs(at - previous))
            else:
                return "ordered nearby immediate chunks"
    return None


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    binary_path, config_path = map(pathlib.Path, sys.argv[1:])
    blob = binary_path.read_bytes()
    updater = json.loads(config_path.read_text())["plugins"]["updater"]

    if not updater.get("endpoints") or not updater.get("pubkey"):
        print("updater endpoints/pubkey must not be empty", file=sys.stderr)
        return 1

    expected = [("endpoint", value) for value in updater["endpoints"]]
    expected.append(("public key", updater["pubkey"]))

    failed = False
    for label, value in expected:
        mode = materialization(blob, value)
        if mode is None:
            print(f"MISSING updater {label} in {binary_path}: {value}", file=sys.stderr)
            failed = True
        else:
            print(f"verified updater {label} ({mode}): {value}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
