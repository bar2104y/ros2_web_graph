# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Step 1 — collect data** (requires a live ROS2 environment with `ros2` on PATH):
```bash
python collector/collect.py -o ros2_env.json --verbose
```

**Step 2 — open the web UI** (no server needed, works anywhere):
```
Open src/index.html in a browser, then click "Open" and pick ros2_env.json.
```

## Architecture

Two fully independent modules share only the JSON file format.

### Module 1: `collector/collect.py`

Standalone Python script, stdlib only (no `pip install` needed). Calls `ros2` CLI via `subprocess` and writes a single JSON snapshot.

Collection flow: `ros2 node list` → for each node: `ros2 node info` → `ros2 topic list -t` → for each topic: `ros2 topic info -v` → same for services and actions.

All subprocess calls go through `run_cmd()` which never raises — timeouts and missing commands return `("", False)` so the collector always finishes even if some entities disappear mid-scan.

Parser functions are pure (input: raw stdout string → output: dict/list). Each entity type has a dedicated parser: `parse_node_info`, `parse_topic_info_verbose`, `parse_service_info`, `parse_action_info`. The topic verbose parser (`parse_topic_info_verbose`) is the most complex: it splits on double newlines into endpoint blocks, then extracts node name, namespace, and a QoS sub-block.

### Module 2: `src/`

Pure static SPA — no backend, no build step. Open `src/index.html` directly in the browser.

**`src/app.js`** — all logic runs client-side. The user opens a JSON file via the file-picker dialog or drag-and-drop; `FileReader` parses it and fills `STATE.index` (flat dict keyed by entity name for O(1) lookup). Selecting any entity triggers `buildGraphElements(type, name, depth)` which runs BFS up to `depth` hops using `getNeighbors()`. Edges are deduplicated via a string key `source--edgeType--target`. Cytoscape.js + cytoscape-dagre renders the result. Hard cap: 300 elements per graph (a truncation node is added).

Visibility state (hidden entities, NS color rules) is persisted in browser cookies so settings survive page reloads. The Export/Import buttons allow saving/restoring settings as a JSON file.

### JSON data format

```json
{
  "collected_at": "<ISO timestamp>",
  "nodes":    [{ "name": "/foo", "publishers": [{"topic": "/t", "type": "..."}], "subscribers": [...], "service_servers": [...], "service_clients": [...], "action_servers": [...], "action_clients": [...] }],
  "topics":   [{ "name": "/t", "types": ["..."], "publishers": [{"node": "/foo", "qos": {...}}], "subscribers": [...] }],
  "services": [{ "name": "/s", "types": [...], "servers": [{"node": "..."}], "clients": [...] }],
  "actions":  [{ "name": "/a", "types": [...], "servers": [...], "clients": [...] }]
}
```

Topic entries carry full QoS dicts (reliability, durability, history, deadline, liveliness, etc.) sourced from `ros2 topic info -v`.

## Key constraints

- **Collector is stdlib-only** — do not add `pip` dependencies to `collector/collect.py`.
- **No frontend build step** — `app.js` is plain ES2020, loaded directly. Cytoscape.js and dagre come from CDN (`unpkg.com`). Do not introduce a bundler.
- **No backend** — the app is a static SPA; do not add a server. JSON is loaded via `FileReader` from the user's local filesystem.
- **ROS2 CLI output format varies** between distros (Humble/Iron/Jazzy). Parsers use flexible regex rather than fixed column positions.
- **Entity names always start with `/`** — keep this invariant in JS (`STATE.index` keys).
