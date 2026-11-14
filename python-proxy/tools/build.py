#!/usr/bin/env python3
"""Build a deterministic, content-addressed SKGateway Python proxy bundle."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = (
    "README.md",
    "requirements.lock",
    "runtime/config.schema.json",
    "runtime/skgateway.service",
    "src/skgateway.py",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, separators=(",", ": ")) + "\n").encode()


def add_bytes(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    archive.addfile(info, io.BytesIO(data))


def build(output_dir: Path) -> tuple[Path, Path]:
    files = {name: (ROOT / name).read_bytes() for name in INPUTS}
    manifest = {
        "schema_version": 1,
        "service": "skgateway-python-proxy",
        "separation": "independent-from-node-skgateway-contract",
        "source": {
            "canonical_repository": "https://github.com/smilinTux/skgateway.git",
            "candidate_path": "python-proxy/src/skgateway.py",
            "captured_live_sha256": sha256(files["src/skgateway.py"]),
            "ancestry": "copied-bytes-pinned-no-repository-ancestry-asserted",
        },
        "runtime": {
            "python": ">=3.12,<3.13",
            "dependency_lock": "requirements.lock",
            "launcher": "runtime/skgateway.service",
            "listen": "127.0.0.1:18780",
            "health_probe": "GET http://127.0.0.1:18780/health",
        },
        "configuration": {
            "schema": "runtime/config.schema.json",
            "credential_references": [],
            "secret_values_in_artifact": False,
        },
        "rollback": {
            "strategy": "atomic-symlink-to-prior-content-addressed-artifact",
            "live_mutation_authorized": False,
        },
        "files": [
            {"path": name, "sha256": sha256(data), "size": len(data)}
            for name, data in sorted(files.items())
        ],
    }
    manifest_bytes = canonical_json(manifest)
    artifact_content_id = sha256(manifest_bytes)
    artifact_name = f"skgateway-python-proxy-{artifact_content_id}.tar"
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact = output_dir / artifact_name
    with tarfile.open(artifact, "w", format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(files.items()):
            add_bytes(archive, f"skgateway-python-proxy/{name}", data, 0o755 if name.endswith("skgateway.py") else 0o644)
        add_bytes(archive, "skgateway-python-proxy/manifest.json", manifest_bytes)
    artifact_sha = sha256(artifact.read_bytes())
    receipt = {
        "artifact": artifact.name,
        "artifact_sha256": artifact_sha,
        "content_id": artifact_content_id,
        "manifest_sha256": sha256(manifest_bytes),
    }
    receipt_path = output_dir / f"{artifact.name}.json"
    receipt_path.write_bytes(canonical_json(receipt))
    return artifact, receipt_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    artifact, receipt = build(args.output)
    print(artifact)
    print(receipt)


if __name__ == "__main__":
    main()
