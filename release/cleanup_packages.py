#!/usr/bin/env python3
"""Delete old image versions from GHCR, keeping what the bar may need.

    GH_TOKEN=... python release/cleanup_packages.py --owner cj-castro [--keep 10] [--dry-run]

The release package is read FIRST. The commit SHAs carried by its bar-stable
and bar-previous versions are protected in EVERY package. Then, per package
billar-pos-{backend,frontend,telegram-bot,backup,updater,release}:
  - versions tagged bar-stable or bar-previous, or carrying a protected SHA,
    are never deleted;
  - among versions tagged with a commit SHA (40 hex), the newest --keep are
    kept (newest = updated_at, else created_at, so a version that just got
    a tag counts as new);
  - an older version is deleted only when EVERY tag it carries is a commit SHA;
  - untagged versions and versions with any other tag are left alone (an
    untagged version can be part of a tagged multi-platform image).
Fail-safe:
  - the release package cannot be read (error or not found): nothing is
    deleted anywhere;
  - a release version tagged bar-stable/bar-previous carries no SHA tag (so the
    approved SHA is unknown): nothing is deleted anywhere;
  - a version tagged bar-stable/bar-previous in another package carries no SHA
    tag: nothing is deleted in that package.
Uses the GitHub Packages REST API (user-owned packages; --org for an org).
The token is only sent in the Authorization header, never printed. A listing
that fails stops the run for that package before anything is deleted.
Exit 0 = done, 1 = an API call failed or a fail-safe stopped deletions, 2 = usage.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
PACKAGES = tuple("billar-pos-" + s for s in
                 ("backend", "frontend", "telegram-bot", "backup", "updater", "release"))
RELEASE_PACKAGE = "billar-pos-release"
PROTECTED_TAGS = frozenset({"bar-stable", "bar-previous"})
_SHA_TAG = re.compile(r"^[0-9a-f]{40}$")
PER_PAGE = 100
MAX_PAGES = 50


class ApiError(Exception):
    pass


def tags_of(version):
    return list(((version.get("metadata") or {}).get("container") or {}).get("tags") or [])


def _is_sha(tag):
    return bool(_SHA_TAG.match(tag))


def _rank_key(v):
    return (v.get("updated_at") or v.get("created_at") or "", v.get("id") or 0)


def protected_versions(versions):
    return [v for v in versions if PROTECTED_TAGS & set(tags_of(v))]


def untraceable_protected(versions):
    """Versions tagged bar-stable/bar-previous that carry no commit SHA tag."""
    return [v for v in protected_versions(versions) if not any(_is_sha(t) for t in tags_of(v))]


def protected_shas(versions):
    """Commit SHA tags carried by the versions tagged bar-stable/bar-previous."""
    return frozenset(t for v in protected_versions(versions) for t in tags_of(v) if _is_sha(t))


def select_deletions(versions, keep=10, protect_shas=frozenset()):
    """The versions to delete (list of version dicts), newest first."""
    if keep < 1:
        raise ValueError("keep must be at least 1")
    sha_tagged = [v for v in versions if any(_is_sha(t) for t in tags_of(v))]
    sha_tagged.sort(key=_rank_key, reverse=True)
    out = []
    for v in sha_tagged[keep:]:
        tags = set(tags_of(v))
        if PROTECTED_TAGS & tags or protect_shas & tags:
            continue
        if all(_is_sha(t) for t in tags):
            out.append(v)
    return out


class GitHub:
    def __init__(self, token, owner, org=False, opener=None):
        self.token = token
        self.base = "%s/%s/%s/packages/container" % (
            API, "orgs" if org else "users", urllib.parse.quote(owner, safe=""))
        self.opener = opener or urllib.request.urlopen

    def _call(self, method, url):
        req = urllib.request.Request(url, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "billar-pos-release-cleanup",
        })
        try:
            with self.opener(req, timeout=60) as r:
                body = r.read()
                return r.status, (json.loads(body) if body else None)
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read() or b"{}").get("message", "")
            except ValueError:
                msg = ""
            return e.code, {"message": msg}
        except (urllib.error.URLError, OSError) as e:
            raise ApiError("%s %s: %s" % (method, url, e.__class__.__name__)) from None

    def list_versions(self, package):
        """All versions, or None when the package does not exist (yet)."""
        out = []
        for page in range(1, MAX_PAGES + 1):
            url = "%s/%s/versions?per_page=%d&page=%d" % (
                self.base, urllib.parse.quote(package, safe=""), PER_PAGE, page)
            status, data = self._call("GET", url)
            if status == 404 and page == 1:
                return None
            if status != 200 or not isinstance(data, list):
                raise ApiError("listing %s failed: HTTP %s %s" % (
                    package, status, (data or {}).get("message", "") if isinstance(data, dict) else ""))
            out.extend(data)
            if len(data) < PER_PAGE:
                return out
        raise ApiError("listing %s: more than %d pages" % (package, MAX_PAGES))

    def delete_version(self, package, version_id):
        url = "%s/%s/versions/%d" % (self.base, urllib.parse.quote(package, safe=""), int(version_id))
        status, data = self._call("DELETE", url)
        if status not in (200, 204):
            raise ApiError("deleting %s version %s failed: HTTP %s %s" % (
                package, version_id, status, (data or {}).get("message", "") if isinstance(data, dict) else ""))


def _short(shas):
    return ",".join(sorted(t[:7] for t in shas)) or "none"


def cleanup(gh, packages=PACKAGES, keep=10, dry_run=False, log=print):
    # 1. The release package decides which SHAs are approved (bar-stable) or
    #    kept for rollback (bar-previous). Unknown -> delete nothing anywhere.
    try:
        release_versions = gh.list_versions(RELEASE_PACKAGE)
    except ApiError as e:
        log("%s: %s; nothing deleted in any package" % (RELEASE_PACKAGE, e))
        return False
    if release_versions is None:
        log("%s: package not found; nothing deleted in any package" % RELEASE_PACKAGE)
        return False
    blind = untraceable_protected(release_versions)
    if blind:
        log("%s: version(s) %s tagged bar-stable/bar-previous carry no commit SHA tag, so the "
            "approved SHA is unknown; nothing deleted in any package"
            % (RELEASE_PACKAGE, ",".join(str(v.get("id")) for v in blind)))
        return False
    keep_shas = protected_shas(release_versions)
    log("protected SHAs (from %s bar-stable/bar-previous): %s" % (RELEASE_PACKAGE, _short(keep_shas)))

    ok = True
    for pkg in packages:
        if pkg == RELEASE_PACKAGE:
            versions = release_versions
        else:
            try:
                versions = gh.list_versions(pkg)
            except ApiError as e:
                log("%s: %s; nothing deleted" % (pkg, e))
                ok = False
                continue
            if versions is None:
                log("%s: package not found; skipped" % pkg)
                continue
        blind = untraceable_protected(versions)
        if blind:
            log("%s: version(s) %s tagged bar-stable/bar-previous carry no commit SHA tag; "
                "nothing deleted in this package" % (pkg, ",".join(str(v.get("id")) for v in blind)))
            ok = False
            continue
        doomed = select_deletions(versions, keep, keep_shas | protected_shas(versions))
        log("%s: %d versions, %d to delete" % (pkg, len(versions), len(doomed)))
        for v in doomed:
            label = ",".join(t[:7] for t in tags_of(v))
            if dry_run:
                log("  would delete version %s (%s)" % (v.get("id"), label))
                continue
            try:
                gh.delete_version(pkg, v["id"])
                log("  deleted version %s (%s)" % (v.get("id"), label))
            except ApiError as e:
                log("  %s" % e)
                ok = False
    return ok


def main(argv=None):
    p = argparse.ArgumentParser(description="Keep the newest SHA tags plus bar-stable/bar-previous")
    p.add_argument("--owner", required=True)
    p.add_argument("--org", action="store_true", help="owner is an organization")
    p.add_argument("--keep", type=int, default=10)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    if not token or args.keep < 1:
        print("cleanup_packages: GH_TOKEN must be set and --keep >= 1", file=sys.stderr)
        return 2
    ok = cleanup(GitHub(token, args.owner, args.org), keep=args.keep, dry_run=args.dry_run)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
