from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import httpx
import pytest

MODULE_PATH = Path(__file__).parents[1] / "src" / "skgateway.py"
spec = importlib.util.spec_from_file_location("candidate_skgateway", MODULE_PATH)
assert spec and spec.loader
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def test_captured_source_hash() -> None:
    import hashlib

    assert hashlib.sha256(MODULE_PATH.read_bytes()).hexdigest() == "5a98e8005c0615f981155ca62a6fe28920cfddb36004fbb5f5f41e8fde673f35"


def test_alias_routing_rewrites_only_aliases() -> None:
    assert proxy._rewrite_model({"model": "sk-code", "messages": []})["model"] == proxy.UPSTREAM_MODEL
    assert proxy._rewrite_model({"model": "external-model"})["model"] == "external-model"


def test_authentication_header_is_forwarded_and_hop_headers_removed() -> None:
    request = httpx.Request(
        "POST",
        "http://proxy/v1/chat/completions",
        headers={"authorization": "Bearer opaque-test-reference", "host": "proxy", "connection": "keep-alive"},
    )
    headers = proxy._upstream_headers(request)
    assert headers["authorization"] == "Bearer opaque-test-reference"
    assert "host" not in headers
    assert "connection" not in headers


def test_health_reports_upstream_state(monkeypatch: pytest.MonkeyPatch) -> None:
    async def healthy():
        return True, "ok"

    monkeypatch.setattr(proxy, "_upstream_health", healthy)
    response = asyncio.run(proxy.health())
    body = json.loads(response.body)
    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["upstream"] == proxy.UPSTREAM


def test_health_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unhealthy():
        return False, "unreachable"

    monkeypatch.setattr(proxy, "_upstream_health", unhealthy)
    response = asyncio.run(proxy.health())
    assert response.status_code == 503
    assert json.loads(response.body)["status"] == "degraded"


def test_static_contract_and_no_embedded_secret_values() -> None:
    source = MODULE_PATH.read_text()
    assert '--port 18780' in (Path(__file__).parents[1] / "runtime" / "skgateway.service").read_text()
    assert "@app.get(\"/health\")" in source
    assert "@app.get(\"/v1/health\")" in source
    assert "authorization" not in source.lower().replace('"proxy-authorization"', "")
    assert "api_key" not in source.lower()
