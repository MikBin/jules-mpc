#!/usr/bin/env python3
"""CLI helper for calling MCP tools from the command line.

This script provides a simple command-line interface for invoking MCP
tools on the Jules MCP server. It sends a JSON-RPC request via stdin
and outputs the JSON result.

Usage:
    python mcp_client.py --command python zai-jules-manager/mcp-server/jules_mcp_server.py --tool jules_get_job --arguments '{"job_id": "abc123"}'

Arguments:
    --command: The command to run the MCP server (required, space-separated)
    --tool: The name of the MCP tool to call (required)
    --arguments: JSON string of tool arguments (default: {})

Output:
    JSON result from the MCP tool call, pretty-printed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any, Dict, List


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--command",
        required=True,
        nargs="+",
        help="Command to run the MCP server (space-separated)",
    )
    parser.add_argument(
        "--tool",
        required=True,
        help="Name of the MCP tool to call",
    )
    parser.add_argument(
        "--arguments",
        default="{}",
        help="JSON string of tool arguments (default: {})",
    )
    return parser.parse_args()


def call_tool(command: List[str], tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Call an MCP tool and return the result.

    Sends a JSON-RPC request to the MCP server via stdin and parses
    the response from stdout.

    Args:
        command: The command to run the MCP server
        tool: The name of the tool to call
        arguments: Dictionary of tool arguments

    Returns:
        The result from the MCP tool call

    Raises:
        RuntimeError: If the MCP command fails or returns an error
    """
    request = {
        "jsonrpc": "2.0",
        "id": "mcp-client",
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
    
    # Parse response - may have multiple lines (e.g., initialization)
    for line in process.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            continue
            
        if response.get("id") == "mcp-client":
            if "error" in response:
                raise RuntimeError(f"MCP error: {response['error']}")
            return response.get("result", {})
    
    return {}


def main() -> int:
    """Main entry point for the MCP client."""
    args = parse_args()
    
    try:
        arguments = json.loads(args.arguments)
    except json.JSONDecodeError as exc:
        print(f"Error: Invalid JSON in --arguments: {exc}", file=sys.stderr)
        return 1
    
    try:
        result = call_tool(args.command, args.tool, arguments)
        print(json.dumps(result, indent=2))
        return 0
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
