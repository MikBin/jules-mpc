# ZAI Jules MCP Server

A minimal MCP (Model Context Protocol) server that wraps the Google Jules API over stdio JSON-RPC.

## Overview

This server implements the MCP protocol for interacting with Google Jules, an AI-powered code assistant. It exposes tools for creating, monitoring, and managing Jules jobs through a simple JSON-RPC interface over stdin/stdout.

## Server Identity

- **Name:** `zai-jules-mcp`
- **Version:** `1.0.0`
- **Protocol Version:** `2024-11-05`
- **Transport:** stdio JSON-RPC

## Usage

### Direct Execution

```bash
# Set required environment variable
export JULES_API_TOKEN="your-bearer-token"

# Run the server (reads JSON-RPC from stdin)
python jules_mcp_server.py
```

### With MCP Client

```bash
# Use the provided MCP client
python ../scripts/mcp_client.py \
  --command python jules_mcp_server.py \
  --tool jules_get_job \
  --arguments '{"job_id": "abc123"}'
```

### JSON-RPC Protocol

The server communicates via JSON-RPC 2.0 over stdin/stdout. Each request is a single JSON object per line.

#### Initialize

```json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "serverInfo": {"name": "zai-jules-mcp", "version": "1.0.0"},
    "capabilities": {"tools": {}}
  }
}
```

#### List Tools

```json
{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
```

#### Call Tool

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "jules_get_job",
    "arguments": {"job_id": "abc123"}
  }
}
```

## Available Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `jules_create_job` | Create a new Jules job | repo, branch, prompt |
| `jules_register_job` | Register job ID with monitor | job_id, jobs_path |
| `jules_get_job` | Fetch job metadata and status | job_id |
| `jules_get_messages` | Fetch messages since cursor | job_id |
| `jules_send_message` | Send clarification to Jules | job_id, message |
| `jules_get_artifacts` | Get diff/patch/PR URL | job_id |
| `jules_request_retry` | Retry or re-run a job | job_id |
| `jules_merge_pr` | Merge PR after CI passes | job_id |
| `jules_cancel_job` | Cancel a running job | job_id |
| `jules_list_jobs` | List all jobs for a repo | repo |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JULES_API_TOKEN` | Yes | Bearer token for Jules API authentication |
| `JULES_API_BASE` | No | Base URL for Jules API (default: https://jules.googleapis.com/v1) |

## No External Dependencies

This server uses only Python standard library modules:
- `json` - JSON parsing
- `os` - Environment variables
- `sys` - stdin/stdout
- `urllib` - HTTP requests

No pip install required.

## Error Handling

Errors are returned as JSON-RPC error responses:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "HTTP 404 for https://jules.googleapis.com/v1/jobs/invalid: Not found"
  }
}
```

## Integration with ZAI

This MCP server is designed to work with the ZAI Jules Manager system:

1. **ZAI Agent** calls MCP tools to create and register jobs
2. **Background Monitor** polls Jules API independently
3. **Event Watcher** triggers ZAI when actionable events occur
4. **Event Handler** uses MCP tools to respond to events

See the main [README.md](../README.md) for full system documentation.
