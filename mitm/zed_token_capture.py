"""mitmproxy addon: capture Zed LLM Authorization bearer to local zed-bridge daemon.

Watches responses from `cloud.zed.dev`, extracts the `Authorization: Bearer ...`
the Zed.app sent on the request, and pushes it (deduped) to a localhost-only
internal endpoint of zed-bridge. Never logs the raw token; only a
redacted `first4...last4` shape.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from typing import Optional


TARGET_HOSTS = {"cloud.zed.dev"}
DEFAULT_PROXY_PORT = "8788"
DEFAULT_STATE_DIR = os.path.expanduser("~/.config/zed-bridge/state")


def _redact(token: str) -> str:
    if not token:
        return "<empty>"
    if len(token) <= 8:
        return "x" * len(token)
    return f"{token[:4]}...{token[-4:]}"


def _load_internal_secret() -> Optional[str]:
    for env_key in ("ZED_BRIDGE_INTERNAL_SECRET", "ZED_PROXY_INTERNAL_SECRET"):
        env_secret = os.environ.get(env_key, "").strip()
        if env_secret:
            return env_secret
    state_dir = os.environ.get("ZED_BRIDGE_STATE_DIR", DEFAULT_STATE_DIR)
    secret_path = os.path.join(state_dir, "internal-secret")
    try:
        with open(secret_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


class ZedTokenCapture:
    def __init__(self) -> None:
        self._last_pushed: Optional[str] = None
        self._secret: Optional[str] = _load_internal_secret()
        self._proxy_port = os.environ.get("ZED_PROXY_PORT", DEFAULT_PROXY_PORT)
        self._endpoint = f"http://127.0.0.1:{self._proxy_port}/_internal/zed-token"
        if not self._secret:
            print(
                "[zed_token_capture] WARNING: no internal secret found; "
                "set ZED_BRIDGE_INTERNAL_SECRET or create state/internal-secret.",
                file=sys.stderr,
            )

    def response(self, flow) -> None:
        try:
            host = flow.request.pretty_host
        except Exception:
            return
        if host not in TARGET_HOSTS:
            return
        auth = flow.request.headers.get("Authorization", "")
        if not auth:
            return
        if not auth.lower().startswith("bearer "):
            return
        token = auth[7:].strip()
        if not token:
            return
        if token == self._last_pushed:
            print(
                f"[zed_token_capture] skipped (dedupe) tokenShape={_redact(token)}",
                file=sys.stderr,
            )
            return
        if not self._secret:
            print(
                f"[zed_token_capture] skipped (no secret) tokenShape={_redact(token)}",
                file=sys.stderr,
            )
            return
        ok = self._push(token)
        if ok:
            self._last_pushed = token
            print(
                f"[zed_token_capture] pushed tokenShape={_redact(token)} source=mitm",
                file=sys.stderr,
            )
        else:
            print(
                f"[zed_token_capture] push failed tokenShape={_redact(token)}",
                file=sys.stderr,
            )

    def _push(self, token: str) -> bool:
        body = json.dumps({"token": token, "source": "mitm"}).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": self._secret or "",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as e:
            print(
                f"[zed_token_capture] HTTP {e.code} from proxy",
                file=sys.stderr,
            )
            return False
        except (urllib.error.URLError, OSError) as e:
            print(
                f"[zed_token_capture] connection error: {e}",
                file=sys.stderr,
            )
            return False


addons = [ZedTokenCapture()]
