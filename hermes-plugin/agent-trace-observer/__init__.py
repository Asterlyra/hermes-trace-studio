"""Hermes Trace Studio observer plugin.

The plugin is deliberately observer-only: every callback returns ``None`` and
delivery failures never affect the Hermes agent loop. Events are sent to the
loopback Trace API on a bounded background queue.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_HOOKS = (
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "post_approval_response",
    "subagent_start",
    "subagent_stop",
)
_EVENTS: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=512)
_STARTED = False
_START_LOCK = threading.Lock()


def _token() -> str:
    direct = os.environ.get("HERMES_TRACE_OBSERVER_TOKEN", "").strip()
    if direct:
        return direct
    path = Path(
        os.environ.get(
            "HERMES_TRACE_OBSERVER_TOKEN_FILE",
            str(Path.home() / ".hermes" / "agent-trace-observer.token"),
        )
    )
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return "[depth limited]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= 200_000:
            return value
        return value[:200_000] + f"… [truncated {len(value) - 200_000} chars]"
    if isinstance(value, bytes):
        return {"type": "bytes", "length": len(value), "omitted": True}
    if isinstance(value, dict):
        return {str(key): _json_safe(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        return [_json_safe(item, depth + 1) for item in items[:2000]]
    return str(value)


def _deliver(event: dict[str, Any]) -> None:
    token = _token()
    if not token:
        return
    url = os.environ.get(
        "HERMES_TRACE_OBSERVER_URL",
        "http://127.0.0.1:4318/api/hermes/observer/events",
    ).strip()
    if not url.startswith(("http://127.0.0.1:", "http://localhost:")):
        return
    request = urllib.request.Request(
        url,
        data=json.dumps(event, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Hermes-Trace-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            response.read(1)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        # Observability must remain fail-open. The SessionDB recovery channel
        # can still reconstruct durable events after a temporary outage.
        return


def _worker() -> None:
    while True:
        event = _EVENTS.get()
        try:
            _deliver(event)
        finally:
            _EVENTS.task_done()


def _ensure_worker() -> None:
    global _STARTED
    if _STARTED:
        return
    with _START_LOCK:
        if _STARTED:
            return
        threading.Thread(
            target=_worker,
            name="hermes-trace-observer",
            daemon=True,
        ).start()
        _STARTED = True


def _observe(hook: str, **kwargs: Any) -> None:
    _ensure_worker()
    event = {
        "hook": hook,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "payload": _json_safe(kwargs),
    }
    try:
        _EVENTS.put_nowait(event)
    except queue.Full:
        try:
            _EVENTS.get_nowait()
            _EVENTS.task_done()
        except queue.Empty:
            pass
        try:
            _EVENTS.put_nowait(event)
        except queue.Full:
            pass
    return None


def _callback(hook: str):
    def callback(**kwargs: Any) -> None:
        return _observe(hook, **kwargs)

    callback.__name__ = f"observe_{hook}"
    return callback


def register(ctx) -> None:
    for hook in _HOOKS:
        ctx.register_hook(hook, _callback(hook))

