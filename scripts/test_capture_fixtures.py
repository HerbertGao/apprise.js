#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-2-Clause
"""Focused unit checks for the golden capture schema and determinism seams."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("capture_fixtures.py")
SPEC = importlib.util.spec_from_file_location("capture_fixtures", MODULE_PATH)
capture = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(capture)


class FakeAsset:
    pass


class FakeApprise:
    added = True

    def __init__(self, asset=None):  # noqa: ARG002
        pass

    def add(self, url):  # noqa: ARG002
        return self.added

    def __len__(self):
        return 1 if self.added else 0

    def notify(self, **kwargs):  # noqa: ARG002
        return False


class CaptureFixtureTest(unittest.TestCase):
    def test_process_plugin_uses_effective_plugin_for_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases_dir = root / "cases"
            fixtures_dir = root / "fixtures"
            cases_dir.mkdir()
            fixtures_dir.mkdir()
            with (
                mock.patch.object(capture, "ROOT", root),
                mock.patch.object(capture, "CASES_DIR", cases_dir),
                mock.patch.object(capture, "FIXTURES_DIR", fixtures_dir),
            ):
                for stem, fixture_plugin in (
                    ("json", "serverchan"),
                    ("serverchan", "json"),
                ):
                    with self.subTest(stem=stem, fixture_plugin=fixture_plugin):
                        case = {"name": "override"}
                        (cases_dir / f"{stem}.json").write_text(
                            json.dumps(
                                {"plugin": fixture_plugin, "cases": [case]}
                            )
                        )
                        with mock.patch.object(
                            capture,
                            "capture_case",
                            return_value={
                                "expected": {
                                    "noRequest": {"reason": "no-request"}
                                }
                            },
                        ) as capture_case:
                            capture.process_plugin(stem)
                        capture_case.assert_called_once_with(case, fixture_plugin)
                        fixture = json.loads(
                            (fixtures_dir / f"{stem}.json").read_text()
                        )
                        self.assertEqual(fixture["plugin"], fixture_plugin)

    def test_timestamp_domain_and_time_restore(self):
        self.assertEqual(capture._timestamp_ms({"timestampMs": 0}, "c"), 0)
        self.assertEqual(
            capture._timestamp_ms(
                {"timestampMs": capture.MAX_TIMESTAMP_MS}, "c"
            ),
            capture.MAX_TIMESTAMP_MS,
        )
        for value in (-1, 1.5, True, capture.MAX_TIMESTAMP_MS + 1):
            with self.assertRaises(SystemExit):
                capture._timestamp_ms({"timestampMs": value}, "bad")

        module = __import__("apprise.plugins.dingtalk", fromlist=["time"])
        original = module.time.time
        with self.assertRaisesRegex(RuntimeError, "boom"):
            with capture.pin_dingtalk_time(1_700_000_000_123):
                self.assertEqual(module.time.time(), 1_700_000_000.123)
                raise RuntimeError("boom")
        self.assertIs(module.time.time, original)

    def test_canned_response_closed_schema(self):
        valid = [
            {"status": 200, "headers": {"X": "Y"}, "body": {"text": "{}"}},
            {"body": {"base64": "AA=="}},
            {"body": None},
        ]
        self.assertIs(capture._validate_responses(valid, "valid"), valid)
        for invalid in (
            {"status": 200},
            [{"extra": True}],
            [{"status": True}],
            [{"headers": {"X": 1}}],
            [{"body": {"text": "x", "base64": "eA=="}}],
        ):
            with self.assertRaises(SystemExit):
                capture._validate_responses(invalid, "bad")

    def test_unconsumed_response_and_result_contract(self):
        case = {
            "name": "unused",
            "url": "serverchan://token",
            "body": "body",
            "assertResult": True,
            "responses": [{"status": 200}],
        }
        with (
            mock.patch.object(capture.apprise, "AppriseAsset", FakeAsset),
            mock.patch.object(capture.apprise, "Apprise", FakeApprise),
            mock.patch.object(capture.apprise, "NotifyType", lambda value: value),
        ):
            with self.assertRaisesRegex(SystemExit, "response preset index 0"):
                capture.capture_case(case, "serverchan")

            no_response = {**case, "responses": []}
            entry = capture.capture_case(no_response, "serverchan")
            self.assertEqual(entry["expected"]["result"], False)
            self.assertEqual(
                entry["expected"]["noRequest"]["reason"], "no-request"
            )

    def test_url_oracle_seed_result_fields_are_rejected(self):
        capture._validate_url_oracle_seed({"name": "plain"}, "serverchan")
        for extra in (
            {"assertResult": True},
            {"expected.result": True},
            {"expected": {"result": True}},
        ):
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(
                    SystemExit, "MUST NOT declare result fields"
                ):
                    capture._validate_url_oracle_seed(
                        {"name": "bad", **extra}, "serverchan"
                    )


if __name__ == "__main__":
    unittest.main()
