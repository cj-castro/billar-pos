"""Build-time helper for updater/Dockerfile: download one file and verify it.

    python fetch_binary.py <https url> <sha256 hex> <dest>

Exits non-zero (and leaves no file) when the download fails or the SHA-256
does not match the pinned value. Stdlib only; not part of the updater package.
"""
import hashlib
import os
import sys
import urllib.request


def main(argv):
    if len(argv) != 3 or not argv[0].startswith("https://"):
        print("usage: fetch_binary.py <https url> <sha256> <dest>", file=sys.stderr)
        return 2
    url, want, dest = argv
    part = dest + ".part"
    h = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as r, open(part, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    got = h.hexdigest()
    if got != want.lower():
        os.remove(part)
        print("checksum mismatch for %s: got %s, want %s" % (url, got, want), file=sys.stderr)
        return 1
    os.replace(part, dest)
    print("ok %s %s" % (got, dest))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
