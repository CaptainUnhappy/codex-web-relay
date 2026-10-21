#!/usr/bin/env python3
"""Build Codex Relay release zip artifacts with fixed manifests and checks."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


PLACEHOLDER = "__CODEX_MINI_RELAY_REGISTRATION_KEY__"

DESKTOP_FILES = [
    "server.js",
    "package.json",
    "package-lock.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "start-codex-mini-relay.bat",
    "start-codex-mini-relay.command",
    "start-codex-relay.bat",
    "start-codex-relay.command",
    "desktop-env.example.ps1",
    "desktop-env.example.sh",
]
DESKTOP_DIRS = ["public", "bin", "lib"]
DESKTOP_SCRIPTS = [
    "scripts/start-windows-relay.ps1",
    "scripts/start-macos-relay.sh",
    "scripts/test-app-server-backend.js",
    "scripts/test-codex-cli-selection.js",
    "scripts/test-ui-contract.js",
    "scripts/test-web-request-scheduling.js",
    "scripts/test-keyboard-layout.js",
    "scripts/test-thread-search.js",
    "scripts/test-thread-menu-interactions.js",
    "scripts/test-web-delivery.js",
    "scripts/test-atomic-state.js",
    "scripts/test-desktop-sync-e2e.js",
]
DESKTOP_OUTPUT = "codex-relay-desktop-universal.zip"

SERVER_FILES = ["package.json", "package-lock.json", "LICENSE"]
SERVER_DIRS = ["relay-server"]
SERVER_OUTPUT = "codex-relay-server.zip"

EXECUTABLE_ENTRIES = {
    "start-codex-mini-relay.command",
    "start-codex-relay.command",
    "scripts/start-macos-relay.sh",
    "bin/codex-window-point",
    "relay-server/install-full.sh",
    "relay-server/install-systemd.sh",
}
LF_TEXT_ENTRIES = {
    "desktop-env.example.sh",
    "start-codex-mini-relay.command",
    "start-codex-relay.command",
    "scripts/start-macos-relay.sh",
    "relay-server/install-full.sh",
    "relay-server/install-systemd.sh",
}

DESKTOP_FORBIDDEN_PREFIXES = (
    ".git/",
    "node_modules/",
    "relay-server/",
    "macos/",
    ".runtime/",
    "logs/",
)
DESKTOP_FORBIDDEN_NAMES = {"登录二维码.png", "登录链接.txt"}

SERVER_FORBIDDEN_PREFIXES = (
    ".git/",
    "node_modules/",
    "public/",
    "bin/",
    "scripts/",
    "macos/",
    ".runtime/",
    "logs/",
)
SERVER_FORBIDDEN_NAMES = {
    "server.js",
    "README.md",
    "CHANGELOG.md",
    "start-codex-mini-relay.bat",
    "start-codex-mini-relay.command",
    "登录二维码.png",
    "登录链接.txt",
}


class PackageError(RuntimeError):
    pass


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def registration_key(args: argparse.Namespace) -> str | None:
    if getattr(args, "public", False):
        if args.registration_key or args.env_file:
            raise PackageError("--public cannot be combined with registration key inputs")
        # Public release builds never read registration keys from the environment.
        return None
    key = args.registration_key or os.environ.get("CODEX_MINI_RELAY_REGISTRATION_KEY", "")
    if not key and args.env_file:
        values = parse_env_file(Path(args.env_file))
        key = values.get("CODEX_MINI_RELAY_REGISTRATION_KEY", "")
    key = key.strip()
    if not key or key == PLACEHOLDER:
        raise PackageError(
            "desktop packaging needs CODEX_MINI_RELAY_REGISTRATION_KEY "
            "via --registration-key, --env-file, or environment."
        )
    if "'" in key:
        raise PackageError("registration key cannot contain a single quote; refusing unsafe script injection.")
    return key


def posix_entry(path: Path | str) -> str:
    return str(PurePosixPath(str(path).replace("\\", "/")))


def is_private_entry(entry: str) -> bool:
    parts = PurePosixPath(posix_entry(entry)).parts
    private_dirs = {".git", ".aws", ".ssh", ".codex", ".mimosa", ".runtime", ".codex-mini-state",
                    ".playwright-mcp", "node_modules", "__pycache__", "logs", "output"}
    private_files = {"devices.json", "devices.json.bak", "auth.json", "relay-device.json",
                     "desktop-env.local.ps1", "desktop-env.local.sh"}
    return (any(part.casefold() in private_dirs for part in parts)
            or parts[-1].casefold() in private_files or parts[-1].casefold().startswith(".env"))


def iter_tree(root: Path, rel_dir: str) -> list[str]:
    base = root / rel_dir
    if not base.is_dir():
        raise PackageError(f"missing required directory: {rel_dir}")
    entries: list[str] = []
    # Prune private directories before descending, including nested vendor trees.
    for current, directories, files in os.walk(base):
        directories[:] = sorted(name for name in directories if not is_private_entry(name))
        for name in sorted(files):
            path = Path(current) / name
            rel = posix_entry(path.relative_to(root))
            if is_private_entry(rel) or rel.endswith("/devices.json") or rel.endswith("/devices.json.bak"):
                continue
            entries.append(rel)
    return sorted(entries)


def require_files(root: Path, entries: list[str]) -> None:
    missing = [entry for entry in entries if not (root / entry).is_file()]
    if missing:
        raise PackageError(f"missing required file(s): {', '.join(missing)}")


def zip_info(entry: str, mode: int | None = None) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(entry)
    if mode is None:
        mode = 0o755 if entry in EXECUTABLE_ENTRIES else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.create_system = 3
    return info


def read_entry_bytes(root: Path, entry: str, key: str | None = None) -> bytes:
    data = (root / entry).read_bytes()
    if entry in LF_TEXT_ENTRIES:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if key is not None and entry in DESKTOP_SCRIPTS:
        text = data.decode("utf-8")
        text = text.replace(
            "DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'",
            f"DEFAULT_REGISTRATION_KEY='{key}'",
        )
        text = text.replace(
            "$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'",
            f"$DefaultRegistrationKey = '{key}'",
        )
        data = text.encode("utf-8")
    return data


def write_zip(root: Path, output: Path, entries: list[str], key: str | None = None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            zf.writestr(zip_info(entry), read_entry_bytes(root, entry, key))


def check_forbidden(entries: list[str], prefixes: tuple[str, ...], names: set[str], label: str) -> None:
    bad = [
        entry
        for entry in entries
        if is_private_entry(entry) or entry in names or any(entry == prefix[:-1] or entry.startswith(prefix) for prefix in prefixes)
    ]
    if bad:
        raise PackageError(f"{label} package contains forbidden entries: {', '.join(bad)}")


def desktop_entries(root: Path) -> list[str]:
    entries = [*DESKTOP_FILES, *DESKTOP_SCRIPTS]
    for rel_dir in DESKTOP_DIRS:
        entries.extend(iter_tree(root, rel_dir))
    require_files(root, entries)
    entries = sorted(dict.fromkeys(entries))
    check_forbidden(entries, DESKTOP_FORBIDDEN_PREFIXES, DESKTOP_FORBIDDEN_NAMES, "desktop")
    return entries


def server_entries(root: Path) -> list[str]:
    entries = [*SERVER_FILES]
    for rel_dir in SERVER_DIRS:
        entries.extend(iter_tree(root, rel_dir))
    require_files(root, entries)
    entries = sorted(dict.fromkeys(entries))
    check_forbidden(entries, SERVER_FORBIDDEN_PREFIXES, SERVER_FORBIDDEN_NAMES, "server")
    return entries


def validate_desktop_zip(output: Path, public: bool = False) -> None:
    with zipfile.ZipFile(output, "r") as zf:
        names = set(zf.namelist())
        for required in [*DESKTOP_FILES, *DESKTOP_SCRIPTS, "bin/codex-window-point", "public/index.html"]:
            if required not in names:
                raise PackageError(f"desktop zip missing {required}")
        check_forbidden(sorted(names), DESKTOP_FORBIDDEN_PREFIXES, DESKTOP_FORBIDDEN_NAMES, "desktop")
        win = zf.read("scripts/start-windows-relay.ps1").decode("utf-8")
        mac = zf.read("scripts/start-macos-relay.sh").decode("utf-8")
        server_js = zf.read("server.js").decode("utf-8")
        html = zf.read("public/index.html").decode("utf-8")
        for label, script, marker in [
            ("Windows", win, "$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'"),
            ("macOS", mac, "DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'"),
        ]:
            if public and marker not in script:
                raise PackageError(f"public desktop zip must not embed a {label} registration key")
            if not public and marker in script:
                raise PackageError(f"desktop zip still has the {label} registration key placeholder")
        if "& $script:NpmCmd" in win:
            raise PackageError("desktop zip still calls $script:NpmCmd directly")
        if "Resolve-NpmCmd" not in win:
            raise PackageError("desktop zip is missing the npm.cmd resolver")
        if "Add-CodexMiniLogLine" not in win or "Add-Content -LiteralPath $script:LogPath" not in win:
            raise PackageError("desktop zip is missing Windows console-to-log tee")
        if "Start-Transcript" in win:
            raise PackageError("desktop zip must not use Start-Transcript for Windows relay logs")
        if "CODEX_MINI_DESKTOP_LOG_PATH" not in win or "CODEX_MINI_DESKTOP_LOG_PATH" not in server_js:
            raise PackageError("desktop zip is missing Windows node console log tee")
        if "Ensure-CodexCli" not in win:
            raise PackageError("desktop zip is missing the Windows Codex CLI check")
        if "@('--version') -TimeoutMs 8000" not in win or "@('app-server', '--help') -TimeoutMs 8000" not in win:
            raise PackageError("desktop zip is missing the bounded Windows Codex CLI startup checks")
        if "https://chatgpt.com/codex/install.ps1" not in win:
            raise PackageError("desktop zip is missing the official Windows Codex CLI installer")
        if "$CodexCliInstallHome = Join-Path $RuntimeRoot" not in win or "$CodexCliInstallBin = Join-Path $RuntimeRoot" not in win:
            raise PackageError("desktop zip must keep the Windows Codex CLI package under the portable runtime")
        if "$env:CODEX_HOME = $CodexCliInstallHome" not in win or "$env:CODEX_INSTALL_DIR = $CodexCliInstallBin" not in win:
            raise PackageError("desktop zip must direct the official Windows Codex installer to the portable runtime")
        if "Remove-Item Env:CODEX_HOME" not in win or "Remove-Item Env:CODEX_INSTALL_DIR" not in win or "GetEnvironmentVariable('Path', 'User')" not in win:
            raise PackageError("desktop zip must restore temporary Windows Codex installer environment and PATH state")
        if "codex-mini-cli-ok" not in win:
            raise PackageError("desktop zip is missing the Windows Codex CLI execution test")
        if "Invoke-CodexCliCapture" not in win or "RedirectStandardError" not in win or "2>&1" in win:
            raise PackageError("desktop zip must capture Windows Codex CLI stdout/stderr without PowerShell trap failures")
        if "$env:CODEX_MINI_FULL_CODEX_CLI_CHECK -ne '1'" not in win:
            raise PackageError("desktop zip must keep the Windows model execution check opt-in")
        if "app-server --help" not in win or "Codex App Server check passed" not in win:
            raise PackageError("desktop zip is missing the Windows Codex App Server startup check")
        if "localFailureCount" not in win or "localFailureSince" not in win or "$localFailureCount -lt 3" not in win or "$localFailureSeconds -lt 15" not in win:
            raise PackageError("desktop zip is missing the Windows relay-status debounce")
        if "codex-mini-cli" not in win or "--skip-git-repo-check" not in win:
            raise PackageError("desktop zip must run the Windows Codex CLI test in the dedicated work folder")
        if "CODEX_MINI_AUTO_KEEP_AWAKE" not in win or "Keep-awake: Codex Relay will prevent idle sleep" not in win:
            raise PackageError("desktop zip is missing the Windows keep-awake startup boundary")
        if "Stop-CodexMiniKeepAwakeHelpers" not in win:
            raise PackageError("desktop zip is missing the Windows keep-awake helper cleanup")
        if "ensure_codex_cli" not in mac:
            raise PackageError("desktop zip is missing the macOS Codex CLI check")
        if "repair_codex_cli_config" not in mac or "service_tier" not in mac:
            raise PackageError("desktop zip is missing the macOS Codex CLI config repair")
        if "https://chatgpt.com/codex/install.sh" not in mac:
            raise PackageError("desktop zip is missing the official macOS Codex CLI installer")
        if "codex-mini-cli-ok" not in mac:
            raise PackageError("desktop zip is missing the macOS Codex CLI execution test")
        if "failed to refresh available models" not in mac or "requires a newer version of Codex" not in mac or "supports_reasoning_summaries" not in mac or "Continuing because Codex App Server is available" not in mac:
            raise PackageError("desktop zip must continue on macOS Codex model metadata/version drift")
        if "app-server --help" not in mac or "Codex App Server check passed" not in mac:
            raise PackageError("desktop zip is missing the macOS Codex App Server startup check")
        if "watch_codex_mini_relay()" not in mac or "start_codex_mini_process()" not in mac or "stop_codex_mini_process()" not in mac or "/codex/relay-status" not in mac:
            raise PackageError("desktop zip is missing the macOS relay supervisor")
        if "local_failure_count" not in mac or "local_failure_since" not in mac or '"$local_failure_count" -lt 3' not in mac or '"$local_failure_seconds" -lt 15' not in mac:
            raise PackageError("desktop zip is missing the macOS relay-status debounce")
        if "ensure_device_runtime_fields()" not in mac or "localToken" not in mac or "MOBILE_TYPER_TOKEN" not in mac:
            raise PackageError("desktop zip is missing the macOS local relay-status token")
        if 'if [[ "$managed_process" -eq 1 ]] && tcp_port_open 127.0.0.1 "$local_port"; then' not in mac:
            raise PackageError("desktop zip must reject a macOS relay port owned by another device")
        if '"$NPM_CMD" start' in mac:
            raise PackageError("desktop zip macOS launcher must not be a one-shot npm start wrapper")
        if "codex-mini-cli" not in mac or "--skip-git-repo-check" not in mac:
            raise PackageError("desktop zip must run the macOS Codex CLI test in the dedicated work folder")
        if "CODEX_MINI_AUTO_KEEP_AWAKE" not in mac or "Keep-awake: Codex Relay will prevent idle sleep" not in mac:
            raise PackageError("desktop zip is missing the macOS keep-awake startup boundary")
        if "ensure_macos_automation_permissions" not in mac or "Privacy_Accessibility" not in mac or "Privacy_ScreenCapture" not in mac:
            raise PackageError("desktop zip is missing the macOS automation permission startup check")
        if ".route-badge.is-logout" not in html or ".top-actions" not in html:
            raise PackageError("desktop zip is missing the top-actions logout button CSS")
        if "justify-content: flex-end;" not in html:
            raise PackageError("desktop zip is missing the top-actions inline alignment CSS")
        if "routeText.textContent = '';" not in html:
            raise PackageError("desktop zip must keep the logout button icon-only")
        for entry in ("start-codex-relay.command", "start-codex-mini-relay.command", "scripts/start-macos-relay.sh", "bin/codex-window-point"):
            mode = (zf.getinfo(entry).external_attr >> 16) & 0o777
            if mode != 0o755:
                raise PackageError(f"{entry} mode is {oct(mode)}, expected 0o755")


def validate_server_zip(output: Path) -> None:
    with zipfile.ZipFile(output, "r") as zf:
        names = set(zf.namelist())
        for required in [*SERVER_FILES, "relay-server/server.js", "relay-server/install-systemd.sh"]:
            if required not in names:
                raise PackageError(f"server zip missing {required}")
        check_forbidden(sorted(names), SERVER_FORBIDDEN_PREFIXES, SERVER_FORBIDDEN_NAMES, "server")
        for entry in ("relay-server/install-full.sh", "relay-server/install-systemd.sh"):
            mode = (zf.getinfo(entry).external_attr >> 16) & 0o777
            if mode != 0o755:
                raise PackageError(f"{entry} mode is {oct(mode)}, expected 0o755")


def validate_payload(output: Path, root: Path, entries: list[str], key: str | None = None) -> None:
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(entries):
            raise PackageError("archive manifest does not match current sources")
        if archive.testzip() is not None:
            raise PackageError("archive CRC validation failed")
        for entry in entries:
            if archive.read(entry) != read_entry_bytes(root, entry, key):
                raise PackageError(f"archive payload differs from current source: {entry}")


def build_desktop(args: argparse.Namespace, root: Path) -> Path:
    output = Path(args.output or root / DESKTOP_OUTPUT)
    if not output.is_absolute():
        output = root / output
    key = registration_key(args)
    entries = desktop_entries(root)
    write_zip(root, output, entries, key)
    validate_desktop_zip(output, public=getattr(args, "public", False))
    validate_payload(output, root, entries, key)
    return output


def build_server(args: argparse.Namespace, root: Path) -> Path:
    output = Path(args.output or root / SERVER_OUTPUT)
    if not output.is_absolute():
        output = root / output
    entries = server_entries(root)
    write_zip(root, output, entries)
    validate_server_zip(output)
    validate_payload(output, root, entries)
    return output


def build_all(args: argparse.Namespace, root: Path) -> list[Path]:
    desktop_args = argparse.Namespace(**vars(args))
    desktop_args.output = args.desktop_output
    server_args = argparse.Namespace(**vars(args))
    server_args.output = args.server_output
    return [build_desktop(desktop_args, root), build_server(server_args, root)]


def add_key_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--public", action="store_true", help="build a public archive without embedded registration keys")
    parser.add_argument("--registration-key", help="registration key to inject into desktop package copies")
    parser.add_argument("--env-file", help="env file containing CODEX_MINI_RELAY_REGISTRATION_KEY")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build Codex Relay release zip artifacts.")
    sub = parser.add_subparsers(dest="command", required=True)

    desktop = sub.add_parser("desktop", help=f"build {DESKTOP_OUTPUT}")
    desktop.add_argument("--output", default=DESKTOP_OUTPUT)
    desktop.add_argument("--checksums", help="write SHA256SUMS for the validated desktop archive")
    add_key_args(desktop)

    server = sub.add_parser("server", help=f"build {SERVER_OUTPUT}")
    server.add_argument("--output", default=SERVER_OUTPUT)

    all_cmd = sub.add_parser("all", help="build desktop and server zips")
    all_cmd.add_argument("--desktop-output", default=DESKTOP_OUTPUT)
    all_cmd.add_argument("--server-output", default=SERVER_OUTPUT)
    all_cmd.add_argument("--checksums", help="write SHA256SUMS for both validated archives")
    add_key_args(all_cmd)

    args = parser.parse_args(argv)
    root = repo_root()
    try:
        if args.command == "desktop":
            outputs = [build_desktop(args, root)]
        elif args.command == "server":
            outputs = [build_server(args, root)]
        elif args.command == "all":
            outputs = build_all(args, root)
        else:
            raise PackageError(f"unknown command: {args.command}")
        if getattr(args, "checksums", None):
            checksum_path = root / args.checksums
            checksum_path.parent.mkdir(parents=True, exist_ok=True)
            checksum_path.write_text("".join(
                f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}\n" for output in outputs
            ), encoding="utf-8")
    except PackageError as error:
        print(f"package error: {error}", file=sys.stderr)
        return 1

    for output in outputs:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
