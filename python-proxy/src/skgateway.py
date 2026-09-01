#!/usr/bin/env python3
"""Small SKGateway-compatible OpenAI router for the CHI fleet.

The gateway keeps SKCapstone and SKDashboard on stable ``sk-*`` model names
while forwarding inference to the active OpenAI-compatible model server.
It intentionally listens on loopback only (enforced by the systemd unit).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse


UPSTREAM = os.environ.get("SKGATEWAY_UPSTREAM", "http://chiap08:11439/v1").rstrip("/")
UPSTREAM_MODEL = os.environ.get(
    "SKGATEWAY_UPSTREAM_MODEL",
    "qwen3.8-27b-huihui-abliterated-q4_k_m",
)
ALIASES = tuple(
    value.strip()
    for value in os.environ.get(
        "SKGATEWAY_ALIASES",
        "sk-default,sk-auto,sk-code,sk-reason,sk-local",
    ).split(",")
    if value.strip()
)
TIMEOUT_SECONDS = float(os.environ.get("SKGATEWAY_TIMEOUT_SECONDS", "1200"))
ADVERTISE_STATE = Path(
    os.environ.get(
        "SKGATEWAY_ADVERTISE_STATE",
        "/home/skuser01/.local/state/skgateway/advertised-models.json",
    )
)
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}

app = FastAPI(title="SKGateway CHI Router", version="1.0.0")


def _catalog_ids() -> tuple[str, ...]:
    return (*ALIASES, UPSTREAM_MODEL)


def _advertised_ids() -> set[str]:
    """Return the persisted allowlist; a missing file or [] means all."""
    try:
        payload = json.loads(ADVERTISE_STATE.read_text(encoding="utf-8"))
        enabled = payload.get("enabled", [])
        if isinstance(enabled, list) and enabled:
            return {item for item in enabled if item in _catalog_ids()}
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        pass
    return set(_catalog_ids())


def _write_advertised_ids(enabled: list[str]) -> None:
    ADVERTISE_STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = ADVERTISE_STATE.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"enabled": enabled}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, ADVERTISE_STATE)


def _admin_catalog() -> dict[str, Any]:
    advertised = _advertised_ids()
    data: list[dict[str, Any]] = []
    for model_id in _catalog_ids():
        is_alias = model_id in ALIASES
        data.append(
            {
                "id": model_id,
                "object": "model",
                "provider": "skgateway" if is_alias else "chi-fleet/chiap08",
                "free": True,
                "advertised": model_id in advertised,
                "upstream_model": UPSTREAM_MODEL,
                "card": {
                    "display_name": model_id if is_alias else "Qwen3.8 27B Huihui Abliterated",
                    "org": "SKGateway" if is_alias else "CHI Fleet",
                    "tier": "local",
                    "context_length": 262144,
                    "max_output_tokens": 16384,
                    "params": "27.3B",
                    "quant": "Q4_K_M",
                    "modality": "text+image->text",
                    "supported_parameters": [
                        "temperature",
                        "tools",
                        "vision",
                        "stream",
                    ],
                    "good_at": ["reasoning", "chat", "code", "vision"],
                    "summary": (
                        f"Stable SK role routed to {UPSTREAM_MODEL}."
                        if is_alias
                        else "Sovereign Qwen3.8 inference hosted on chiap08."
                    ),
                },
            }
        )
    return {"object": "list", "data": data}


def _public_headers(headers: httpx.Headers) -> dict[str, str]:
    return {key: value for key, value in headers.items() if key.lower() not in HOP_HEADERS}


def _upstream_headers(request: Request) -> dict[str, str]:
    return {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_HEADERS
    }


def _rewrite_model(payload: Any) -> Any:
    if isinstance(payload, dict) and payload.get("model") in ALIASES:
        payload = dict(payload)
        payload["model"] = UPSTREAM_MODEL
    return payload


async def _upstream_health() -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{UPSTREAM}/models")
            response.raise_for_status()
        return True, "ok"
    except Exception as exc:  # Health must report, never crash the service.
        return False, str(exc)


@app.get("/health")
@app.get("/v1/health")
async def health() -> JSONResponse:
    healthy, detail = await _upstream_health()
    return JSONResponse(
        {
            "status": "ok" if healthy else "degraded",
            "gateway": "skgateway-chi",
            "upstream": UPSTREAM,
            "upstream_model": UPSTREAM_MODEL,
            "detail": detail,
        },
        status_code=200 if healthy else 503,
    )


@app.get("/v1/models")
async def models() -> JSONResponse:
    healthy, detail = await _upstream_health()
    if not healthy:
        raise HTTPException(status_code=503, detail=f"Model upstream unavailable: {detail}")
    created = int(time.time())
    advertised = _advertised_ids()
    data = [
        {
            "id": alias,
            "object": "model",
            "created": created,
            "owned_by": "skgateway",
            "root": UPSTREAM_MODEL,
            "parent": None,
        }
        for alias in ALIASES
        if alias in advertised
    ]
    if UPSTREAM_MODEL in advertised:
        data.append(
            {
                "id": UPSTREAM_MODEL,
                "object": "model",
                "created": created,
                "owned_by": "chi-fleet",
                "root": UPSTREAM_MODEL,
                "parent": None,
            }
        )
    return JSONResponse({"object": "list", "data": data})


@app.get("/admin/models")
@app.get("/v1/admin/models")
async def admin_models() -> JSONResponse:
    return JSONResponse(_admin_catalog())


@app.put("/admin/models/advertise")
@app.put("/v1/admin/models/advertise")
async def admin_models_advertise(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
        enabled = payload.get("enabled", [])
        if not isinstance(enabled, list) or not all(isinstance(item, str) for item in enabled):
            raise ValueError("enabled must be a list of strings")
    except (json.JSONDecodeError, ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    unknown = sorted(set(enabled) - set(_catalog_ids()))
    if unknown:
        raise HTTPException(status_code=400, detail={"unknown_models": unknown})
    # Empty is the SKGateway advertise-all sentinel used by SKDashboard.
    persisted = [] if not enabled or set(enabled) == set(_catalog_ids()) else sorted(set(enabled))
    _write_advertised_ids(persisted)
    response = _admin_catalog()
    response.update(
        {
            "ok": True,
            "enabled": sorted(_advertised_ids()),
            "advertise_all": not persisted,
        }
    )
    return JSONResponse(response)


@app.api_route(
    "/v1/{endpoint:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(endpoint: str, request: Request) -> Response:
    raw_body = await request.body()
    body = raw_body
    if raw_body and "application/json" in request.headers.get("content-type", ""):
        try:
            body = json.dumps(_rewrite_model(json.loads(raw_body))).encode("utf-8")
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = raw_body

    client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_SECONDS))
    upstream_request = client.build_request(
        request.method,
        f"{UPSTREAM}/{endpoint}",
        params=request.query_params,
        headers=_upstream_headers(request),
        content=body,
    )
    try:
        upstream_response = await client.send(upstream_request, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {exc}") from exc

    async def chunks():
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            await upstream_response.aclose()
            await client.aclose()

    return StreamingResponse(
        chunks(),
        status_code=upstream_response.status_code,
        headers=_public_headers(upstream_response.headers),
        media_type=upstream_response.headers.get("content-type"),
    )
