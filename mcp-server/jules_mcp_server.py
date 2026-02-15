#!/usr/bin/env python3
"""Minimal MCP server that wraps the Jules API over stdio JSON-RPC.

This server implements the Model Context Protocol (MCP) for interacting with
Google Jules API. It exposes tools for creating, monitoring, and managing
Jules jobs.

Environment Variables:
    JULES_API_TOKEN: Bearer token for Jules API authentication
    JULES_API_BASE: Base URL for Jules API (default: https://jules.googleapis.com/v1)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

# Server identity
SERVER_NAME = "zai-jules-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

# API configuration
API_BASE = os.getenv("JULES_API_BASE", "https://jules.googleapis.com/v1")
API_TOKEN = os.getenv("JULES_API_TOKEN")


def write_message(payload: Dict[str, Any]) -> None:
    """Write a JSON-RPC message to stdout."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()


def send_response(request_id: Any, result: Any) -> None:
    """Send a successful JSON-RPC response."""
    write_message({"jsonrpc": "2.0", "id": request_id, "result": result})


def send_error(request_id: Any, message: str, code: int = -32000) -> None:
    """Send a JSON-RPC error response."""
    write_message(
        {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
    )


def build_request(url: str, method: str, payload: Optional[Dict[str, Any]]) -> urllib.request.Request:
    """Build an HTTP request with proper headers."""
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    return urllib.request.Request(url, data=data, headers=headers, method=method)


def request_json(url: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None) -> Any:
    """Make an HTTP request and return the JSON response."""
    request = build_request(url, method, payload)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8") if exc.fp else ""
        raise RuntimeError(f"HTTP {exc.code} for {url}: {detail}") from exc


def url_join(base: str, path: str) -> str:
    """Join base URL with path, ensuring proper slashes."""
    return urllib.parse.urljoin(base + "/", path)


def list_tools() -> Dict[str, Any]:
    """Return the list of available MCP tools."""
    return {
        "tools": [
            {
                "name": "jules_create_job",
                "description": "Create a new Jules job",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string", "description": "Repository in owner/repo format"},
                        "branch": {"type": "string", "description": "Target branch name"},
                        "prompt": {"type": "string", "description": "Task description for Jules"},
                        "constraints": {"type": "object", "description": "Optional constraints for the job"},
                    },
                    "additionalProperties": True,
                },
            },
            {
                "name": "jules_register_job",
                "description": "Register a job ID with the local monitor jobs file for tracking",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID to register"},
                        "jobs_path": {"type": "string", "description": "Path to the jobs JSONL file"},
                        "metadata": {"type": "object", "description": "Optional metadata to store with the job"},
                    },
                    "required": ["job_id", "jobs_path"],
                },
            },
            {
                "name": "jules_get_job",
                "description": "Fetch job metadata and current status",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_get_messages",
                "description": "Fetch new job messages since a cursor position",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                        "cursor": {"type": "string", "description": "Optional cursor for pagination"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_send_message",
                "description": "Send a clarification or instruction to Jules for a job",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                        "message": {"type": "object", "description": "Message content to send"},
                    },
                    "required": ["job_id", "message"],
                },
            },
            {
                "name": "jules_get_artifacts",
                "description": "Fetch job artifacts (diff, patch, PR URL)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_request_retry",
                "description": "Request a retry or re-run of a failed job",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_merge_pr",
                "description": "Merge the PR associated with a completed job",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                        "payload": {"type": "object", "description": "Optional merge parameters"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_cancel_job",
                "description": "Cancel a running job",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string", "description": "The Jules job ID"},
                    },
                    "required": ["job_id"],
                },
            },
            {
                "name": "jules_list_jobs",
                "description": "List all jobs for a repository",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string", "description": "Repository in owner/repo format"},
                        "limit": {"type": "integer", "description": "Maximum number of jobs to return"},
                    },
                    "required": ["repo"],
                },
            },
        ]
    }


def handle_tool_call(name: str, arguments: Dict[str, Any]) -> Any:
    """Handle a tool call and return the result."""
    if name == "jules_create_job":
        return request_json(url_join(API_BASE, "jobs"), method="POST", payload=arguments)

    if name == "jules_register_job":
        jobs_path = arguments.get("jobs_path")
        job_id = arguments.get("job_id")
        metadata = arguments.get("metadata", {})
        if not jobs_path or not job_id:
            raise ValueError("jobs_path and job_id are required")
        entry = {"job_id": job_id, "metadata": metadata}
        os.makedirs(os.path.dirname(jobs_path) or ".", exist_ok=True)
        with open(jobs_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry))
            handle.write("\n")
        return {"registered": True, "job_id": job_id}

    job_id = arguments.get("job_id")
    if not job_id:
        raise ValueError("job_id is required")

    if name == "jules_get_job":
        return request_json(url_join(API_BASE, f"jobs/{job_id}"))

    if name == "jules_get_messages":
        cursor = arguments.get("cursor")
        path = f"jobs/{job_id}/messages"
        if cursor:
            path = f"{path}?cursor={urllib.parse.quote(cursor)}"
        return request_json(url_join(API_BASE, path))

    if name == "jules_send_message":
        message = arguments.get("message", {})
        return request_json(
            url_join(API_BASE, f"jobs/{job_id}/messages"),
            method="POST",
            payload=message,
        )

    if name == "jules_get_artifacts":
        return request_json(url_join(API_BASE, f"jobs/{job_id}/artifacts"))

    if name == "jules_request_retry":
        return request_json(url_join(API_BASE, f"jobs/{job_id}:retry"), method="POST")

    if name == "jules_merge_pr":
        payload = arguments.get("payload", {})
        return request_json(
            url_join(API_BASE, f"jobs/{job_id}:merge"),
            method="POST",
            payload=payload,
        )

    if name == "jules_cancel_job":
        return request_json(url_join(API_BASE, f"jobs/{job_id}:cancel"), method="POST")

    if name == "jules_list_jobs":
        repo = arguments.get("repo")
        limit = arguments.get("limit", 50)
        if not repo:
            raise ValueError("repo is required")
        path = f"jobs?repo={urllib.parse.quote(repo)}&limit={limit}"
        return request_json(url_join(API_BASE, path))

    raise ValueError(f"Unknown tool: {name}")


def handle_request(request: Dict[str, Any]) -> None:
    """Handle a JSON-RPC request."""
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}

    if method == "initialize":
        send_response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "capabilities": {"tools": {}},
            },
        )
        return

    if method == "tools/list":
        send_response(request_id, list_tools())
        return

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        result = handle_tool_call(tool_name, arguments)
        send_response(request_id, {"content": result})
        return

    send_error(request_id, f"Unsupported method: {method}")


def main() -> int:
    """Main entry point for the MCP server."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            handle_request(request)
        except Exception as exc:
            request_id = None
            if isinstance(request, dict):
                request_id = request.get("id")
            send_error(request_id, str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
