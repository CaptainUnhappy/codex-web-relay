"""Exercise release packaging and keep private runtime state out of archives."""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package-release.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PrivateStatePackagingTest(unittest.TestCase):
    def test_desktop_release_checksums_exclude_existing_server_archive(self):
        with tempfile.TemporaryDirectory(prefix="codex-relay-desktop-release-") as directory:
            output = Path(directory) / package.DESKTOP_OUTPUT
            checksums = Path(directory) / "SHA256SUMS"
            server = Path(directory) / package.SERVER_OUTPUT
            server.write_bytes(b"existing local server archive")
            self.assertEqual(package.main([
                "desktop", "--public", "--output", str(output), "--checksums", str(checksums)
            ]), 0)
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            self.assertEqual(checksums.read_text(), f"{digest}  {package.DESKTOP_OUTPUT}\n")
            self.assertEqual(server.read_bytes(), b"existing local server archive")

    def test_public_release_does_not_embed_environment_key(self):
        with tempfile.TemporaryDirectory(prefix="codex-relay-public-test-") as directory:
            args = argparse.Namespace(output=str(Path(directory) / package.DESKTOP_OUTPUT),
                                      registration_key=None, env_file=None, public=True)
            secret = "fixture-private-registration-key-do-not-publish"
            with patch.dict(os.environ, {"CODEX_MINI_RELAY_REGISTRATION_KEY": secret}):
                output = package.build_desktop(args, package.repo_root())
            with zipfile.ZipFile(output) as archive:
                self.assertFalse(any(secret.encode() in archive.read(name) for name in archive.namelist()))
                self.assertIn(package.PLACEHOLDER.encode(), archive.read("scripts/start-windows-relay.ps1"))
                self.assertIn("desktop-env.example.ps1", archive.namelist())
                self.assertIn("start-codex-relay.command", archive.namelist())
            args.output = str(Path(directory) / package.SERVER_OUTPUT)
            package.build_server(args, package.repo_root())
            with zipfile.ZipFile(args.output) as archive:
                self.assertIn("LICENSE", archive.namelist())
                self.assertIsNone(archive.testzip())

    def test_public_mode_rejects_explicit_key_input(self):
        with self.assertRaises(package.PackageError):
            package.registration_key(argparse.Namespace(public=True, registration_key="fixture", env_file=None))

    def test_current_desktop_sources_build(self):
        with tempfile.TemporaryDirectory(prefix="codex-mini-release-test-") as directory:
            output = Path(directory) / package.DESKTOP_OUTPUT
            args = argparse.Namespace(
                output=str(output), registration_key="packaging-test-only", env_file=None
            )
            package.build_desktop(args, package.repo_root())
            with zipfile.ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())

    def test_recursive_private_state_is_pruned(self):
        with tempfile.TemporaryDirectory(prefix="codex-mini-package-test-") as directory:
            root = Path(directory)
            for subtree in ["public", "lib", "relay-server"]:
                for entry in ["keep.js", ".mimosa/state.json", "vendor/.MIMOSA/credentials", "nested/.mimosa", "nested/devices.json",
                              ".env", ".env.local", "nested/auth.json", "logs/private.log", "node_modules/cache", "desktop-env.local.sh"]:
                    path = root / subtree / entry
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("fixture", encoding="utf-8")
                self.assertEqual(package.iter_tree(root, subtree), [f"{subtree}/keep.js"])

    def test_archive_validation_also_rejects_explicit_private_entries(self):
        for label, prefixes, names in [
            ("desktop", package.DESKTOP_FORBIDDEN_PREFIXES, package.DESKTOP_FORBIDDEN_NAMES),
            ("server", package.SERVER_FORBIDDEN_PREFIXES, package.SERVER_FORBIDDEN_NAMES),
        ]:
            for entry in [".mimosa/state", "lib/vendor/.mimosa/state", "nested/.MIMOSA", "lib\\.mimosa\\secret",
                          "lib/.env", "relay-server/.env.local", "lib/auth.json", "nested/desktop-env.local.ps1"]:
                with self.subTest(label=label, entry=entry):
                    with self.assertRaises(package.PackageError):
                        package.check_forbidden([entry], prefixes, names, label)


if __name__ == "__main__":
    unittest.main()
