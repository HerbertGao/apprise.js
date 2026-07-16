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

    def test_entropy_hex_schema_is_strict_and_generic(self):
        seeds = [
            "00112233445566778899aabbccddeeff",
            "FFEEDDCCBBAA99887766554433221100",
        ]
        self.assertIs(capture._entropy_hex({"entropyHex": seeds}, "ok"), seeds)
        self.assertIsNone(capture._entropy_hex({}, "absent"))
        for value in (
            "00112233445566778899aabbccddeeff",
            ["0011"],
            ["g" * 32],
            [1],
        ):
            with self.subTest(value=value):
                with self.assertRaises(SystemExit):
                    capture._entropy_hex({"entropyHex": value}, "bad")

    def test_uuid_seed_requires_canonical_lowercase_hyphenated_form(self):
        canonical = "00112233-4455-6677-8899-aabbccddeeff"
        self.assertEqual(capture._uuid_seed({"uuid": canonical}, "ok"), canonical)
        self.assertIsNone(capture._uuid_seed({}, "absent"))
        for value in (
            canonical.upper(),
            canonical.replace("-", ""),
            "{" + canonical + "}",
            "not-a-uuid",
        ):
            with self.subTest(value=value):
                with self.assertRaises(SystemExit):
                    capture._uuid_seed({"uuid": value}, "bad")

        module = __import__("uuid")
        original = module.uuid4
        with capture.intercept(uuid_seed=canonical):
            self.assertEqual(str(module.uuid4()), canonical)
        self.assertIs(module.uuid4, original)

    def test_pushover_entropy_queue_is_strict_and_restored(self):
        module = __import__("apprise.plugins.pushover", fromlist=["_os"])
        original = module._os.urandom
        seed = "00112233445566778899aabbccddeeff"

        with capture.pin_pushover_entropy([seed], "ok"):
            self.assertEqual(module._os.urandom(16), bytes.fromhex(seed))
        self.assertIs(module._os.urandom, original)

        with self.assertRaisesRegex(RuntimeError, "only accepts 16-byte"):
            with capture.pin_pushover_entropy([seed], "wrong-size"):
                module._os.urandom(8)
        self.assertIs(module._os.urandom, original)

        with self.assertRaisesRegex(RuntimeError, "exhausted"):
            with capture.pin_pushover_entropy([], "exhausted"):
                module._os.urandom(16)
        self.assertIs(module._os.urandom, original)

        with self.assertRaisesRegex(RuntimeError, "unconsumed"):
            with capture.pin_pushover_entropy([seed], "leftover"):
                pass
        self.assertIs(module._os.urandom, original)

    def test_pushover_e2ee_detection_and_wire_guard(self):
        key = "ab" * 32
        self.assertTrue(
            capture._pushover_e2ee_requested(
                {"url": f"pover://user@token/?key={key}"}, "pushover"
            )
        )
        self.assertFalse(
            capture._pushover_e2ee_requested(
                {"url": f"pover://user@token/?key={key}&e2ee=no"},
                "pushover",
            )
        )
        self.assertFalse(
            capture._pushover_e2ee_requested(
                {"url": "pover://user@token/?key=bad"}, "pushover"
            )
        )
        self.assertFalse(
            capture._pushover_e2ee_requested(
                {"url": f"pover://user@token/?key={key}"}, "gotify"
            )
        )

        form = mock.Mock(body="token=t&encrypted=1&message=x")
        multipart = mock.Mock(
            body=b'Content-Disposition: form-data; name="encrypted"\r\n\r\n1\r\n'
        )
        plain = mock.Mock(body="token=t&message=x")
        self.assertTrue(capture._request_has_encrypted_flag(form))
        self.assertTrue(capture._request_has_encrypted_flag(multipart))
        self.assertFalse(capture._request_has_encrypted_flag(plain))

        module = __import__("apprise.plugins.pushover", fromlist=["_"])
        with mock.patch.object(module, "PUSHOVER_E2EE_SUPPORT", False):
            with self.assertRaisesRegex(SystemExit, "requires.*cryptography"):
                capture.capture_case(
                    {
                        "name": "missing-crypto",
                        "url": f"pover://user@token/?key={key}",
                        "assertResult": True,
                        "seeds": {"entropyHex": ["00" * 16, "11" * 16]},
                    },
                    "pushover",
                )

    def test_multipart_boundary_is_required_and_restored(self):
        multipart = mock.Mock(
            headers={"Content-Type": "multipart/form-data; boundary=fixed"}
        )
        capture._assert_multipart_boundary([multipart], "fixed", "ok")
        for boundary in (None, ""):
            with self.assertRaisesRegex(SystemExit, "seeds.boundary"):
                capture._assert_multipart_boundary(
                    [multipart], boundary, "missing"
                )

        filepost = __import__("urllib3.filepost", fromlist=["choose_boundary"])
        original = filepost.choose_boundary
        with capture.intercept(boundary="fixed"):
            self.assertEqual(filepost.choose_boundary(), "fixed")
        self.assertIs(filepost.choose_boundary, original)

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
