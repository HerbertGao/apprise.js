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

Input  : cases/<plugin>.json            (hand-authored; see fixtures/SCHEMA.md)
         cases/url-oracle/<plugin>.json (url()-only seeds; NEVER wire-captured)
Output : fixtures/<plugin>.json          (generated golden WIRE fixture)
         fixtures/url-oracle.json        (url() sidecar oracle; NOT a wire fixture)

The url() sidecar (change `url-serialization-anchors`) records upstream's
`url()` / `url(privacy=True)` and its two-stage re-serialization for every case
whose instance CONSTRUCTS; it never touches any wire fixture's bytes. See
`capture_url_oracle` below.

`scripts/.venv/` is git-ignored (dev-only, never committed).
"""

from __future__ import annotations

import base64
import contextlib
import importlib
import json
import re
import sys
import urllib.parse
import uuid
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
MAX_TIMESTAMP_MS = (1 << 51) - 1
RESULT_REQUIRED_PLUGINS = {
    "serverchan",
    "dingtalk",
    "wecombot",
    "feishu",
    "lark",
    "wxpusher",
    "pushdeer",
    "pushover",
    "pushbullet",
    "ntfy",
    "gotify",
    "bark",
}

ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = ROOT / "cases"
URL_ORACLE_CASES_DIR = CASES_DIR / "url-oracle"
FIXTURES_DIR = ROOT / "fixtures"
URL_ORACLE_OUT = FIXTURES_DIR / "url-oracle.json"

# Per-plugin url() emitted-key inventory, curated from the pinned upstream
# oracle. The TypeScript url() implementation is the compared subject, never
# the authority for this list. `static` keys are always emitted; each
# `conditional` key is emitted only under a non-default condition and MUST be
# activated by >=1 captured case (mechanically asserted in
# `_assert_inventory_covered`). A bare "+"/"-"/":" conditional entry denotes the
# custom prefix-mapping FAMILY (any query key whose DECODED name starts with that
# char), not a literal key. `_assert_inventory_covered` enforces declared ⊆
# effective (every declared conditional is activated by a seed); the OTHER
# direction (effective ⊆ declared — no upstream-emitted key escapes inventory ∪ D)
# is verified out-of-band by `scripts/url_key_completeness_sweep.py` (run it when a
# plugin or query arg is added — that reverse gap is how tags/template/attach-as
# each shipped uncompared until a review round caught them).
URL_KEY_INVENTORY = {
    "custom-json": {
        "static": ["method", "format", "overflow"],
        "conditional": ["verify", "rto", "cto", "+", "-", ":"],
    },
    "custom-form": {
        # `attach-as` (multipart attachment filename) is upstream-serialised when
        # non-default (custom_form.py:497) but TS-deferred (form.ts constructs, drops
        # it — deferred multipart). It IS constructible, so like discord `template`
        # it joins design.md D1's D and gets an active `oracle-attach-as` seed.
        # json/xml never emit `attach-as` (form-only), so it stays out of their
        # inventories. The `+`/`-`/`:` families are the custom prefix maps TS emits.
        "static": ["method", "format", "overflow"],
        "conditional": ["verify", "rto", "cto", "+", "-", ":", "attach-as"],
    },
    "custom-xml": {
        "static": ["method", "format", "overflow"],
        "conditional": ["verify", "rto", "cto", "+", "-", ":"],
    },
    "apprise-api": {
        # apprise-api url() only echoes the + header family (never -/:), and
        # emits rto=30.0 by default (its default differs from the URLBase base).
        # `tags` is emitted (sorted, comma-joined) when routing tags are supplied;
        # TS defers tag forwarding (design.md D1's D), so rule 2 tolerates it.
        "static": ["method", "format", "overflow"],
        "conditional": ["verify", "rto", "cto", "+", "tags"],
    },
    "mattermost": {
        # `mode` is NOT here: upstream emits it only for value `bot` (webhook, the
        # default, is unemitted), and TS mattermost construct-REJECTS `?mode=bot`
        # ("bot mode is not supported in this batch"). So no constructible seed can
        # activate a non-default `mode` — excluded like slack `template`/matrix `path`.
        "static": ["image", "format", "overflow"],
        "conditional": ["verify", "rto", "cto", "icon_url", "to"],
    },
    "discord": {
        # `template` (webhook template URL) is upstream-serialised but TS-deferred
        # (discord.ts constructs, drops it — rejection is in send(), not the ctor).
        # It IS constructible, so unlike matrix `path` it gets an active seed and
        # joins design.md D1's D (see DEFERRED in url-oracle.test.ts). The `:{k}`
        # overflow-substitution tokens are also upstream-emitted-but-TS-dropped, but
        # canNOT join D: they serialise as `%3A<name>` (arbitrary <name>) — not an
        # exact member, and not a `%3A`-prefix family either, since the custom plugins
        # IMPLEMENT `:payload` and TS emits those same `%3A<name>` keys (a prefix defer
        # would trip rule 3 against them). Documented model boundary, no seed activates
        # them (rule 2 fails loud if one ever does).
        "static": [
            "tts", "avatar", "footer", "footer_logo",
            "image", "fields", "batch", "format", "overflow",
        ],
        "conditional": [
            "verify", "rto", "cto",
            "avatar_url", "flags", "href", "thread", "ping", "template",
        ],
    },
    "slack": {
        # `template` (Block-Kit templating) is construct-REJECTED (slack.ts throws),
        # so no case can activate it — safe, excluded like matrix `path`. The `:{k}`
        # overflow-substitution tokens construct but are upstream-emitted-but-TS-
        # dropped; they serialise as `%3A<name>` and cannot join D — same `%3A`-family
        # collision with the custom plugins' implemented `:payload` as discord (a
        # documented model boundary, no seed activates them).
        "static": [
            "image", "footer", "timestamp", "blocks", "mode",
            "format", "overflow",
        ],
        "conditional": ["verify", "rto", "cto"],
    },
    "telegram": {
        "static": [
            "image", "detect", "silent", "preview", "content", "mdv",
            "format", "overflow",
        ],
        "conditional": ["verify", "rto", "cto", "topic"],
    },
    "rocketchat": {
        "static": ["avatar", "mode", "format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "matrix": {
        "static": [
            "image", "mode", "version", "msgtype", "discovery", "hsreq",
            "format", "overflow",
        ],
        # `path` (hookshot-only) is a DEFERRED-feature key: hookshot mode is not
        # implemented this batch (matrix.ts constructs throw), so no constructible
        # case can activate it — excluded from the must-activate conditional set.
        "conditional": ["verify", "rto", "cto", "e2ee"],
    },
    "serverchan": {"static": [], "conditional": []},
    "dingtalk": {
        "static": ["format", "overflow", "verify"],
        "conditional": [],
    },
    "wecombot": {
        "static": ["format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "feishu": {
        "static": ["format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "lark": {
        "static": ["format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "wxpusher": {
        "static": ["format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "pushdeer": {"static": [], "conditional": []},
    "gotify": {
        "static": ["priority", "format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "bark": {
        "static": ["image", "format", "overflow"],
        "conditional": [
            "sound", "level", "volume", "click", "badge", "category",
            "group", "icon", "call", "verify", "rto", "cto",
        ],
    },
    "pushover": {
        "static": ["priority", "sound", "format", "overflow"],
        "conditional": [
            "url", "url_title", "expire", "interval", "key", "e2ee",
            "verify", "rto", "cto",
        ],
    },
    "pushbullet": {
        "static": ["format", "overflow"],
        "conditional": ["verify", "rto", "cto"],
    },
    "ntfy": {
        "static": [
            "priority", "mode", "image", "auth", "format", "overflow",
        ],
        "conditional": [
            "avatar_url", "attach", "click", "delay", "email", "xtags",
            "actions", "verify", "rto", "cto",
        ],
    },
}


def _fake_response(request, spec=None):
    """A canned response so upstream `send()` believes the post succeeded and
    does not retry / short-circuit before we have captured the request.

    Default (spec=None): 200 OK with a ``{}`` JSON body. For multi-step plugins
    a case supplies a per-request ``spec`` (``{"status", "headers", "body"}``)
    so login/whoami/getUploadURL etc. return a FORM-CORRECT body (containing the
    token/channel/url the next request is built from); a missing field would make
    upstream short-circuit and truncate the captured sequence. ``body`` is the
    self-describing ``{"text"|"base64": ...}`` shape (or null)."""
    resp = requests.models.Response()
    resp.status_code = 200 if spec is None else spec.get("status", 200)
    resp.reason = "OK"
    if spec is None:
        resp._content = b"{}"
        resp.headers["Content-Type"] = "application/json"
    else:
        body = spec.get("body")
        if body is None:
            resp._content = b""
        elif "text" in body:
            resp._content = body["text"].encode("utf-8")
        else:
            resp._content = base64.b64decode(body["base64"])
        for key, value in (spec.get("headers") or {}).items():
            resp.headers[key] = value
    resp.url = request.url
    resp.request = request
    return resp


def _validate_responses(responses, case_name):
    """Validate the closed canned-response schema before driving upstream."""
    if responses is None:
        return []
    if not isinstance(responses, list):
        raise SystemExit(
            f"ERROR: case {case_name!r} responses MUST be an array."
        )
    allowed = {"status", "headers", "body"}
    for idx, spec in enumerate(responses):
        if not isinstance(spec, dict) or set(spec) - allowed:
            raise SystemExit(
                f"ERROR: case {case_name!r} responses[{idx}] MUST be an object "
                f"with only {sorted(allowed)!r}."
            )
        if "status" in spec and (
            isinstance(spec["status"], bool)
            or not isinstance(spec["status"], int)
        ):
            raise SystemExit(
                f"ERROR: case {case_name!r} responses[{idx}].status MUST be an integer."
            )
        headers = spec.get("headers")
        if headers is not None and (
            not isinstance(headers, dict)
            or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in headers.items()
            )
        ):
            raise SystemExit(
                f"ERROR: case {case_name!r} responses[{idx}].headers MUST map strings to strings."
            )
        if "body" not in spec or spec["body"] is None:
            continue
        body = spec["body"]
        if (
            not isinstance(body, dict)
            or set(body) not in ({"text"}, {"base64"})
            or not all(isinstance(value, str) for value in body.values())
        ):
            raise SystemExit(
                f"ERROR: case {case_name!r} responses[{idx}].body MUST be null "
                "or exactly one string field: text/base64."
            )
    return responses


def _timestamp_ms(seeds, case_name):
    """Return a validated optional timestampMs determinism seed."""
    if "timestampMs" not in seeds:
        return None
    value = seeds["timestampMs"]
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAX_TIMESTAMP_MS
    ):
        raise SystemExit(
            f"ERROR: case {case_name!r} seeds.timestampMs MUST be an integer "
            f"between 0 and {MAX_TIMESTAMP_MS}."
        )
    return value


def _entropy_hex(seeds, case_name):
    """Return a validated optional queue of 16-byte entropy seeds.

    The generic capture runner deliberately does not consume or install this
    queue.  A Pushover-only context manager owns that seam (task 1.2).
    """
    if "entropyHex" not in seeds:
        return None
    value = seeds["entropyHex"]
    if not isinstance(value, list):
        raise SystemExit(
            f"ERROR: case {case_name!r} seeds.entropyHex MUST be an array."
        )
    for idx, item in enumerate(value):
        if not isinstance(item, str) or re.fullmatch(
            r"[0-9a-fA-F]{32}", item
        ) is None:
            raise SystemExit(
                f"ERROR: case {case_name!r} seeds.entropyHex[{idx}] MUST be "
                "exactly 32 hexadecimal characters."
            )
    return value


def _uuid_seed(seeds, case_name):
    """Return an optional canonical lowercase hyphenated UUID seed."""
    if "uuid" not in seeds:
        return None
    value = seeds["uuid"]
    if (
        not isinstance(value, str)
        or re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            value,
        ) is None
    ):
        raise SystemExit(
            f"ERROR: case {case_name!r} seeds.uuid MUST be a canonical "
            "lowercase hyphenated UUID."
        )
    try:
        parsed = uuid.UUID(value)
    except ValueError as err:
        raise SystemExit(
            f"ERROR: case {case_name!r} seeds.uuid is not a valid UUID."
        ) from err
    if str(parsed) != value:
        raise SystemExit(
            f"ERROR: case {case_name!r} seeds.uuid MUST round-trip canonically."
        )
    return value


def _pushover_e2ee_requested(case, plugin):
    """Return whether a case requests valid-key Pushover E2EE.

    Invalid keys are construction-negative cases, not executable E2EE cases.
    An omitted/blank e2ee value preserves upstream's default-on behaviour.
    """
    if plugin != "pushover":
        return False
    query = case.get("url", "").partition("?")[2]
    qsd = urllib.parse.parse_qs(query, keep_blank_values=True)
    key = (qsd.get("key") or [""])[-1]
    if re.fullmatch(r"[0-9a-fA-F]{64}", key) is None:
        return False
    e2ee = (qsd.get("e2ee") or [""])[-1].strip().lower()
    return e2ee not in {"0", "false", "f", "no", "n", "off"}


@contextlib.contextmanager
def pin_pushover_entropy(entropy_hex, case_name):
    """Temporarily replace Pushover's ``_os.urandom`` with a strict queue."""
    if entropy_hex is None:
        yield
        return

    module = importlib.import_module("apprise.plugins.pushover")
    original = module._os.urandom
    queue = [bytes.fromhex(seed) for seed in entropy_hex]

    def strict_urandom(size):
        if isinstance(size, bool) or size != 16:
            raise RuntimeError(
                f"Pushover entropy seam only accepts 16-byte requests; got {size!r}."
            )
        if not queue:
            raise RuntimeError(
                f"Pushover entropy queue exhausted in case {case_name!r}."
            )
        return queue.pop(0)

    module._os.urandom = strict_urandom
    completed = False
    try:
        yield
        completed = True
    finally:
        module._os.urandom = original
        if completed and queue:
            raise RuntimeError(
                f"Pushover entropy queue has {len(queue)} unconsumed seed(s) "
                f"in case {case_name!r}."
            )


def _request_has_encrypted_flag(request):
    """Return whether a prepared form/multipart request carries encrypted=1."""
    body = request.body
    if isinstance(body, str):
        fields = urllib.parse.parse_qs(body, keep_blank_values=True)
        return fields.get("encrypted") == ["1"]
    if isinstance(body, bytes):
        return b'name="encrypted"\r\n\r\n1\r\n' in body
    return False


def _assert_multipart_boundary(captured, boundary, case_name):
    """Require every captured multipart case to pin a non-empty boundary."""
    has_multipart = any(
        any(
            key.lower() == "content-type"
            and value.lower().startswith("multipart/form-data")
            for key, value in request.headers.items()
        )
        for request in captured
    )
    if has_multipart and (not isinstance(boundary, str) or not boundary):
        raise SystemExit(
            f"ERROR: multipart case {case_name!r} MUST declare a non-empty "
            "seeds.boundary."
        )


@contextlib.contextmanager
def pin_dingtalk_time(timestamp_ms):
    """Temporarily make upstream DingTalk's time.time() return pinned seconds."""
    if timestamp_ms is None:
        yield
        return
    module = importlib.import_module("apprise.plugins.dingtalk")
    original = module.time.time
    module.time.time = lambda: timestamp_ms / 1000.0
    try:
        yield
    finally:
        module.time.time = original


@contextlib.contextmanager
def intercept(boundary=None, responses=None, uuid_seed=None):
    """Patch the adapter layer to capture PreparedRequests without network I/O.

    The i-th captured request gets ``responses[i]`` as its canned response (see
    ``_fake_response``); beyond that list it falls back to the default 200 `{}`.
    Optionally pin the multipart boundary and ``uuid.uuid4`` (matrix raw-token
    txnId). Everything is restored on exit.
    """
    captured = []
    responses = responses or []
    orig_send = requests.adapters.HTTPAdapter.send

    def patched_send(self, request, **kwargs):  # noqa: ARG001
        idx = len(captured)
        captured.append(request)
        spec = responses[idx] if idx < len(responses) else None
        return _fake_response(request, spec)

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

    # Pin matrix raw-token txnId: force uuid.uuid4() to a fixed value (same
    # approach as the boundary pin above) so the captured `PUT .../send/{txnId}`
    # URL is deterministic. Restored on exit.
    orig_uuid4 = None
    if uuid_seed is not None:
        import uuid as _uuid

        orig_uuid4 = _uuid.uuid4
        _uuid.uuid4 = lambda: _uuid.UUID(uuid_seed)

    try:
        yield captured
    finally:
        requests.adapters.HTTPAdapter.send = orig_send
        if orig_boundary is not None:
            import urllib3.filepost as _fp

            _fp.choose_boundary = orig_boundary
        if orig_uuid4 is not None:
            import uuid as _uuid

            _uuid.uuid4 = orig_uuid4


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


def capture_case(case, plugin):
    """Drive one case through upstream apprise; return its fixture entry."""
    seeds = case.get("seeds") or {}
    uid = seeds.get("uid", DEFAULT_UID)
    recursion = seeds.get("recursion", DEFAULT_RECURSION)
    boundary = seeds.get("boundary")
    uuid_seed = _uuid_seed(seeds, case["name"])
    timestamp_ms = _timestamp_ms(seeds, case["name"])
    entropy_hex = _entropy_hex(seeds, case["name"])
    pushover_e2ee = _pushover_e2ee_requested(case, plugin)
    if pushover_e2ee and entropy_hex is None:
        raise SystemExit(
            f"ERROR: Pushover E2EE case {case['name']!r} MUST declare "
            "seeds.entropyHex."
        )
    if pushover_e2ee:
        module = importlib.import_module("apprise.plugins.pushover")
        if not module.PUSHOVER_E2EE_SUPPORT:
            raise SystemExit(
                f"ERROR: Pushover E2EE case {case['name']!r} requires the "
                "upstream 'cryptography' dependency; refusing plaintext capture."
            )

    attachments = case.get("attachments") or []
    # Per-request canned responses for multi-step plugins (login/send/...).
    responses = _validate_responses(case.get("responses"), case["name"])
    has_assert_result = "assertResult" in case
    assert_result = case.get("assertResult")
    if has_assert_result and not isinstance(assert_result, bool):
        raise SystemExit(
            f"ERROR: case {case['name']!r} assertResult MUST be boolean."
        )
    if plugin in RESULT_REQUIRED_PLUGINS and not has_assert_result:
        raise SystemExit(
            f"ERROR: result-required plugin case {case['name']!r} MUST declare "
            "assertResult."
        )

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
    if responses:
        # Echoed so the TS diff side replays the SAME per-request responses.
        input_echo["responses"] = responses
    if has_assert_result:
        input_echo["assertResult"] = assert_result

    # Backward-compatible seeds block: only add txn/uuid when the case declares
    # them, so existing single-request fixtures stay byte-identical.
    seeds_echo = {"uid": uid, "recursion": recursion, "boundary": boundary}
    if "txn" in seeds:
        seeds_echo["txn"] = seeds.get("txn", 0)
    if "uuid" in seeds:
        seeds_echo["uuid"] = uuid_seed
    if "timestampMs" in seeds:
        seeds_echo["timestampMs"] = timestamp_ms
    if "entropyHex" in seeds:
        seeds_echo["entropyHex"] = entropy_hex

    entry = {
        "name": case["name"],
        "input": input_echo,
        "seeds": seeds_echo,
    }

    if not added or len(ap) == 0:
        # Upstream rejected construction (e.g. invalid ?method=, bad token).
        if responses:
            raise SystemExit(
                f"ERROR: case {case['name']!r} declared {len(responses)} "
                "response preset(s) but constructed no request producer."
            )
        if plugin in RESULT_REQUIRED_PLUGINS and assert_result is not False:
            raise SystemExit(
                f"ERROR: instantiation-failed result-required case {case['name']!r} "
                "MUST set assertResult=false."
            )
        entry["expected"] = {"noRequest": {"reason": "instantiation-failed"}}
        return entry

    if plugin in RESULT_REQUIRED_PLUGINS and assert_result is not True:
        raise SystemExit(
            f"ERROR: constructed result-required case {case['name']!r} "
            "MUST set assertResult=true."
        )

    attach = build_attach(attachments)
    with pin_dingtalk_time(timestamp_ms):
        with pin_pushover_entropy(
            entropy_hex if pushover_e2ee else None, case["name"]
        ):
            with intercept(
                boundary=boundary, responses=responses, uuid_seed=uuid_seed
            ) as captured:
                result = ap.notify(
                    body=body,
                    title=case.get("title", ""),
                    notify_type=apprise.NotifyType(case.get("type", "info")),
                    attach=attach,
                )

    if pushover_e2ee and (
        not captured
        or any(not _request_has_encrypted_flag(request) for request in captured)
    ):
        raise SystemExit(
            f"ERROR: Pushover E2EE case {case['name']!r} produced wire without "
            "encrypted=1; refusing plaintext capture."
        )

    _assert_multipart_boundary(captured, boundary, case["name"])

    if len(captured) < len(responses):
        raise SystemExit(
            f"ERROR: case {case['name']!r} left response preset index "
            f"{len(captured)} unconsumed ({len(responses)} declared, "
            f"{len(captured)} request(s))."
        )

    # Author-declared oracle: a multi-request case states how many requests it
    # SHOULD make. Check it against the ACTUAL capture BEFORE writing anything. A
    # malformed canned response that short-circuits the sequence would otherwise
    # yield a self-consistent (captured == stored) short fixture; an independent,
    # hand-authored count turns that false-green into a hard failure.
    declared_count = case.get("expectedCount")
    if declared_count is not None and len(captured) != declared_count:
        raise SystemExit(
            f"ERROR: case {case['name']!r} declared expectedCount="
            f"{declared_count} but upstream produced {len(captured)} request(s); "
            "refusing to write a truncated/self-consistent fixture."
        )

    if not captured:
        # Constructed fine but produced no request (e.g. empty content).
        entry["expected"] = {"noRequest": {"reason": "no-request"}}
        if assert_result is True:
            entry["expected"]["result"] = bool(result)
        return entry

    if len(captured) == 1:
        # Single-request form (backward-compatible with core-foundation).
        entry["expected"] = {"request": dump_request(captured[0])}
    else:
        # Multi-request form: ordered sequence + independent count oracle so a
        # truncated (short-circuited) capture cannot pass by mutual agreement.
        entry["expected"] = {
            "requests": [dump_request(r) for r in captured],
            "expectedCount": len(captured),
        }
    if assert_result is True:
        entry["expected"]["result"] = bool(result)
    return entry


def process_plugin(plugin):
    case_file = CASES_DIR / f"{plugin}.json"
    spec = json.loads(case_file.read_text())
    fixture_plugin = spec.get("plugin", plugin)
    fixture = {
        "plugin": fixture_plugin,
        "generated_by": "scripts/capture_fixtures.py",
        "apprise_version": apprise.__version__,
        "cases": [capture_case(c, fixture_plugin) for c in spec["cases"]],
    }
    out = FIXTURES_DIR / f"{plugin}.json"
    out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    n_req = sum(
        "request" in c["expected"] or "requests" in c["expected"]
        for c in fixture["cases"]
    )
    n_no = len(fixture["cases"]) - n_req
    print(f"{plugin}: {len(fixture['cases'])} cases -> {out.relative_to(ROOT)} "
          f"({n_req} request, {n_no} noRequest)")


# --------------------------------------------------------------------------- #
# url() sidecar oracle (change `url-serialization-anchors`, task group 1)
#
# A SEPARATE sidecar `fixtures/url-oracle.json` — NEVER a wire fixture. url() is a
# pure read, so we drive it for every case whose instance CONSTRUCTS (only
# construction failures are skipped, not every "no wire request" case). We iterate
# the union of two case sources, both fed to url() only (never wire capture):
#   * cases/<plugin>.json            (the wire matrix; reused for url() coverage)
#   * cases/url-oracle/<plugin>.json (url()-only seeds for uncovered keys)
# (plugin, caseName) MUST be globally unique across both sources or a sidecar
# entry would silently overwrite / mis-pair the D4 two-stage capture.
# --------------------------------------------------------------------------- #


def _instance(url, uid=DEFAULT_UID, recursion=DEFAULT_RECURSION):
    """Construct one plugin instance from `url` with the SAME determinism pins as
    the wire capture (`_uid`/`_recursion`), or None if upstream rejects it. url()
    is asset-independent for these plugins, but pinning keeps the sidecar byte-
    reproducible regardless."""
    asset = apprise.AppriseAsset()
    asset._uid = uid
    asset._recursion = recursion
    ap = apprise.Apprise(asset=asset)
    if not ap.add(url) or len(ap) == 0:
        return None
    return ap[0]


def url_oracle_entry(seed_url, uid, recursion):
    """Capture url()/url(privacy=True) + the two-stage re-serialization for one
    seed, or None when the seed fails to construct (the ONLY skip condition).

    `reserialize` = ``[stage1, stage2]`` is upstream's own
    ``parse -> url() -> parse -> url()`` (D4): stage1 == `url` (parse(seed).url());
    stage2 re-parses stage1 through upstream's real `add()` pipeline (which applies
    the same '#channel' handling) and calls url() again. Both parses MUST be
    non-null, mirroring D4's guard."""
    inst = _instance(seed_url, uid, recursion)
    if inst is None:
        return None
    stage1 = inst.url()
    priv = inst.url(privacy=True)
    reinst = _instance(stage1, uid, recursion)
    if reinst is None:
        raise SystemExit(
            "ERROR: upstream re-parse of stage-1 url() failed (D4 needs both "
            f"parses non-null):\n  seed={seed_url!r}\n  stage1={stage1!r}"
        )
    stage2 = reinst.url()
    return {"url": stage1, "urlPrivacy": priv, "reserialize": [stage1, stage2]}


def _load_cases(path):
    return json.loads(path.read_text())["cases"] if path.exists() else []


def _validate_url_oracle_seed(case, plugin):
    """Keep url()-only seeds free of notify-result expectations."""
    expected = case.get("expected")
    if not isinstance(expected, dict):
        expected = {}
    if (
        "assertResult" in case
        or "expected.result" in case
        or "result" in expected
    ):
        raise SystemExit(
            "ERROR: url-oracle-only seed MUST NOT declare result fields: "
            f"({plugin!r}, {case['name']!r})."
        )


def _query_keys(url):
    """Decoded query-parameter names per the D1 split: base = up to the first
    '?', query = after it. Split on the first '?' (NOT urlsplit) so rocketchat's
    literal '#channel' in the BASE is not mis-parsed as a fragment that would
    hide the query. `parse_qsl` decodes keys, so '%2BX'->'+X', '%3A2'->':2', and
    the '+'/'-'/':' prefix families are detectable transparently."""
    if "?" not in url:
        return []
    query = url.split("?", 1)[1]
    return [k for k, _ in urllib.parse.parse_qsl(query, keep_blank_values=True)]


def _assert_inventory_covered(oracle):
    """Fail closed if any declared conditional key is never activated by a
    captured case — otherwise its serialization would ship uncompared (task 1.3
    mechanical assertion)."""
    for plugin, inv in URL_KEY_INVENTORY.items():
        seen = set()
        for entry in oracle.get(plugin, {}).values():
            seen.update(_query_keys(entry["url"]))
        for key in inv["conditional"]:
            if key in ("+", "-", ":"):
                ok = any(k.startswith(key) for k in seen)
            else:
                ok = key in seen
            if not ok:
                raise SystemExit(
                    f"ERROR: plugin {plugin!r} conditional key {key!r} never "
                    "appears in any captured url() — no case activates it, so its "
                    "serialization would ship uncompared. Add a url-oracle seed "
                    f"under {URL_ORACLE_CASES_DIR.relative_to(ROOT)}/{plugin}.json."
                )


def capture_url_oracle():
    """Build and write `fixtures/url-oracle.json` over all in-scope plugins."""
    oracle = {}
    # URL_KEY_INVENTORY's keys ARE the 10 in-scope plugins, insertion-ordered;
    # iterating it here fixes the sidecar's plugin key order (`_multireq_smoke`
    # is a synthetic wire-only smoke with no url() inventory, so it is absent by
    # design).
    for plugin in URL_KEY_INVENTORY:
        entries = {}
        seen = set()
        wire_cases = _load_cases(CASES_DIR / f"{plugin}.json")
        extra_cases = _load_cases(URL_ORACLE_CASES_DIR / f"{plugin}.json")
        # `curated=True` marks the hand-authored url-oracle source: its seeds
        # MUST always construct, so a construction failure there fails LOUD
        # (below) instead of silently shrinking coverage. Wire cases may
        # legitimately reject (e.g. invalid-method/invalid-token) and stay
        # skipped.
        for cases, curated in ((wire_cases, False), (extra_cases, True)):
            for case in cases:
                name = case["name"]
                if curated:
                    _validate_url_oracle_seed(case, plugin)
                # Track (plugin, caseName) uniqueness BEFORE construction so a
                # duplicate is caught even when the first of the pair fails to
                # construct (design.md D2). `entries` alone would miss that.
                if name in seen:
                    raise SystemExit(
                        "ERROR: duplicate (plugin, caseName) across sources: "
                        f"({plugin!r}, {name!r}). Sidecar keys MUST be globally "
                        "unique (rename the url-oracle seed)."
                    )
                seen.add(name)
                seeds = case.get("seeds") or {}
                entry = url_oracle_entry(
                    case["url"],
                    seeds.get("uid", DEFAULT_UID),
                    seeds.get("recursion", DEFAULT_RECURSION),
                )
                if entry is None:
                    if curated:
                        raise SystemExit(
                            "ERROR: curated url-oracle seed failed to construct: "
                            f"({plugin!r}, {name!r}). Hand-authored "
                            f"{URL_ORACLE_CASES_DIR.relative_to(ROOT)}/"
                            f"{plugin}.json seeds MUST always construct — fix the "
                            "seed URL (only wire cases may legitimately reject)."
                        )
                    continue  # wire cases may legitimately reject
                entries[name] = entry
        oracle[plugin] = entries

    _assert_inventory_covered(oracle)

    sidecar = {
        "_source": (
            "apprise==1.12.0 plugin.url() / url(privacy=True) + two-stage "
            "re-serialization (parse->url()->parse->url())"
        ),
        "_note": (
            "sidecar oracle for url() serialization (NOT a wire fixture; wire "
            "fixtures stay byte-identical). Keyed by (plugin, caseName) over the "
            "union of cases/<plugin>.json (url() only) and "
            "cases/url-oracle/<plugin>.json (url()-only source). reserialize="
            "[stage1, stage2] is upstream parse->url()->parse->url() for D4. In "
            "inventory, a bare '+'/'-'/':' conditional entry is the custom "
            "prefix-mapping FAMILY, not a literal key."
        ),
        "apprise_version": apprise.__version__,
        "inventory": URL_KEY_INVENTORY,
        "oracle": oracle,
    }
    URL_ORACLE_OUT.write_text(
        json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    total = sum(len(v) for v in oracle.values())
    print(
        f"url-oracle: {total} cases across {len(oracle)} plugins -> "
        f"{URL_ORACLE_OUT.relative_to(ROOT)}"
    )


def main(argv):
    if apprise.__version__ != EXPECTED_APPRISE_VERSION:
        # Fail closed: a different upstream version would silently capture
        # drifted golden bytes. Refuse rather than overwrite the fixtures.
        print(f"ERROR: apprise {apprise.__version__} != pinned "
              f"{EXPECTED_APPRISE_VERSION}; refusing to (re)capture fixtures.",
              file=sys.stderr)
        return 1

    if argv:
        plugins = argv
    else:
        plugins = sorted(p.stem for p in CASES_DIR.glob("*.json"))
    if not plugins:
        print("no cases/*.json found", file=sys.stderr)
        return 1

    for plugin in plugins:
        process_plugin(plugin)

    # The url() sidecar is a single consolidated oracle over all in-scope
    # plugins; always regenerate it in full (deterministic, byte-reproducible)
    # so a targeted `capture_fixtures.py <plugin>` run never leaves it partial.
    capture_url_oracle()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
