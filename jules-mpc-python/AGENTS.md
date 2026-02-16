Project: Jules Manager (Python MCP server + monitor scripts)
Scope: `jules-mpc-python/`
Rules: No `.cursor/rules`, `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clinerules`, `.goosehints`, or `.github/copilot-instructions.md` found.
Build/Run:
- Start monitor: `python scripts/jules_monitor.py --config config.json`
- Start watcher: `python scripts/jules_event_watcher.py --command "python scripts/event_handler.py"`
- Start MCP server: `python mcp-server/jules_mcp_server.py`
- No lint configured (stdlib only).
- Tests: none; no single-test command.
Architecture:
- `mcp-server/jules_mcp_server.py` exposes MCP tools wrapping the Jules API.
- `scripts/jules_monitor.py` polls the API and appends actionable events to `events.jsonl`.
- `scripts/jules_event_watcher.py` tails `events.jsonl` and invokes handlers.
- `scripts/event_handler.py` routes events and calls MCP tools.
- Data files: `config.json`, `jobs.jsonl`, `events.jsonl`, `.monitor_state.json`, `.watcher_state.json`.
Code Style:
- Python 3.8+, standard library only; avoid new deps.
- Keep modules simple with top-level functions; no frameworks.
- Imports: stdlib only, grouped together with no third-party sections.
- Naming: snake_case for functions/vars, UpperCamelCase for classes, ALL_CAPS for constants.
- Errors: raise/propagate with clear messages; guard API/network calls in monitor with retries/timeouts.
