# Jules Manager

An MCP server implementation for orchestrating Google Jules as a remote coding agent from a local coding agent. The system handles the full lifecycle: task decomposition, API-based dispatch to Jules, asynchronous status monitoring, intervention handling, code review, and PR merging.

## Core Principle

**The local agent must not waste context window tokens on active polling.** A decoupled monitoring mechanism handles polling independently and only triggers the local agent when human-level input or a final review is required.

## Quick Start

### Prerequisites

- Python 3.8+
- `JULES_API_TOKEN` environment variable set with your Jules API bearer token

### Start the System

```bash
# Terminal 1: Start the background monitor
python jules-manager/scripts/jules_monitor.py --config jules-manager/config.json

# Terminal 2: Start the event watcher
python jules-manager/scripts/jules_event_watcher.py --command "python jules-manager/scripts/event_handler.py"
```

### Create a Job

```bash
# Use the MCP client to create a job
python jules-manager/scripts/mcp_client.py \
  --command python jules-manager/mcp-server/jules_mcp_server.py \
  --tool jules_create_job \
  --arguments '{"repo": "owner/repo", "branch": "feature/new-auth", "prompt": "Implement OAuth2 authentication"}'

# Register the job for monitoring
python jules-manager/scripts/mcp_client.py \
  --command python jules-manager/mcp-server/jules_mcp_server.py \
  --tool jules_register_job \
  --arguments '{"job_id": "JOB_ID_FROM_ABOVE", "jobs_path": "jules-manager/jobs.jsonl"}'
```

## Project Structure

```
jules-manager/
├── README.md                    # This file
├── config.json                  # Shared configuration
├── jobs.jsonl                   # Active jobs registry
├── events.jsonl                 # Actionable event queue
├── docs/
│   └── architecture.md          # Detailed architecture documentation
├── mcp-server/
│   ├── jules_mcp_server.py      # MCP server implementation
│   └── README.md                # MCP server documentation
└── scripts/
    ├── jules_monitor.py         # Background poller
    ├── jules_event_watcher.py   # Event queue watcher
    ├── event_handler.py         # Event handler
    └── mcp_client.py            # CLI MCP client helper
```

## File Descriptions

| File | Purpose |
|------|---------|
| `config.json` | Shared configuration for paths, polling intervals, and API settings |
| `jobs.jsonl` | Registry of active job IDs being monitored (one JSON object per line) |
| `events.jsonl` | Queue of actionable events emitted by the monitor |
| `jules_mcp_server.py` | MCP server that wraps the Jules API with stdio JSON-RPC |
| `jules_monitor.py` | Background daemon that polls Jules API and emits events |
| `jules_event_watcher.py` | Tails events.jsonl and invokes handlers for new events |
| `event_handler.py` | Routes events to appropriate handlers based on type |
| `mcp_client.py` | CLI tool for calling MCP tools from the command line |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JULES_API_TOKEN` | Yes | Bearer token for Jules API authentication |
| `JULES_API_BASE` | No | Base URL for Jules API (default: https://jules.googleapis.com/v1) |
| `JULES_CONFIG` | No | Path to config.json (default: jules-manager/config.json) |

## Event Types

| Event | Trigger | Handler Action |
|-------|---------|----------------|
| `question` | Jules asks for clarification | Respond via `jules_send_message` |
| `completed` | Job status = COMPLETED | Fetch artifacts, review code, merge PR |
| `error` | Job status = FAILED/ERROR | Request retry via `jules_request_retry` |
| `stuck` | No progress for N minutes | Investigate, potentially cancel/restart |

## MCP Tools

The MCP server exposes these tools:

| Tool | Description |
|------|-------------|
| `jules_create_job` | Create a new Jules job |
| `jules_register_job` | Register job ID with the monitor |
| `jules_get_job` | Fetch job metadata and status |
| `jules_get_messages` | Fetch messages since cursor |
| `jules_send_message` | Send clarification to Jules |
| `jules_get_artifacts` | Get diff/patch/PR URL |
| `jules_request_retry` | Retry or re-run a job |
| `jules_merge_pr` | Merge PR after CI passes |
| `jules_cancel_job` | Cancel a running job |
| `jules_list_jobs` | List all jobs for a repo |

## Configuration

See `config.json` for all available settings:

```json
{
  "jobs_path": "jules-manager/jobs.jsonl",
  "events_path": "jules-manager/events.jsonl",
  "monitor_state_path": "jules-manager/.monitor_state.json",
  "watcher_state_path": "jules-manager/.watcher_state.json",
  "monitor_poll_seconds": 45,
  "watcher_poll_seconds": 1,
  "stuck_minutes": 20,
  "api_base": "https://jules.googleapis.com/v1",
  "mcp_command": ["python", "jules-manager/mcp-server/jules_mcp_server.py"],
  "event_command": ["python", "jules-manager/scripts/event_handler.py"]
}
```

## Architecture

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

## No External Dependencies

All scripts use only Python standard library modules. No pip install required.
