#!/usr/bin/env python3
# BSD 2-Clause License
#
# apprise.js CWE-312 sidecar oracle capture.
# Copyright (c) 2026, Chris Caron <lead2gold@gmail.com> (upstream apprise, BSD-2)
# Copyright (c) 2026, apprise.js contributors.
#
# Derived from / drives caronc/apprise v1.12.0. Redistribution and use in
# source and binary forms, with or without modification, are permitted per
# the BSD 2-Clause terms carried by upstream apprise.
"""Capture upstream apprise v1.12.0 ``cwe312_url`` output into a sidecar oracle.

Dev-only. Writes ``fixtures/cwe312.json`` — a SEPARATE sidecar, NEVER a wire
fixture (wire fixtures must stay byte-identical; the whole suite asserts them).

Only *parseable* URLs are captured here: for those, the TS port must be
byte-for-byte equal to the real venv. Unparseable URLs are deliberately NOT
captured — upstream ``cwe312_url`` FAIL-OPENS on them (returns the raw URL,
leaking the token), so encoding that output as an "oracle" would bake the leak
into the test. The TS port fails CLOSED for those; their expected values are
pinned directly in the golden test, not sourced here.

Run::

    scripts/.venv/bin/python scripts/capture_cwe312.py
"""

from __future__ import annotations

import json
from pathlib import Path

from apprise.utils.cwe312 import cwe312_url
from apprise.utils.parse import parse_url

# Parseable adversarial URLs (parse_url accepts them). Covers the five masking
# dimensions + the http/non-http user/host split + allowlist-gated query keys.
PARSEABLE_URLS = [
    "json://localhost/path",  # no creds -> nothing masked
    "http://user:password@localhost/",  # user:pass, http (advanced=False)
    "json://h/p?token=SECRET123456",  # ?token= forced
    "json://h/p?apikey=abcdef123456",  # ?apikey= forced
    "json://h/p?to=user@example.com",  # ?to= forced
    "json://h/p?channel=general",  # non-sensitive key -> heuristic, plaintext
    "http://my_host/path",  # underscore host, http -> is_hostname(underscore=False)
    "json://h/p?data=héllo",  # unicode value (non-forced key)
    "json://h/p?x=abcdefghijklmnopqrstuvwxyz",  # long token (>=16) -> masked
    "slack://user:token@workspace",  # non-http user/host + password
]


def main() -> None:
    cases = []
    for url in PARSEABLE_URLS:
        if not parse_url(url):
            raise SystemExit(f"expected parseable, got rejected: {url!r}")
        cases.append({"url": url, "expected": cwe312_url(url)})

    out = Path(__file__).resolve().parent.parent / "fixtures" / "cwe312.json"
    out.write_text(
        json.dumps(
            {
                "_source": "apprise==1.12.0 apprise.utils.cwe312.cwe312_url",
                "_note": "parseable-only oracle; unparseable cases are pinned "
                "fail-closed in the golden test (upstream fail-opens on them)",
                "parseable": cases,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {out} ({len(cases)} parseable cases)")


if __name__ == "__main__":
    main()
