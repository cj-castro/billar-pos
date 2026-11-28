#!/usr/bin/env python3
"""Write the two files of the bar release image.

    python release/make_release.py --sha <40-hex commit> [--registry ghcr.io/cj-castro] [--out release]

  release.json            {"sha", "built_at" (UTC), "migrations"}: every version in
                          backend/migrations/sql/manifest.txt, in manifest order,
                          using the same rule as backend/app/migrations_runner.py
                          (the stem before the first '_'). The updater compares
                          it with the live schema_migrations table.
  docker-compose.bar.yml  docker-compose.bar.template.yml with {{SHA}} and
                          {{REGISTRY}} filled in.

--registry exists for the Mac end-to-end test (a local registry); the bar
always uses the default. Stdlib only. Exit 0 = written, 2 = bad input.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEMPLATE = os.path.join(HERE, "docker-compose.bar.template.yml")
MANIFEST = os.path.join(ROOT, "backend", "migrations", "sql", "manifest.txt")
DEFAULT_REGISTRY = "ghcr.io/cj-castro"
# Same names and order as updater/updater/ops.py RELEASE_FILES.
OUTPUT_FILES = ("release.json", "docker-compose.bar.yml")

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# host[:port] followed by lower-case path parts; no trailing slash.
_REGISTRY_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$")


def _check_sha(sha):
    if not isinstance(sha, str) or not _SHA_RE.match(sha):
        raise ValueError("sha must be the full 40-character lower-case commit id")


def _check_registry(registry):
    if not isinstance(registry, str) or not _REGISTRY_RE.match(registry):
        raise ValueError("registry must look like ghcr.io/owner or localhost:5001")


def read_manifest(path=MANIFEST):
    """Ordered stems from manifest.txt; comments and blank lines dropped."""
    stems = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if line:
                stems.append(line)
    return stems


def version_of(stem):
    """'031b_modifier_coverage' -> '031b' (migrations_runner.version_of)."""
    return stem.split("_", 1)[0]


def migration_versions(path=MANIFEST):
    versions = [version_of(s) for s in read_manifest(path)]
    if not versions:
        raise ValueError("manifest has no migrations: %s" % path)
    dup = sorted({v for v in versions if versions.count(v) > 1})
    if dup:
        raise ValueError("manifest lists a version twice: %s" % ", ".join(dup))
    return versions


def render_compose(template_text, sha, registry=DEFAULT_REGISTRY):
    _check_sha(sha)
    _check_registry(registry)
    out = template_text.replace("{{SHA}}", sha).replace("{{REGISTRY}}", registry)
    left = re.findall(r"\{\{[^}]*\}\}", out)
    if left:
        raise ValueError("unknown placeholders in template: %s" % ", ".join(sorted(set(left))))
    return out


def release_info(sha, versions, built_at=None):
    _check_sha(sha)
    if built_at is None:
        built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"sha": sha, "built_at": built_at, "migrations": list(versions)}


def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def make_release(sha, out_dir=HERE, registry=DEFAULT_REGISTRY, built_at=None,
                 template=TEMPLATE, manifest=MANIFEST):
    """Validate everything first, then write both files. Returns their paths."""
    with open(template, encoding="utf-8") as f:
        compose = render_compose(f.read(), sha, registry)
    info = release_info(sha, migration_versions(manifest), built_at)
    os.makedirs(out_dir, exist_ok=True)
    paths = [os.path.join(out_dir, name) for name in OUTPUT_FILES]
    _write(paths[0], json.dumps(info, indent=2) + "\n")
    _write(paths[1], compose)
    return paths


def main(argv=None):
    p = argparse.ArgumentParser(description="Write release.json and docker-compose.bar.yml")
    p.add_argument("--sha", required=True, help="full 40-character commit id")
    p.add_argument("--registry", default=DEFAULT_REGISTRY)
    p.add_argument("--out", default=HERE, help="output folder (default: release/)")
    args = p.parse_args(argv)
    try:
        paths = make_release(args.sha, out_dir=args.out, registry=args.registry)
    except (ValueError, OSError) as e:
        print("make_release: %s" % e, file=sys.stderr)
        return 2
    for path in paths:
        print("wrote %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
