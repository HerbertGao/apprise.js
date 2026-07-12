#!/usr/bin/env python3
# BSD 2-Clause License
#
# apprise.js golden-differential capture harness.
# Copyright (c) 2026, Chris Caron <lead2gold@gmail.com> (upstream apprise, BSD-2)
# Copyright (c) 2026, apprise.js contributors.
#
# Derived from / drives caronc/apprise v1.12.0. Redistribution and use in
# source and binary forms, with or without modification, are permitted per
# the BSD 2-Clause terms carried by upstream apprise.
"""Capture upstream apprise v1.12.0 real HTTP requests into golden fixtures.

This is a *dev-only* tool. It never enters the apprise.js runtime dependency
tree. It drives the upstream Python library, intercepts the request it would
put on the wire, and serialises it so the TypeScript port can be diffed
field-by-field against it.

Why patch the adapter layer (NOT `requests.Session.request`)
-----------------------------------------------------------
We monkeypatch ``requests.adapters.HTTPAdapter.send`` and read the
``PreparedRequest``. Only there is the request in its final wire form:
  * ``auth=(user, pass)``          -> ``Authorization: Basic ...`` header
  * ``params={...}``               -> already joined into ``request.url``
  * form ``data={...}``            -> already url-encoded into ``request.body``
  * ``files=...``                  -> already assembled into a multipart body
  * ``Content-Type`` / ``Content-Length`` -> already computed
Capturing at ``Session.request`` would see raw kwargs (auth still a tuple,
params not joined, form/files not encoded) which are NOT comparable to the
bytes the TS `fetch` records.

Determinism (pinning)
---------------------
Before each capture we pin the fields upstream would otherwise randomise:
  * ``asset._uid``       (apprise-api ``X-Apprise-ID``,      default uuid4())
  * ``asset._recursion`` (apprise-api ``X-Apprise-Recursion-Count`` = _+1)
  * memory attachment ``name`` (else uuid4()+.txt/.dat leaks into the payload)
  * multipart ``boundary`` (else `requests` randomises it in Content-Type/body)
The TS diff side injects the same seeds and compares them (they are semantic
headers, NOT transport defaults). Seeds live in each fixture case.

Faithful capture
----------------
Headers/body are stored EXACTLY as upstream emits them (including transport
defaults like Accept-Encoding/Connection). No normalisation happens here --
that is the TS diff side's job (task 5.3). Do not "tidy" captured bytes.

One-time install (this machine runs Python 3.14; apprise 1.12.0 has C-free
deps and installs fine in an isolated venv)::

    python3 -m venv scripts/.venv
    scripts/.venv/bin/pip install 'apprise==1.12.0'

Then run with that interpreter::

    scripts/.venv/bin/python scripts/capture_fixtures.py            # all cases/*.json
    scripts/.venv/bin/python scripts/capture_fixtures.py custom-json  # one plugin

Input  : cases/<plugin>.json      (hand-authored; see fixtures/SCHEMA.md)
Output : fixtures/<plugin>.json    (generated golden fixture)

`scripts/.venv/` is git-ignored (dev-only, never committed).
"""

from __future__ import annotations

import base64
import contextlib
import json
import sys
from pathlib import Path

import requests
import requests.adapters

import apprise
from apprise import AppriseAttachment
from apprise.attachment.memory import AttachMemory

EXPECTED_APPRISE_VERSION = "1.12.0"

# Default determinism seeds (a case may override via its "seeds" block).
DEFAULT_UID = "itest-uid-0"
DEFAULT_RECURSION = 0

ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = ROOT / "cases"
FIXTURES_DIR = ROOT / "fixtures"


def _fake_response(request):
    """A canned 200 OK so upstream `send()` believes the post succeeded and
    does not retry / short-circuit before we have captured the request."""
    resp = requests.models.Response()
    resp.status_code = 200
    resp.reason = "OK"
    resp._content = b"{}"
    resp.url = request.url
    resp.request = request
    resp.headers["Content-Type"] = "application/json"
    return resp


@contextlib.contextmanager
def intercept(boundary=None):
    """Patch the adapter layer to capture PreparedRequests without network I/O.

    Optionally pin the multipart boundary. Everything is restored on exit.
    """
    captured = []
    orig_send = requests.adapters.HTTPAdapter.send

    def patched_send(self, request, **kwargs):  # noqa: ARG001
        captured.append(request)
        return _fake_response(request)

    requests.adapters.HTTPAdapter.send = patched_send

    # ponytail: boundary pin is honored but untested this batch -- multipart
    # attachment cases are deferred to group F. Hook lives here so group F need
    # not touch the harness; encode_multipart_formdata() resolves choose_boundary
    # from this module at call time, so patching it here takes effect.
    orig_boundary = None
    if boundary is not None:
        import urllib3.filepost as _fp

        orig_boundary = _fp.choose_boundary
        _fp.choose_boundary = lambda: boundary

    try:
        yield captured
    finally:
        requests.adapters.HTTPAdapter.send = orig_send
        if orig_boundary is not None:
            import urllib3.filepost as _fp

            _fp.choose_boundary = orig_boundary


def norm_body(body):
    """Serialise a wire body self-describingly. str payloads (JSON/urlencoded
    form) -> {"text": ...}; bytes payloads (multipart) -> {"base64": ...};
    empty -> null. Round-trips losslessly for the TS diff side."""
    if body is None or body == b"" or body == "":
        return None
    if isinstance(body, str):
        return {"text": body}
    return {"base64": base64.b64encode(body).decode("ascii")}


def build_attach(descriptors):
    """Turn a case's attachment descriptors into an AppriseAttachment, or None.

    file   : {"file": "<path-relative-to-subproject-root>"}
    memory : {"memory": {"text"|"base64": ...}, "mimetype": ..., "name": ...}
             `name` is REQUIRED for memory so upstream's uuid4() auto-name does
             not leak a non-deterministic filename into the payload.
    """
    if not descriptors:
        return None
    ac = AppriseAttachment()
    for d in descriptors:
        if "file" in d:
            ac.add(str((ROOT / d["file"]).resolve()))
        elif "memory" in d:
            mem = d["memory"]
            if "text" in mem:
                content = mem["text"]
            else:
                content = base64.b64decode(mem["base64"])
            name = d.get("name")
            if not name:
                raise ValueError(
                    "memory attachment MUST declare an explicit 'name' "
                    "(else upstream generates a non-deterministic uuid name)"
                )
            ac.add(AttachMemory(
                content=content, name=name, mimetype=d.get("mimetype")
            ))
        else:
            raise ValueError(f"unknown attachment descriptor: {d!r}")
    return ac


def dump_request(pr):
    """PreparedRequest -> fixture 'request' object (faithful, no normalisation)."""
    return {
        "method": pr.method,
        "url": pr.url,
        "headers": dict(pr.headers),
        "body": norm_body(pr.body),
    }


def capture_case(case):
    """Drive one case through upstream apprise; return its fixture entry."""
    seeds = case.get("seeds") or {}
    uid = seeds.get("uid", DEFAULT_UID)
    recursion = seeds.get("recursion", DEFAULT_RECURSION)
    boundary = seeds.get("boundary")

    attachments = case.get("attachments") or []

    # `body_gen` compactly expresses a large body (e.g. overflow cases) as a
    # {char, count} pair so the hand-authored case stays small; the full body is
    # still echoed into the fixture so the TS diff side reads a plain string.
    body = case.get("body", "")
    if "body_gen" in case:
        gen = case["body_gen"]
        body = gen["char"] * gen["count"]

    asset = apprise.AppriseAsset()
    asset._uid = uid
    asset._recursion = recursion

    ap = apprise.Apprise(asset=asset)
    added = ap.add(case["url"])

    input_echo = {
        "url": case["url"],
        "title": case.get("title", ""),
        "body": body,
        "type": case.get("type", "info"),
    }
    if attachments:
        input_echo["attachments"] = attachments

    entry = {
        "name": case["name"],
        "input": input_echo,
        "seeds": {"uid": uid, "recursion": recursion, "boundary": boundary},
    }

    if not added or len(ap) == 0:
        # Upstream rejected construction (e.g. invalid ?method=, bad token).
        entry["expected"] = {"noRequest": {"reason": "instantiation-failed"}}
        return entry

    attach = build_attach(attachments)
    with intercept(boundary=boundary) as captured:
        ap.notify(
            body=body,
            title=case.get("title", ""),
            notify_type=apprise.NotifyType(case.get("type", "info")),
            attach=attach,
        )

    if not captured:
        # Constructed fine but produced no request (e.g. empty content).
        entry["expected"] = {"noRequest": {"reason": "no-request"}}
        return entry

    entry["expected"] = {"request": dump_request(captured[0])}
    if len(captured) > 1:
        entry["expected"]["note"] = f"{len(captured)} requests captured; stored first"
    return entry


def process_plugin(plugin):
    case_file = CASES_DIR / f"{plugin}.json"
    spec = json.loads(case_file.read_text())
    fixture = {
        "plugin": spec.get("plugin", plugin),
        "generated_by": "scripts/capture_fixtures.py",
        "apprise_version": apprise.__version__,
        "cases": [capture_case(c) for c in spec["cases"]],
    }
    out = FIXTURES_DIR / f"{plugin}.json"
    out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    n_req = sum("request" in c["expected"] for c in fixture["cases"])
    n_no = len(fixture["cases"]) - n_req
    print(f"{plugin}: {len(fixture['cases'])} cases -> {out.relative_to(ROOT)} "
          f"({n_req} request, {n_no} noRequest)")


def main(argv):
    if apprise.__version__ != EXPECTED_APPRISE_VERSION:
        print(f"WARNING: apprise {apprise.__version__} != pinned "
              f"{EXPECTED_APPRISE_VERSION}; fixtures may drift.", file=sys.stderr)

    if argv:
        plugins = argv
    else:
        plugins = sorted(p.stem for p in CASES_DIR.glob("*.json"))
    if not plugins:
        print("no cases/*.json found", file=sys.stderr)
        return 1

    for plugin in plugins:
        process_plugin(plugin)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
