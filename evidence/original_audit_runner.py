"""Run the original suite and record read-only source data hashes."""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

here = Path(__file__).resolve().parent
source = here.parents[2] / "olist_project"
watched = [source / "data/processed/olist.sqlite", source / "data/demo_actions.sqlite", source / "data/raw/brazilian-ecommerce-v2.zip"]
def hashes():
    result = {}
    for path in watched:
        if not path.exists():
            result[str(path.relative_to(source))] = {"exists": False}
            continue
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for block in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(block)
        result[str(path.relative_to(source))] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    return result

before = hashes()
result = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=source, env=dict(os.environ, PYTHONUTF8="1"), capture_output=True, encoding="utf-8", errors="replace")
after = hashes()
(here / "original_tests_current.txt").write_text(result.stdout + result.stderr, encoding="utf-8")
receipt = {"checked_at_utc": datetime.now(timezone.utc).isoformat(), "command": "python -B -m unittest discover -s tests -v", "returncode": result.returncode, "before": before, "after": after, "source_data_unchanged": before == after}
(here / "original_tests_current.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(receipt, ensure_ascii=False, indent=2))
sys.exit(result.returncode if before == after else 2)
