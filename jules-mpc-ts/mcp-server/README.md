# Jules MCP Server (TypeScript)

A minimal MCP (Model Context Protocol) server that wraps the Google Jules API over stdio JSON-RPC.

## Overview

This server implements the MCP protocol for interacting with Google Jules, an AI-powered code assistant. It exposes tools for creating, monitoring, and managing Jules jobs through a JSON-RPC interface over stdin/stdout.

## Server Identity

- **Name:** `jules-mcp`
- **Version:** `1.0.0`
- **Protocol Version:** `2024-11-05`
- **Transport:** stdio JSON-RPC

## Usage

### Direct Execution

```bash
# Set required environment variable
export JULES_API_TOKEN="your-bearer-token"

# Build and run the server
npm run build
node build/mcp-server/jules_mcp_server.js
```

### With MCP Client

```bash
# Use the provided MCP client
npm run mcp-client -- \
  --command node build/mcp-server/jules_mcp_server.js \
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
    "serverInfo": {"name": "jules-mcp", "version": "1.0.0"},
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

## Dependencies

This server uses the MCP TypeScript SDK and Zod for schemas:

- `@modelcontextprotocol/sdk`
- `zod`

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

## Integration

This MCP server is designed to work with the Jules Manager system:

1. **Local Agent** calls MCP tools to create and register jobs
2. **Background Monitor** polls Jules API independently
3. **Event Watcher** triggers the local agent when actionable events occur
4. **Event Handler** uses MCP tools to respond to events

See the main [README.md](../README.md) for full system documentation.
