"""Tests for release/cleanup_packages.py. Plain script, stdlib only, no network.

    docker run --rm -v "$PWD:/r" -w /r python:3.11-slim python release/test_cleanup_packages.py
"""
import io
import json
import os
import sys
import traceback
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cleanup_packages as cp  # noqa: E402

failures = []
TOKEN = "ghs_secretTOKENvalue123"


def check(name, fn):
    try:
        fn()
        print("PASS " + name)
    except Exception:
        failures.append(name)
        print("FAIL " + name)
        traceback.print_exc()


def sha(n):
    return ("%040x" % n)


def ver(vid, day, tags, updated_day=None):
    v = {"id": vid, "created_at": "2026-11-%02dT00:00:00Z" % day,
         "metadata": {"container": {"tags": tags}}}
    if updated_day is not None:
        v["updated_at"] = "2026-11-%02dT00:00:00Z" % updated_day
    return v


def ids(vs):
    return sorted(v["id"] for v in vs)


def t_keeps_newest_n():
    vs = [ver(i, i, [sha(i)]) for i in range(1, 16)]   # day 1..15
    assert ids(cp.select_deletions(vs, keep=10)) == [1, 2, 3, 4, 5]


def t_protected_never_deleted():
    vs = [ver(i, i, [sha(i)]) for i in range(1, 16)]
    vs[0]["metadata"]["container"]["tags"].append("bar-stable")     # id 1, oldest
    vs[1]["metadata"]["container"]["tags"] = ["bar-previous"] + vs[1]["metadata"]["container"]["tags"]
    assert ids(cp.select_deletions(vs, keep=10)) == [3, 4, 5]


def t_untagged_and_other_tags_left_alone():
    vs = [ver(i, i + 10, [sha(i)]) for i in range(1, 13)]
    vs += [ver(100, 1, []), ver(101, 1, ["latest"]), ver(102, 1, [sha(102), "manual"])]
    assert ids(cp.select_deletions(vs, keep=10)) == [1, 2]


def t_order_by_created_not_list_order():
    vs = [ver(i, 20 - i, [sha(i)]) for i in range(1, 13)]   # id 1 is newest
    vs.reverse()
    assert ids(cp.select_deletions(vs, keep=10)) == [11, 12]


def t_fewer_than_keep():
    assert cp.select_deletions([ver(1, 1, [sha(1)])], keep=10) == []
    assert cp.select_deletions([], keep=10) == []


def t_bad_keep():
    try:
        cp.select_deletions([], keep=0)
    except ValueError:
        return
    raise AssertionError("keep=0 accepted")


class FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = json.dumps(body).encode() if body is not None else b""

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    """pages: {package: [list of version dicts]}; status overrides per package."""

    def __init__(self, versions, list_status=None, delete_status=204):
        self.versions = versions
        self.list_status = list_status or {}
        self.delete_status = delete_status
        self.calls = []

    def __call__(self, req, timeout=None):
        assert req.get_header("Authorization") == "Bearer " + TOKEN
        url = req.full_url
        self.calls.append((req.get_method(), url))
        pkg = url.split("/packages/container/")[1].split("/")[0]
        if req.get_method() == "GET":
            st = self.list_status.get(pkg, 200)
            if st != 200:
                raise urllib.error.HTTPError(url, st, "x", {}, io.BytesIO(b'{"message":"nope"}'))
            page = int(url.split("page=")[-1])
            data = self.versions.get(pkg, [])
            return FakeResp(200, data[(page - 1) * cp.PER_PAGE: page * cp.PER_PAGE])
        if self.delete_status != 204:
            raise urllib.error.HTTPError(url, self.delete_status, "x", {}, io.BytesIO(b"{}"))
        return FakeResp(204, None)


def run_cleanup(opener, **kw):
    lines = []
    gh = cp.GitHub(TOKEN, "cj-castro", opener=opener)
    ok = cp.cleanup(gh, packages=("billar-pos-backend", "billar-pos-release"), log=lines.append, **kw)
    return ok, lines


def t_pagination_and_deletes():
    many = [ver(i, 1 + i % 28, [sha(i)]) for i in range(1, 151)]   # 150 versions, 2 pages
    op = FakeOpener({"billar-pos-backend": many, "billar-pos-release": many[:5]})
    ok, lines = run_cleanup(op)
    assert ok, lines
    gets = [u for m, u in op.calls if m == "GET"]
    dels = [u for m, u in op.calls if m == "DELETE"]
    assert len([u for u in gets if "billar-pos-backend" in u]) == 2, gets
    assert len(dels) == 140, len(dels)
    assert all("/users/cj-castro/packages/container/billar-pos-backend/versions/" in u for u in dels)
    assert TOKEN not in "\n".join(lines)


def t_dry_run_deletes_nothing():
    op = FakeOpener({"billar-pos-backend": [ver(i, i, [sha(i)]) for i in range(1, 13)]})
    ok, lines = run_cleanup(op, dry_run=True)
    assert ok and not [c for c in op.calls if c[0] == "DELETE"], op.calls
    assert sum("would delete" in l for l in lines) == 2, lines


def t_listing_error_deletes_nothing():
    op = FakeOpener({"billar-pos-backend": [ver(i, i, [sha(i)]) for i in range(1, 13)]},
                    list_status={"billar-pos-backend": 403})
    ok, lines = run_cleanup(op)
    assert not ok
    assert not [c for c in op.calls if c[0] == "DELETE"], op.calls
    assert TOKEN not in "\n".join(lines)


def t_missing_package_skipped():
    op = FakeOpener({}, list_status={"billar-pos-backend": 404})
    ok, lines = run_cleanup(op)
    assert ok, lines
    assert any("not found" in l for l in lines), lines


def t_delete_error_reported():
    op = FakeOpener({"billar-pos-backend": [ver(i, i, [sha(i)]) for i in range(1, 12)]}, delete_status=403)
    ok, lines = run_cleanup(op)
    assert not ok and any("failed" in l for l in lines), lines


def t_rank_by_updated_at():
    vs = [ver(i, i + 10, [sha(i)]) for i in range(1, 13)]      # ids 1,2 oldest
    vs[0]["updated_at"] = "2026-11-28T00:00:00Z"                # id 1 retagged today
    assert ids(cp.select_deletions(vs, keep=10)) == [2, 3]
    # created_at is the fallback when updated_at is missing
    assert ids(cp.select_deletions([ver(i, i, [sha(i)]) for i in range(1, 12)], keep=10)) == [1]


def deletes_by_pkg(op):
    out = {}
    for m, u in op.calls:
        if m == "DELETE":
            pkg = u.split("/packages/container/")[1].split("/")[0]
            out.setdefault(pkg, []).append(int(u.rsplit("/", 1)[1]))
    return {k: sorted(v) for k, v in out.items()}


def t_release_shas_protected_everywhere():
    # release: sha(3) is bar-stable, sha(4) is bar-previous; backend has only SHA tags.
    release = [ver(i, i, [sha(i)]) for i in range(1, 16)]
    release[2]["metadata"]["container"]["tags"].append("bar-stable")
    release[3]["metadata"]["container"]["tags"].append("bar-previous")
    backend = [ver(i + 100, i, [sha(i)]) for i in range(1, 16)]
    op = FakeOpener({"billar-pos-backend": backend, "billar-pos-release": release})
    ok, lines = run_cleanup(op)
    assert ok, lines
    got = deletes_by_pkg(op)
    assert got["billar-pos-backend"] == [101, 102, 105], got
    assert got["billar-pos-release"] == [1, 2, 5], got
    # the release package is read before any other
    assert "billar-pos-release" in op.calls[0][1], op.calls[0]
    assert any("protected SHAs" in l and sha(3)[:7] in l and sha(4)[:7] in l for l in lines), lines


def t_untraceable_tag_in_package_blocks_that_package():
    release = [ver(i, i, [sha(i)]) for i in range(1, 13)]
    backend = [ver(i + 100, i, [sha(i)]) for i in range(1, 13)]
    backend.append(ver(200, 1, ["bar-stable"]))                 # no SHA tag
    op = FakeOpener({"billar-pos-backend": backend, "billar-pos-release": release})
    ok, lines = run_cleanup(op)
    assert not ok
    got = deletes_by_pkg(op)
    assert "billar-pos-backend" not in got, got
    assert got.get("billar-pos-release") == [1, 2], got
    assert any("billar-pos-backend" in l and "no commit SHA" in l for l in lines), lines


def t_untraceable_tag_in_release_blocks_everything():
    release = [ver(i, i, [sha(i)]) for i in range(1, 13)] + [ver(300, 1, ["bar-previous"])]
    backend = [ver(i + 100, i, [sha(i)]) for i in range(1, 13)]
    op = FakeOpener({"billar-pos-backend": backend, "billar-pos-release": release})
    ok, lines = run_cleanup(op)
    assert not ok
    assert deletes_by_pkg(op) == {}, op.calls
    assert any("nothing deleted in any package" in l for l in lines), lines


def t_release_unreadable_deletes_nothing_anywhere():
    for status in (500, 403, 404):
        backend = [ver(i + 100, i, [sha(i)]) for i in range(1, 13)]
        op = FakeOpener({"billar-pos-backend": backend}, list_status={"billar-pos-release": status})
        ok, lines = run_cleanup(op)
        assert not ok, status
        assert deletes_by_pkg(op) == {}, (status, op.calls)
        assert [m for m, _ in op.calls] == ["GET"], (status, op.calls)   # stops after release
        assert any("nothing deleted in any package" in l for l in lines), lines
        assert TOKEN not in "\n".join(lines)


def t_main_requires_token():
    old = {k: os.environ.pop(k, None) for k in ("GH_TOKEN", "GITHUB_TOKEN")}
    try:
        assert cp.main(["--owner", "cj-castro"]) == 2
    finally:
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v


TESTS = [
    ("keeps the newest 10 SHA versions", t_keeps_newest_n),
    ("bar-stable / bar-previous never deleted", t_protected_never_deleted),
    ("untagged and non-SHA tags left alone", t_untagged_and_other_tags_left_alone),
    ("newest by created_at", t_order_by_created_not_list_order),
    ("fewer than keep -> nothing", t_fewer_than_keep),
    ("keep must be >= 1", t_bad_keep),
    ("pagination, deletes, token not logged", t_pagination_and_deletes),
    ("dry run deletes nothing", t_dry_run_deletes_nothing),
    ("listing error -> nothing deleted", t_listing_error_deletes_nothing),
    ("missing package skipped", t_missing_package_skipped),
    ("delete error reported", t_delete_error_reported),
    ("main requires a token", t_main_requires_token),
    ("newest by updated_at, created_at fallback", t_rank_by_updated_at),
    ("release bar-stable/bar-previous SHAs protected in every package", t_release_shas_protected_everywhere),
    ("protected tag without SHA blocks that package", t_untraceable_tag_in_package_blocks_that_package),
    ("protected tag without SHA in release blocks everything", t_untraceable_tag_in_release_blocks_everything),
    ("release unreadable -> nothing deleted anywhere", t_release_unreadable_deletes_nothing_anywhere),
]

if __name__ == "__main__":
    for name, fn in TESTS:
        check(name, fn)
    if failures:
        print("\n%d FAILED: %s" % (len(failures), ", ".join(failures)))
        sys.exit(1)
    print("\nall %d passed" % len(TESTS))
