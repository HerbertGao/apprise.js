#!/usr/bin/env python3
# BSD 2-Clause License
#
# Copyright (c) 2026, Chris Caron <lead2gold@gmail.com> (upstream apprise, BSD-2)
# Copyright (c) 2026, apprise.js contributors.
#
# Derived from / drives caronc/apprise v1.12.0. Redistribution and use per the
# BSD 2-Clause terms carried by upstream apprise.
#
# Reverse-completeness sweep for the url() oracle (dev-only; apprise==1.12.0).
#
# `_assert_inventory_covered` (capture_fixtures.py) enforces declared ⊆ effective:
# every DECLARED conditional key must be activated by >=1 seed. This tool enforces
# the OTHER direction — effective ⊆ declared: no upstream-emitted url() key escapes
# (inventory ∪ D). That reverse gap is exactly how `tags`/`template`/`attach-as`
# each shipped uncompared until a review round caught them by hand; running this
# when a plugin or query arg is added catches the next such sibling up front.
#
# Per plugin it activates each `template_args` key across BOTH the arg's own declared
# choice `values` AND a generic non-default list, UNIONing every emitted key (never
# stopping at first construction — a choice arg emits different keys per value, e.g.
# matrix mode=off vs mode=hookshot→`path`), and reports any emitted key family not in
# (inventory ∪ D). Best-effort, not a proof: an arg whose emitting value is in neither
# list stays unseen (bounded — it can only miss an *undeclared* key, and the running
# rule-2 / _assert_inventory_covered teeth still cover every SEEDED key).
#
# A flag is a real NEW sibling only if TS also CONSTRUCTS with that key. Known-safe
# residue, encoded in EXPECTED below: discord/slack `:{k}` (the deferred template-
# token store `self.tokens`, serialized `%3A<name>`; can't join D — collides with the
# custom plugins' implemented `:payload` that TS emits), mattermost `mode` (only `bot`
# emits it, TS ctor-rejects it), matrix `path` (only hookshot mode emits it, TS ctor-
# rejects every non-`off` mode). slack `template` never appears as residue — it is in
# D, subtracted at `declared`. Exit 0 = complete, 1 = new gap.
#
#   scripts/.venv/bin/python scripts/url_key_completeness_sweep.py   # from packages/apprise.js
import json
import re
import sys
from pathlib import Path

import apprise

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "url-oracle.json"
INV = json.loads(FIXTURES.read_text())["inventory"]

# design.md D1's D — the deferred-key set. Keep in sync with url-oracle.test.ts.
D = {
    "retry", "wait", "optional", "store", "tz", "redirect",
    "tags", "template", "attach-as",  # the 3 constructible plugin-specific siblings
}

# One valid base URL per in-scope plugin (token/room formats from the wire cases).
BASES = {
    "discord": "discord://webhook_id/webhook_token",
    "slack": "slack://T1JJ3CZ57/A2SGZ4B48/aBcDeFgHiJkLmNoPqRsTuVwX/%23general",
    "telegram": "tgram://123456789:abcdefghijklmnopqrstuvwxyz012345678/12345",
    "mattermost": "mmost://user@localhost/abcdef01234567890123456789012",
    "rocketchat": "rocket://user:pass@localhost/%23channel",
    "matrix": "matrix://user:password@matrix.example.com/%23room",
    "apprise-api": "apprise://localhost/token123",
    "custom-json": "json://localhost/",
    "custom-form": "form://localhost/",
    "custom-xml": "xml://localhost/",
    "serverchan": "schan://abcdefgh",
    "dingtalk": "dingtalk://abcdefgh",
    "wecombot": "wecombot://botkey",
    "feishu": "feishu://abc123",
    "lark": "lark://abcd-1234",
    "wxpusher": "wxpusher://AT_appid/UID_alice",
    "pushdeer": "pushdeer://pushKey",
}

# Known-safe residue (each verified on both sides): discord/slack `:{k}` %3A boundary;
# mattermost `mode` (only `bot` emits it upstream, TS ctor-rejects it); matrix `path`
# (only hookshot mode emits it, TS ctor-rejects every non-`off` mode). A plugin whose
# residue differs from its list here (missing OR extra family) exits 1.
EXPECTED = {"discord": [":"], "slack": [":"], "mattermost": ["mode"], "matrix": ["path"]}

NONDEF = ["zzz", "2", "no", "yes", "5", "markdown", "custom", "99", "invoice", "bot"]
SKIP_ARGS = {"verify", "format", "overflow", "password", "user", "host", "port"}


def key_families(url):
    """Emitted query keys, prefix-mapped: `%3Afoo`/`+H`/`-P` collapse to `:`/`+`/`-`."""
    query = url.split("?", 1)[1] if "?" in url else ""
    families = set()
    for key in re.findall(r"([^=&]+)=", query):
        decoded = key.replace("%2B", "+").replace("%2D", "-").replace("%3A", ":")
        families.add(decoded[0] if decoded and decoded[0] in "+-:" else decoded)
    return families


def sweep():
    gaps = {}
    for plugin, base in BASES.items():
        base_inst = apprise.Apprise.instantiate(base)
        declared = set(INV[plugin]["static"]) | set(INV[plugin]["conditional"]) | D
        found = set()
        for arg, meta in getattr(base_inst, "template_args", {}).items():
            if arg in SKIP_ARGS:
                continue
            # Try the arg's own declared choice values AND generic non-defaults, and
            # UNION every emitted key — do NOT stop at first construction: a choice arg
            # emits different keys per value (matrix mode=off vs mode=hookshot→`path`),
            # so a first-constructible break would miss the value that emits the sibling.
            for value in list(meta.get("values") or ()) + NONDEF:
                inst = apprise.Apprise.instantiate(f"{base}?{arg}={value}")
                if inst is not None:
                    found |= key_families(inst.url()) - declared
        for extra in ("+H=v", "-P=w", ":k=v", "attach-as=doc", "template=t", "tags=x"):
            inst = apprise.Apprise.instantiate(f"{base}?{extra}")
            if inst is not None:
                found |= key_families(inst.url()) - declared
        if found:
            gaps[plugin] = sorted(found)
        print(f"  {plugin:12} {'GAP=' + str(sorted(found)) if found else 'covered'}")
    return gaps


def main():
    if apprise.__version__ != "1.12.0":
        print(f"ERROR: apprise {apprise.__version__} != pinned 1.12.0", file=sys.stderr)
        return 1
    # Tool-hollow guard: if a later batch adds a plugin to the fixture inventory but
    # forgets BASES (or vice versa), the sweep would silently never check it and still
    # exit 0 — the exact hollowing this tool exists to prevent. Fail closed on drift.
    if set(BASES) != set(INV):
        print(f"ERROR: BASES vs inventory plugin-set mismatch: {set(BASES) ^ set(INV)}",
              file=sys.stderr)
        return 1
    gaps = sweep()
    # Compare over the UNION of produced + expected plugins so a VANISHED expected
    # residue (a plugin in EXPECTED that stops emitting its known-safe family) also
    # fails — not just extra/mismatched families on plugins that still produce one.
    unexpected = {
        p: gaps.get(p, [])
        for p in set(gaps) | set(EXPECTED)
        if gaps.get(p, []) != sorted(EXPECTED.get(p, []))
    }
    if unexpected:
        print(f"\nNEW SIBLING(S) — investigate (add to D + seed, or exclude): {unexpected}",
              file=sys.stderr)
        return 1
    print("\nComplete: every emitted key in (inventory ∪ D); residue is known-safe "
          "(discord/slack `:` template-token store + mattermost `mode=bot` + matrix "
          "`path`, all construct-rejected or deferred). No new sibling.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
