"""Test scenarios for a SQUASHED single-file manifest baseline.

Pure logic plus file inspection -- no database is touched:

    cd backend && python -m tests.test_manifest_baseline

The scenario under test: manifest.txt is collapsed from 28 sequential files to
one `001_baseline_squash` schema baseline. These checks pin down what the
execution chain must guarantee for that to be safe.

Covers:
  1. read_manifest parses a single-entry manifest exactly
  2. version_of derives the schema_migrations key the runner skips on
  3. The ordered chain degenerates to exactly one apply, with no reordering
  4. Every shipped .sql file is self-atomic (its own BEGIN/COMMIT)
  5. Every shipped .sql file registers its own version row
  6. The re-apply hazard: a squashed key unknown to an existing database is
     reported as PENDING, so a baseline MUST self-guard
"""
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.migrations_runner import read_manifest, version_of  # noqa: E402

SQL_DIR = Path(__file__).resolve().parents[1] / 'migrations' / 'sql'
passed = failed = 0


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


def manifest_with(body: str) -> list:
    """Run read_manifest against a throwaway manifest, never the real one."""
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / 'manifest.txt').write_text(body, encoding='utf-8')
        return read_manifest(tmp)


BASELINE = '001_baseline_squash'

print("== 1. a squashed manifest parses to exactly one stem ==")
check('1a. single bare entry',
      manifest_with(f'{BASELINE}\n') == [BASELINE])
check('1b. surrounding comments and blank lines are ignored',
      manifest_with(f'# header\n\n{BASELINE}\n\n# trailer\n') == [BASELINE])
check('1c. an inline trailing comment is stripped from the stem',
      manifest_with(f'{BASELINE}   # full schema baseline\n') == [BASELINE])
check('1d. indentation and trailing whitespace are stripped',
      manifest_with(f'   {BASELINE}   \n') == [BASELINE])
check('1e. a manifest of only comments yields no work, not a crash',
      manifest_with('# everything squashed away\n\n') == [])
check('1f. CRLF line endings still parse (Windows POS edits the manifest)',
      manifest_with(f'{BASELINE}\r\n') == [BASELINE])

print()
print("== 2. the version key the runner skips on ==")
check('2a. baseline stem yields the 001 key',
      version_of(BASELINE) == '001', version_of(BASELINE))
check('2b. the key is the text before the FIRST underscore only',
      version_of('001_baseline_squash_v2') == '001')
check('2c. letter-suffixed keys still work, so 001b can follow a baseline',
      version_of('001b_hotfix') == '001b')
check('2d. keys are distinct across a squash plus follow-ups',
      len({version_of(s) for s in ['001_baseline_squash', '002_next', '002b_fix']}) == 3)

print()
print("== 3. the chain degenerates to one apply, order preserved ==")
stems = manifest_with(f'# baseline\n{BASELINE}\n')
check('3a. exactly one unit of work', len(stems) == 1)
check('3b. the baseline is first and last', stems[0] == stems[-1] == BASELINE)
multi = manifest_with(f'{BASELINE}\n002_after\n003_later\n')
check('3c. manifest order is preserved verbatim, never sorted',
      multi == [BASELINE, '002_after', '003_later'])
check('3d. order is NOT alphabetised behind our back',
      manifest_with('010_ten\n002_two\n') == ['010_ten', '002_two'])

print()
print("== 4. every shipped migration is self-atomic ==")
# The runner executes with autocommit=True, so atomicity comes from the FILE's
# own BEGIN/COMMIT -- not from the runner. A squashed baseline that omits them
# would apply statement-by-statement and could leave a half-built schema.
sql_files = sorted(SQL_DIR.glob('[0-9]*.sql'))
check('4a. migration files were found to inspect', len(sql_files) > 0,
      f'{len(sql_files)} files')
missing_tx = [f.name for f in sql_files
              if not re.search(r'^BEGIN;', f.read_text(encoding='utf-8'), re.M)
              or not re.search(r'^COMMIT;', f.read_text(encoding='utf-8'), re.M)]
check('4b. every file opens BEGIN; and closes COMMIT;', not missing_tx,
      f'offenders: {missing_tx}' if missing_tx else 'all atomic')

# CREATE INDEX CONCURRENTLY cannot run inside a transaction block. A squashed
# baseline generated from pg_dump can easily contain one. Comments are stripped
# first so that a file merely *documenting* the hazard is not flagged.
def _strip_sql_comments(text: str) -> str:
    return re.sub(r'--[^\n]*', '', text)


concurrent = [f.name for f in sql_files
              if re.search(r'CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY',
                           _strip_sql_comments(f.read_text(encoding='utf-8')), re.I)]
check('4c. no file mixes CONCURRENTLY with its transaction block', not concurrent,
      f'offenders: {concurrent}' if concurrent else 'none')

print()
print("== 5. every shipped migration records its own version ==")
# Self-registration is what makes the skip logic work on the next boot. A
# baseline that does not INSERT its key re-runs on every single startup.
unregistered = [f.name for f in sql_files
                if 'schema_migrations' not in f.read_text(encoding='utf-8')]
check('5a. every file writes to schema_migrations', not unregistered,
      f'offenders: {unregistered}' if unregistered else 'all register')
stem_keys = {version_of(f.stem) for f in sql_files}
check('5b. no two shipped files share a version key',
      len(stem_keys) == len(sql_files), f'{len(stem_keys)} keys / {len(sql_files)} files')

print()
print("== 6. the squash re-apply hazard is detectable ==")
# An existing install carries 027..039 but has never heard of '001'. The runner
# skips ONLY on an exact key match, so a squashed baseline is pending there.
existing_db = {'027', '027b', '028', '039'}
pending = [s for s in [BASELINE] if version_of(s) not in existing_db]
check('6a. a squashed baseline reads as PENDING on an upgraded database',
      pending == [BASELINE],
      'baseline must self-guard or be pre-seeded into schema_migrations')
check('6b. once its key is present the baseline is skipped',
      [s for s in [BASELINE] if version_of(s) not in existing_db | {'001'}] == [])
check('6c. a fresh database reports the baseline as pending exactly once',
      len([s for s in manifest_with(f'{BASELINE}\n') if version_of(s) not in set()]) == 1)

print()
print("== 7. the real manifest still agrees with the files on disk ==")
real = read_manifest(str(SQL_DIR))
orphan_stems = [s for s in real if not (SQL_DIR / f'{s}.sql').exists()]
check('7a. every manifest entry has a matching .sql file', not orphan_stems,
      f'missing: {orphan_stems}' if orphan_stems else f'{len(real)} entries')
check('7b. no duplicate version keys in the manifest',
      len({version_of(s) for s in real}) == len(real))

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
