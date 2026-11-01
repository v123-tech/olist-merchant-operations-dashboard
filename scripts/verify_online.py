"""Verify a deployed static release using HTTPS without printing asset bodies.

Run from any directory: python scripts/verify_online.py https://example.site
This performs read-only HTTP requests and writes a verification receipt.
"""

import argparse
import gzip
import hashlib
import json
import ssl
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]


class HTTPSOnlyRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise ValueError("Refusing a non-HTTPS redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="Deployed public HTTPS origin or base path")
    parser.add_argument("--output", type=Path, default=ROOT / "evidence/https_asset_verification.json")
    args = parser.parse_args()
    base = args.url.rstrip("/") + "/"
    parts = urlsplit(base)
    if parts.scheme != "https" or not parts.netloc or parts.username or parts.password:
        parser.error("Use a public HTTPS URL without credentials")

    manifest = json.loads((ROOT / "dist/data/manifest.json").read_text(encoding="utf-8"))
    opener = build_opener(HTTPSOnlyRedirect(), HTTPSHandler(context=ssl.create_default_context()))
    results = []
    checks = []
    report = {
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_url": base,
        "method": "Read-only HTTPS GET; default certificate validation; Accept-Encoding identity; streamed SHA-256; gzip JSON schema and row checks",
        "tls_certificate_validation": True,
        "assets": results,
        "checks": checks,
    }

    def check(name, passed, detail):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    def fetch(relative, max_bytes=26 * 1024 * 1024):
        url = urljoin(base, relative)
        result = {"path": relative or "/", "requested_url": url}
        results.append(result)
        req = Request(url, headers={"User-Agent": "Olist-Portfolio-Release-Verification/1.0", "Accept-Encoding": "identity"})
        try:
            with opener.open(req, timeout=60) as response:
                result.update({
                    "status": response.status,
                    "final_url": response.geturl(),
                    "headers": {name.lower(): response.headers.get(name) for name in (
                        "Content-Type", "Content-Encoding", "Content-Length", "Cache-Control",
                        "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy",
                        "Content-Security-Policy", "Strict-Transport-Security") if response.headers.get(name) is not None},
                })
                digest = hashlib.sha256()
                chunks = []
                length = 0
                for block in iter(lambda: response.read(128 * 1024), b""):
                    length += len(block)
                    if length > max_bytes:
                        raise ValueError("Asset exceeds verification size limit")
                    digest.update(block)
                    chunks.append(block)
                result.update({"bytes": length, "sha256": digest.hexdigest()})
                check("status_and_https:" + (relative or "/"), response.status == 200 and urlsplit(response.geturl()).scheme == "https", {"status": response.status, "final_url": response.geturl()})
                return b"".join(chunks), result
        except Exception as exc:
            result["error"] = type(exc).__name__ + ": " + str(exc)
            check("fetch:" + (relative or "/"), False, result["error"])
            return None, result

    paths = ["", "case.html", "app.js", "static-api.js", "data-worker.js", "style.css",
             "data/manifest.json", "data/meta.json", "data/config.json", "data/default-overview.json",
             "data/quality_report.json", "data/replay_results.json"]
    for relative in paths:
        body, result = fetch(relative, max_bytes=3 * 1024 * 1024)
        if body is None:
            continue
        local_path = ROOT / "dist" / (relative or "index.html")
        result["matches_local_release_bytes"] = result["sha256"] == hashlib.sha256(local_path.read_bytes()).hexdigest()
        # HTML may receive hosting-injected presentation metadata. All business
        # scripts, styles and data must retain the exact released bytes.
        if not (relative == "" or relative.endswith(".html")):
            check("local_release_bytes:" + relative, result["matches_local_release_bytes"], {"sha256": result["sha256"]})
        if relative.endswith(".js"):
            mime = result["headers"].get("content-type", "").split(";")[0].strip().lower()
            check("javascript_mime:" + relative, mime in ("text/javascript", "application/javascript"), {"content_type": mime})
        if relative == "":
            check("public_html_without_auth_redirect", b"overview-cards" in body and b"page-workbench" in body and b"page-validation" in body,
                  "Business page markers present in the unauthenticated HTTPS response")
            expected_headers = {
                "x-content-type-options": "nosniff",
                "referrer-policy": "strict-origin-when-cross-origin",
            }
            for name, expected in expected_headers.items():
                check("declared_header:" + name, result["headers"].get(name) == expected, {"expected": expected, "actual": result["headers"].get(name)})
            for name in ("content-security-policy", "permissions-policy"):
                check("declared_header:" + name, bool(result["headers"].get(name)), {"actual": result["headers"].get(name)})

    for name, expected in manifest["files"].items():
        body, result = fetch("data/" + name)
        if body is None:
            continue
        check("compressed_bytes_and_hash:" + name,
              result["bytes"] == expected["bytes"] and result["sha256"] == expected["sha256"],
              {"bytes": result["bytes"], "expected_bytes": expected["bytes"], "sha256": result["sha256"], "expected_sha256": expected["sha256"]})
        encoding = result["headers"].get("content-encoding", "identity").strip().lower()
        check("gzip_not_http_auto_decoded:" + name, encoding in ("", "identity") and body[:2] == b"\x1f\x8b",
              {"content_encoding": encoding, "gzip_magic_present": body[:2] == b"\x1f\x8b", "reason": "Browser DecompressionStream must receive the gzip file bytes, not an HTTP-decoded body"})
        try:
            uncompressed = gzip.decompress(body)
            data = json.loads(uncompressed)
            valid = (len(uncompressed) == expected["uncompressed_bytes"] and data["fields"] == expected["fields"]
                     and data["rows"] == expected["rows"] and len(data["columns"]) == len(data["fields"]))
            valid = valid and all(len(column) == data["rows"] for column in data["columns"])
            result["gzip_validation"] = {"rows": data["rows"], "fields": data["fields"], "uncompressed_bytes": len(uncompressed), "all_column_lengths_match": all(len(column) == data["rows"] for column in data["columns"])}
            check("gzip_json_integrity:" + name, valid, {"rows": data["rows"], "uncompressed_bytes": len(uncompressed), "field_count": len(data["fields"])})
        except Exception as exc:
            check("gzip_json_integrity:" + name, False, type(exc).__name__ + ": " + str(exc))

    report["passed"] = all(item["passed"] for item in checks)
    report["summary"] = {"requests": len(results), "checks": len(checks), "failed_checks": [item["name"] for item in checks if not item["passed"]]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "output": str(args.output), **report["summary"]}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
