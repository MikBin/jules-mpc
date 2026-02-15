#!/usr/bin/env python3
"""Event watcher that tails the events JSONL and triggers handlers.

This script monitors the events.jsonl file for new entries and invokes
a handler command for each event. The event data is passed via the
JULES_EVENT environment variable.

Usage:
    python jules_event_watcher.py --command "python event_handler.py"

The watcher tracks its read position in a state file, allowing it to
resume where it left off after restarts.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict

DEFAULT_CONFIG_PATH = os.getenv("JULES_CONFIG", "jules-manager/config.json")
DEFAULT_STATE_PATH = ".watcher_state.json"
DEFAULT_POLL_SECONDS = 1


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", help="Path to events JSONL file")
    parser.add_argument(
        "--command",
        required=True,
        help="Command to run when an actionable event arrives",
    )
    parser.add_argument(
        "--poll",
        type=float,
        default=DEFAULT_POLL_SECONDS,
        help="Seconds between file checks",
    )
    parser.add_argument(
        "--state",
        help="Path to watcher state JSON file",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to config JSON file",
    )
    return parser.parse_args()


def load_state(path: str) -> Dict[str, Any]:
    """Load watcher state from JSON file."""
    if not os.path.exists(path):
        return {"offset": 0}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_config(path: str) -> Dict[str, Any]:
    """Load configuration from JSON file."""
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_state(path: str, state: Dict[str, Any]) -> None:
    """Save watcher state to JSON file."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)


def run_command(command: str, event: Dict[str, Any]) -> int:
    """Run the handler command with the event in JULES_EVENT env var.

    Returns the exit code from the handler command.
    """
    env = os.environ.copy()
    env["JULES_EVENT"] = json.dumps(event)
    result = subprocess.run(command, shell=True, check=False, env=env)
    return result.returncode


def watch(events_path: str, command: str, poll: float, state_path: str) -> None:
    """Main watch loop that tails the events file.

    Continuously checks for new lines in the events file and invokes
    the handler command for each new event. Tracks read offset in state file.
    """
    state = load_state(state_path)
    offset = int(state.get("offset", 0))

    print(f"Event Watcher started", file=sys.stderr)
    print(f"Events: {events_path}", file=sys.stderr)
    print(f"Handler: {command}", file=sys.stderr)

    while True:
        # Wait for events file to exist
        if not os.path.exists(events_path):
            time.sleep(poll)
            continue

        # Read new events from current offset
        try:
            with open(events_path, "r", encoding="utf-8") as handle:
                handle.seek(offset)
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        # Skip malformed lines
                        continue

                    # Invoke handler
                    event_type = event.get("event", "unknown")
                    job_id = event.get("job_id", "unknown")
                    print(
                        f"Processing {event_type} event for job {job_id}",
                        file=sys.stderr,
                    )

                    exit_code = run_command(command, event)
                    if exit_code != 0:
                        print(
                            f"Handler returned exit code {exit_code}", file=sys.stderr
                        )

                # Update offset to end of file
                offset = handle.tell()
        except IOError as exc:
            print(f"Error reading events file: {exc}", file=sys.stderr)

        # Persist state
        state["offset"] = offset
        save_state(state_path, state)
        time.sleep(poll)


def main() -> int:
    """Main entry point for the event watcher."""
    args = parse_args()
    config = load_config(args.config)

    # Resolve paths from args or config
    events_path = args.events or config.get("events_path")
    command = args.command
    poll = args.poll or config.get("watcher_poll_seconds", DEFAULT_POLL_SECONDS)
    state_path = args.state or config.get("watcher_state_path", DEFAULT_STATE_PATH)

    if not events_path:
        print(
            "Error: events_path must be provided via --events or config",
            file=sys.stderr,
        )
        return 1

    if not command:
        print("Error: --command is required", file=sys.stderr)
        return 1

    watch(events_path, command, poll, state_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
