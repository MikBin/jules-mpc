#!/usr/bin/env python3
"""Background monitor that polls Jules jobs and emits actionable events.

This script runs independently from the main ZAI agent context, polling the
Jules API at configured intervals and only surfacing actionable events that
require human-level attention.

Actionable Events:
    - question: Jules needs clarification or input
    - completed: Job finished successfully
    - error: Job failed or encountered an error
    - stuck: No progress for configured threshold minutes

Usage:
    python jules_monitor.py --config zai-jules-manager/config.json

Environment Variables:
    JULES_API_TOKEN: Bearer token for Jules API authentication
    JULES_API_BASE: Base URL for Jules API (optional, overrides config)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

# Defaults
DEFAULT_API_BASE = "https://jules.googleapis.com/v1"
DEFAULT_POLL_SECONDS = 45
DEFAULT_STUCK_MINUTES = 20
DEFAULT_STATE_PATH = ".zai_monitor_state.json"
DEFAULT_CONFIG_PATH = os.getenv("ZAI_JULES_CONFIG", "zai-jules-manager/config.json")

# Job statuses that are considered terminal/actionable
ACTIONABLE_STATUSES = {"COMPLETED", "FAILED", "ERROR", "CANCELLED"}


def utc_now() -> str:
    """Return current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()


def load_json(path: str, default: Any) -> Any:
    """Load JSON from file, returning default if file doesn't exist."""
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_config(path: str) -> Dict[str, Any]:
    """Load configuration from JSON file."""
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: str, payload: Any) -> None:
    """Save JSON to file with pretty formatting."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def append_jsonl(path: str, payload: Dict[str, Any]) -> None:
    """Append a JSON object as a new line in a JSONL file."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload))
        handle.write("\n")


def load_jobs(path: str) -> List[Dict[str, Any]]:
    """Load jobs from JSON array or JSONL file.

    Each entry must include a job_id. Supports both JSON array format
    and JSONL (one JSON object per line) format.
    """
    if not os.path.exists(path):
        return []

    with open(path, "r", encoding="utf-8") as handle:
        content = handle.read().strip()

    if not content:
        return []

    if content.startswith("["):
        jobs = json.loads(content)
    else:
        jobs = [json.loads(line) for line in content.splitlines() if line.strip()]

    normalized = []
    for entry in jobs:
        if isinstance(entry, str):
            normalized.append({"job_id": entry})
        else:
            normalized.append(entry)
    return normalized


def build_request(url: str, token: Optional[str]) -> urllib.request.Request:
    """Build an HTTP GET request with proper headers."""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def fetch_json(url: str, token: Optional[str]) -> Dict[str, Any]:
    """Fetch JSON from URL with authentication."""
    request = build_request(url, token)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8") if exc.fp else ""
        raise RuntimeError(f"HTTP {exc.code} for {url}: {body}") from exc


def job_status_url(api_base: str, job_id: str) -> str:
    """Build URL for job status endpoint."""
    return urllib.parse.urljoin(api_base + "/", f"jobs/{job_id}")


def job_messages_url(api_base: str, job_id: str, cursor: Optional[str]) -> str:
    """Build URL for job messages endpoint with optional cursor."""
    url = urllib.parse.urljoin(api_base + "/", f"jobs/{job_id}/messages")
    if cursor:
        url = f"{url}?cursor={urllib.parse.quote(cursor)}"
    return url


def is_question_message(message: Dict[str, Any]) -> bool:
    """Determine if a message is a question requiring input.

    A message is considered a question if:
    - It has 'question' or 'needs_input' in tags
    - It contains '?' and is from the assistant role
    """
    role = str(message.get("role", "")).lower()
    tags = " ".join(str(tag).lower() for tag in message.get("tags", []))
    text = str(message.get("content", "")).lower()
    return "question" in tags or "needs_input" in tags or ("?" in text and role == "assistant")


def messages_actionable(messages: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Find the first actionable question message in a list."""
    for message in messages:
        if is_question_message(message):
            return message
    return None


def should_emit_stuck(last_activity: Optional[str], threshold_minutes: int) -> bool:
    """Determine if a job should be considered stuck.

    Returns True if the last activity timestamp is older than the threshold.
    """
    if not last_activity:
        return False
    try:
        last = datetime.fromisoformat(last_activity)
    except ValueError:
        return False
    delta = datetime.now(timezone.utc) - last
    return delta.total_seconds() >= threshold_minutes * 60


@dataclass
class JobState:
    """Tracking state for a single job."""
    cursor: Optional[str] = None
    last_status: Optional[str] = None
    last_activity: Optional[str] = None


def monitor_once(
    jobs: List[Dict[str, Any]],
    state: Dict[str, JobState],
    api_base: str,
    token: Optional[str],
    events_path: str,
    stuck_minutes: int,
) -> None:
    """Run a single monitoring cycle for all registered jobs.

    For each job:
    1. Fetch current status from Jules API
    2. Check for terminal status (completed/error)
    3. Check for question messages requiring input
    4. Check for stuck state (no activity)
    5. Emit actionable events to events.jsonl
    """
    for job in jobs:
        job_id = job.get("job_id")
        if not job_id:
            continue

        job_state = state.setdefault(job_id, JobState())

        # Fetch current job status
        try:
            status_payload = fetch_json(job_status_url(api_base, job_id), token)
        except RuntimeError as exc:
            # Emit error event for API failures
            append_jsonl(
                events_path,
                {
                    "event": "error",
                    "job_id": job_id,
                    "observed_at": utc_now(),
                    "message": str(exc),
                },
            )
            continue

        status = status_payload.get("status")

        # Track status changes
        if status and status != job_state.last_status:
            job_state.last_status = status
            job_state.last_activity = utc_now()

        # Check for terminal status
        if status in ACTIONABLE_STATUSES:
            append_jsonl(
                events_path,
                {
                    "event": "completed" if status == "COMPLETED" else "error",
                    "job_id": job_id,
                    "status": status,
                    "observed_at": utc_now(),
                    "payload": status_payload,
                },
            )
            continue

        # Fetch messages for question detection
        try:
            messages_payload = fetch_json(
                job_messages_url(api_base, job_id, job_state.cursor), token
            )
        except RuntimeError:
            # Skip message check on error, will retry next cycle
            messages_payload = {}

        cursor = messages_payload.get("next_cursor")
        messages = messages_payload.get("messages", [])
        actionable_message = messages_actionable(messages)

        # Update cursor for next fetch
        if cursor:
            job_state.cursor = cursor

        # Emit question event if found
        if actionable_message:
            append_jsonl(
                events_path,
                {
                    "event": "question",
                    "job_id": job_id,
                    "observed_at": utc_now(),
                    "message": actionable_message,
                },
            )
            job_state.last_activity = utc_now()
            continue

        # Check for stuck state
        if should_emit_stuck(job_state.last_activity, stuck_minutes):
            append_jsonl(
                events_path,
                {
                    "event": "stuck",
                    "job_id": job_id,
                    "observed_at": utc_now(),
                    "last_activity": job_state.last_activity,
                },
            )
            # Reset activity timer to avoid repeated stuck events
            job_state.last_activity = utc_now()


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", help="Path to jobs JSON or JSONL file")
    parser.add_argument("--events", help="Path to events JSONL file")
    parser.add_argument("--state", default=DEFAULT_STATE_PATH, help="Path to state JSON file")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL_SECONDS, help="Poll interval in seconds")
    parser.add_argument(
        "--stuck-minutes",
        type=int,
        default=DEFAULT_STUCK_MINUTES,
        help="Minutes before emitting stuck event",
    )
    parser.add_argument(
        "--api-base",
        default=os.getenv("JULES_API_BASE", DEFAULT_API_BASE),
        help="Base URL for Jules API",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to config JSON file",
    )
    return parser.parse_args()


def main() -> int:
    """Main entry point for the monitor daemon."""
    args = parse_args()
    token = os.getenv("JULES_API_TOKEN")
    config = load_config(args.config)

    # Resolve paths from args or config
    jobs_path = args.jobs or config.get("jobs_path")
    events_path = args.events or config.get("events_path")
    state_path = args.state or config.get("monitor_state_path", DEFAULT_STATE_PATH)
    poll_seconds = args.poll or config.get("monitor_poll_seconds", DEFAULT_POLL_SECONDS)
    api_base = args.api_base or config.get("api_base", DEFAULT_API_BASE)
    stuck_minutes = args.stuck_minutes or config.get("stuck_minutes", DEFAULT_STUCK_MINUTES)

    if not jobs_path or not events_path:
        print("Error: jobs_path and events_path must be provided", file=sys.stderr)
        return 1

    # Load existing state
    state_raw = load_json(state_path, {})
    state: Dict[str, JobState] = {}
    for job_id, payload in state_raw.items():
        state[job_id] = JobState(
            cursor=payload.get("cursor"),
            last_status=payload.get("last_status"),
            last_activity=payload.get("last_activity"),
        )

    print(f"ZAI Jules Monitor started - polling every {poll_seconds}s", file=sys.stderr)
    print(f"Jobs: {jobs_path}", file=sys.stderr)
    print(f"Events: {events_path}", file=sys.stderr)

    # Main monitoring loop
    while True:
        try:
            jobs = load_jobs(jobs_path)
            if jobs:
                monitor_once(
                    jobs,
                    state,
                    api_base,
                    token,
                    events_path,
                    stuck_minutes,
                )
        except Exception as exc:
            # Log error but continue running
            append_jsonl(
                events_path,
                {
                    "event": "error",
                    "job_id": None,
                    "observed_at": utc_now(),
                    "message": f"Monitor error: {exc}",
                },
            )

        # Persist state
        save_json(
            state_path,
            {
                job_id: {
                    "cursor": job_state.cursor,
                    "last_status": job_state.last_status,
                    "last_activity": job_state.last_activity,
                }
                for job_id, job_state in state.items()
            },
        )
        time.sleep(poll_seconds)


if __name__ == "__main__":
    sys.exit(main())
