#!/usr/bin/env python3
"""Event handler for Jules events.

This handler is invoked by the event watcher when actionable events are
detected. It routes events to appropriate handlers based on event type
and uses the MCP client to interact with the Jules API.

Event Types:
    - question: Jules needs clarification - respond via message
    - completed: Job finished - fetch artifacts for review
    - error: Job failed - request retry
    - stuck: No progress - investigate and potentially intervene

Usage:
    This script is typically invoked by jules_event_watcher.py with
    the JULES_EVENT environment variable set.

Environment Variables:
    JULES_EVENT: JSON string containing the event data
    JULES_CONFIG: Path to config JSON file (optional)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, List

DEFAULT_CONFIG_PATH = os.getenv("JULES_CONFIG", "jules-manager/config.json")


def load_event() -> Dict[str, Any]:
    """Load event data from JULES_EVENT environment variable."""
    raw = os.getenv("JULES_EVENT")
    if not raw:
        raise RuntimeError("JULES_EVENT environment variable is not set")
    return json.loads(raw)


def load_config(path: str) -> Dict[str, Any]:
    """Load configuration from JSON file."""
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def run_mcp(command: List[str], tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Call an MCP tool and return the result.

    Sends a JSON-RPC request to the MCP server via stdin and parses
    the response from stdout.
    """
    request = {
        "jsonrpc": "2.0",
        "id": "event-handler",
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    process = subprocess.run(
        command,
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or "MCP command failed")
    for line in process.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        response = json.loads(line)
        if response.get("id") == "event-handler":
            return response.get("result", {})
    return {}


def handle_question(event: Dict[str, Any], mcp_command: List[str]) -> None:
    """Handle a question event from Jules.

    Jules is asking for clarification or input. The handler logs the
    question and can optionally send a response via MCP.

    In a full implementation, this would integrate with the local agent to generate
    appropriate responses based on the original task context.
    """
    job_id = event.get("job_id")
    message = event.get("message", {})
    content = message.get("content", str(message))

    print(f"[QUESTION] Job {job_id} requires input:")
    print(f"  {content}")

    if not mcp_command:
        print("  (No MCP command configured - skipping response)", file=sys.stderr)
        return

    # In a real implementation, the local agent would analyze the question and
    # generate an appropriate response. For now, we just log it.
    # Example response:
    # run_mcp(mcp_command, "jules_send_message", {
    #     "job_id": job_id,
    #     "message": {"content": "Response from local agent..."}
    # })


def handle_completed(event: Dict[str, Any], mcp_command: List[str]) -> None:
    """Handle a completed job event.

    The job has finished successfully. Fetch artifacts for code review
    and prepare for PR merge.
    """
    job_id = event.get("job_id")
    status = event.get("status", "UNKNOWN")

    print(f"[COMPLETED] Job {job_id} finished with status: {status}")

    if not mcp_command:
        print(
            "  (No MCP command configured - skipping artifact fetch)", file=sys.stderr
        )
        return

    # Fetch artifacts for review
    artifacts = run_mcp(mcp_command, "jules_get_artifacts", {"job_id": job_id})
    print(f"  Artifacts: {json.dumps(artifacts, indent=2)}")

    # In a real implementation, the local agent would:
    # 1. Review the code changes
    # 2. Run tests if applicable
    # 3. Decide whether to merge or request changes
    # Example merge:
    # run_mcp(mcp_command, "jules_merge_pr", {"job_id": job_id})


def handle_error(event: Dict[str, Any], mcp_command: List[str]) -> None:
    """Handle an error event from Jules.

    The job has failed. Log the error and optionally request a retry.
    """
    job_id = event.get("job_id")
    status = event.get("status", "UNKNOWN")
    message = event.get("message", "No error details available")

    print(f"[ERROR] Job {job_id} failed with status: {status}")
    print(f"  Error: {message}")

    if not mcp_command:
        print("  (No MCP command configured - skipping retry)", file=sys.stderr)
        return

    # In a real implementation, the local agent would analyze the error and
    # decide whether to retry, modify the prompt, or escalate.
    # Example retry:
    # run_mcp(mcp_command, "jules_request_retry", {"job_id": job_id})


def handle_stuck(event: Dict[str, Any], mcp_command: List[str]) -> None:
    """Handle a stuck job event.

    The job hasn't made progress for the configured threshold.
    Investigate and potentially intervene.
    """
    job_id = event.get("job_id")
    last_activity = event.get("last_activity", "unknown")

    print(f"[STUCK] Job {job_id} appears stuck")
    print(f"  Last activity: {last_activity}")

    if not mcp_command:
        print("  (No MCP command configured - skipping investigation)", file=sys.stderr)
        return

    # Fetch current job state for investigation
    job_info = run_mcp(mcp_command, "jules_get_job", {"job_id": job_id})
    print(f"  Job info: {json.dumps(job_info, indent=2)}")

    # In a real implementation, the local agent would:
    # 1. Analyze why the job is stuck
    # 2. Send a clarifying message
    # 3. Or cancel and restart with modified parameters
    # Example cancel:
    # run_mcp(mcp_command, "jules_cancel_job", {"job_id": job_id})


def main() -> int:
    """Main entry point for the event handler."""
    event = load_event()
    config = load_config(DEFAULT_CONFIG_PATH)
    mcp_command = config.get("mcp_command", [])

    # Ensure mcp_command is a list
    if isinstance(mcp_command, str):
        mcp_command = [mcp_command]

    event_type = event.get("event")
    job_id = event.get("job_id", "unknown")

    print(f"--- Processing {event_type} event for job {job_id} ---")

    if event_type == "question":
        handle_question(event, mcp_command)
        return 0

    if event_type == "completed":
        handle_completed(event, mcp_command)
        return 0

    if event_type == "error":
        handle_error(event, mcp_command)
        return 0

    if event_type == "stuck":
        handle_stuck(event, mcp_command)
        return 0

    print(f"[UNKNOWN] Unhandled event type: {event_type}")
    print(f"  Event data: {json.dumps(event, indent=2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
