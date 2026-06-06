#!/usr/bin/env python3
"""
ROS2 environment collector.
Runs ros2 CLI commands and saves the result to a JSON file.

Usage:
    python collect.py -o ros2_env.json --timeout 10 --verbose
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone


def run_cmd(args: list, timeout: int = 10, verbose: bool = False) -> tuple:
    """Run a CLI command. Returns (stdout, success). Never raises."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=os.environ.copy(),
        )
        if result.returncode != 0 and verbose:
            print(f"  [warn] {' '.join(args)} -> exit {result.returncode}: {result.stderr.strip()[:120]}", file=sys.stderr)
        return result.stdout, result.returncode == 0
    except subprocess.TimeoutExpired:
        if verbose:
            print(f"  [warn] timeout: {' '.join(args)}", file=sys.stderr)
        return "", False
    except FileNotFoundError:
        if verbose:
            print(f"  [warn] command not found: {args[0]}", file=sys.stderr)
        return "", False
    except Exception as e:
        if verbose:
            print(f"  [warn] error running {args}: {e}", file=sys.stderr)
        return "", False


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

SECTION_MAP = {
    "Subscribers:":     "subscribers",
    "Publishers:":      "publishers",
    "Service Servers:": "service_servers",
    "Service Clients:": "service_clients",
    "Action Servers:":  "action_servers",
    "Action Clients:":  "action_clients",
}

ENTRY_RE = re.compile(r'^\s+(/[^:]+):\s+(.+)$')


def parse_node_info(output: str, node_name: str) -> dict:
    """Parse 'ros2 node info' output into a structured dict."""
    node = {
        "name": node_name,
        "publishers":     [],
        "subscribers":    [],
        "service_servers": [],
        "service_clients": [],
        "action_servers":  [],
        "action_clients":  [],
    }
    current_section = None
    for line in output.splitlines():
        # Check if this line is a section header
        stripped = line.strip()
        if stripped in SECTION_MAP:
            current_section = SECTION_MAP[stripped]
            continue
        # Try to parse an entry under the current section
        if current_section is not None:
            m = ENTRY_RE.match(line)
            if m:
                entry_name = m.group(1).strip()
                entry_type = m.group(2).strip()
                if current_section in ("publishers", "subscribers"):
                    node[current_section].append({"topic": entry_name, "type": entry_type})
                elif current_section in ("service_servers", "service_clients"):
                    node[current_section].append({"service": entry_name, "type": entry_type})
                elif current_section in ("action_servers", "action_clients"):
                    node[current_section].append({"action": entry_name, "type": entry_type})
    return node


def parse_topic_list(output: str) -> list:
    """Parse 'ros2 topic list -t' output. Returns list of {name, types}."""
    topics = []
    pattern = re.compile(r'^(/\S+)\s+\[([^\]]+)\]')
    for line in output.splitlines():
        m = pattern.match(line.strip())
        if m:
            name = m.group(1)
            types = [t.strip() for t in m.group(2).split(",")]
            topics.append({"name": name, "types": types})
    return topics


def parse_qos_block(lines: list) -> dict:
    """Parse QoS key-value lines into a dict."""
    qos = {}
    for line in lines:
        m = re.match(r'\s+([\w][\w\s/()]+?):\s+(.+)', line)
        if m:
            key = m.group(1).strip().lower().replace(" ", "_").replace("(", "").replace(")", "")
            qos[key] = m.group(2).strip()
    return qos


def parse_topic_info_verbose(output: str, topic_name: str) -> dict:
    """Parse 'ros2 topic info -v' output."""
    publishers = []
    subscribers = []

    # Split on double (or more) newlines to get blocks
    blocks = re.split(r'\n{2,}', output.strip())

    for block in blocks:
        lines = block.strip().splitlines()
        if not lines:
            continue

        endpoint_type = None
        node_name = None
        node_ns = "/"
        qos_lines = []
        in_qos = False

        for line in lines:
            if "Endpoint type: PUBLISHER" in line:
                endpoint_type = "publisher"
            elif "Endpoint type: SUBSCRIPTION" in line:
                endpoint_type = "subscriber"
            elif line.startswith("Node name:"):
                node_name = line.split(":", 1)[1].strip()
            elif line.startswith("Node namespace:"):
                node_ns = line.split(":", 1)[1].strip()
            elif "QoS profile:" in line:
                in_qos = True
            elif in_qos:
                qos_lines.append(line)

        if endpoint_type and node_name:
            ns = node_ns.rstrip("/")
            full_name = f"{ns}/{node_name}" if ns else f"/{node_name}"
            # Normalize double slashes
            full_name = re.sub(r'//+', '/', full_name)
            entry = {"node": full_name, "qos": parse_qos_block(qos_lines)}
            if endpoint_type == "publisher":
                publishers.append(entry)
            else:
                subscribers.append(entry)

    return {
        "name": topic_name,
        "types": [],  # filled from topic list
        "publishers": publishers,
        "subscribers": subscribers,
    }


def parse_service_list(output: str) -> list:
    """Parse 'ros2 service list -t' output."""
    services = []
    pattern = re.compile(r'^(/\S+)\s+\[([^\]]+)\]')
    for line in output.splitlines():
        m = pattern.match(line.strip())
        if m:
            name = m.group(1)
            types = [t.strip() for t in m.group(2).split(",")]
            services.append({"name": name, "types": types, "servers": [], "clients": []})
    return services


def parse_service_info(output: str) -> tuple:
    """Returns (servers, clients) as lists of {node} dicts."""
    servers = []
    clients = []
    current = None
    node_name_re = re.compile(r'^\s+(/\S+)')
    for line in output.splitlines():
        if re.match(r'^\s*Node name:', line):
            # Newer ros2 format
            name = line.split(":", 1)[1].strip()
            ns_match = None
            entry = {"node": f"/{name}"}
            if current == "servers":
                servers.append(entry)
            elif current == "clients":
                clients.append(entry)
        elif re.match(r'^Servers?\s+\d+', line, re.IGNORECASE):
            current = "servers"
        elif re.match(r'^Clients?\s+\d+', line, re.IGNORECASE):
            current = "clients"
        else:
            m = node_name_re.match(line)
            if m and current:
                entry = {"node": m.group(1)}
                if current == "servers":
                    servers.append(entry)
                else:
                    clients.append(entry)
    return servers, clients


def parse_action_list(output: str) -> list:
    """Parse 'ros2 action list -t' output."""
    actions = []
    pattern = re.compile(r'^(/\S+)\s+\[([^\]]+)\]')
    for line in output.splitlines():
        m = pattern.match(line.strip())
        if m:
            name = m.group(1)
            types = [t.strip() for t in m.group(2).split(",")]
            actions.append({"name": name, "types": types, "servers": [], "clients": []})
    # Fallback: plain list without types
    if not actions:
        for line in output.splitlines():
            line = line.strip()
            if line.startswith("/"):
                actions.append({"name": line, "types": [], "servers": [], "clients": []})
    return actions


def parse_action_info(output: str) -> tuple:
    """Returns (servers, clients) as lists of {node} dicts."""
    servers = []
    clients = []
    current = None
    for line in output.splitlines():
        stripped = line.strip()
        if re.match(r'^Action\s+servers?:\s+\d+', stripped, re.IGNORECASE):
            current = "servers"
        elif re.match(r'^Action\s+clients?:\s+\d+', stripped, re.IGNORECASE):
            current = "clients"
        elif stripped.startswith("/") and current:
            entry = {"node": stripped}
            if current == "servers":
                servers.append(entry)
            else:
                clients.append(entry)
    return servers, clients


# ---------------------------------------------------------------------------
# Collector class
# ---------------------------------------------------------------------------

class ROS2Collector:
    def __init__(self, timeout: int = 10, verbose: bool = False, workers: int = 4):
        self.timeout = timeout
        self.verbose = verbose
        self.workers = workers
        self._print_lock = threading.Lock()

    def _run(self, args: list) -> tuple:
        return run_cmd(args, timeout=self.timeout, verbose=self.verbose)

    def _log(self, msg: str) -> None:
        with self._print_lock:
            print(msg, flush=True)

    def _fetch_node(self, name: str) -> tuple:
        info_out, info_ok = self._run(["ros2", "node", "info", name])
        node = parse_node_info(info_out, name)
        self._log(f"  {name} ... {'ok' if info_ok else 'failed'}")
        return name, node

    def _fetch_topic(self, stub: dict, types_by_name: dict) -> tuple:
        name = stub["name"]
        info_out, info_ok = self._run(["ros2", "topic", "info", "-v", name])
        topic = parse_topic_info_verbose(info_out, name)
        topic["types"] = types_by_name.get(name, [])
        self._log(f"  {name} ... {'ok' if info_ok else 'failed'}")
        return name, topic

    def _build_service_index(self, nodes: list) -> dict:
        """Derive service servers/clients from already-collected node data.
        Works on all ROS2 distros including Humble (no ros2 service info needed)."""
        index = {}
        for node in nodes:
            for entry in node.get("service_servers", []):
                svc = entry["service"]
                index.setdefault(svc, {"servers": [], "clients": []})
                index[svc]["servers"].append({"node": node["name"]})
            for entry in node.get("service_clients", []):
                svc = entry["service"]
                index.setdefault(svc, {"servers": [], "clients": []})
                index[svc]["clients"].append({"node": node["name"]})
        return index

    def _build_action_index(self, nodes: list) -> dict:
        """Derive action servers/clients from already-collected node data."""
        index = {}
        for node in nodes:
            for entry in node.get("action_servers", []):
                act = entry["action"]
                index.setdefault(act, {"servers": [], "clients": []})
                index[act]["servers"].append({"node": node["name"]})
            for entry in node.get("action_clients", []):
                act = entry["action"]
                index.setdefault(act, {"servers": [], "clients": []})
                index[act]["clients"].append({"node": node["name"]})
        return index

    def _parallel(self, fn, items):
        """Submit items to thread pool, return results in original order."""
        if not items:
            return []
        results = [None] * len(items)
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {pool.submit(fn, item): i for i, item in enumerate(items)}
            for fut in as_completed(futures):
                results[futures[fut]] = fut.result()
        return results

    def collect(self) -> dict:
        data = {
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "nodes": [],
            "topics": [],
            "services": [],
            "actions": [],
        }

        # --- Nodes ---
        print(f"Collecting nodes (workers={self.workers})...")
        out, _ = self._run(["ros2", "node", "list"])
        node_names = [n.strip() for n in out.splitlines() if n.strip().startswith("/")]
        for _, node in self._parallel(self._fetch_node, node_names):
            data["nodes"].append(node)

        # --- Topics ---
        print("Collecting topics...")
        out, _ = self._run(["ros2", "topic", "list", "-t"])
        topic_stubs = parse_topic_list(out)
        types_by_name = {t["name"]: t["types"] for t in topic_stubs}
        fetch_topic = lambda stub: self._fetch_topic(stub, types_by_name)
        for _, topic in self._parallel(fetch_topic, topic_stubs):
            data["topics"].append(topic)

        # Build service/action endpoints from node data (Humble-compatible).
        svc_index = self._build_service_index(data["nodes"])
        act_index = self._build_action_index(data["nodes"])

        # --- Services ---
        print("Collecting services...")
        out, _ = self._run(["ros2", "service", "list", "-t"])
        for stub in parse_service_list(out):
            derived = svc_index.get(stub["name"], {"servers": [], "clients": []})
            stub["servers"] = derived["servers"]
            stub["clients"] = derived["clients"]
            data["services"].append(stub)

        # --- Actions ---
        print("Collecting actions...")
        out, _ = self._run(["ros2", "action", "list", "-t"])
        if not out.strip():
            out, _ = self._run(["ros2", "action", "list"])
        for stub in parse_action_list(out):
            derived = act_index.get(stub["name"], {"servers": [], "clients": []})
            stub["servers"] = derived["servers"]
            stub["clients"] = derived["clients"]
            data["actions"].append(stub)

        return data


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Collect ROS2 environment info and save to JSON."
    )
    parser.add_argument("-o", "--output", default="ros2_env.json",
                        help="Output JSON file (default: ros2_env.json)")
    parser.add_argument("--timeout", type=int, default=10,
                        help="Per-command timeout in seconds (default: 10)")
    parser.add_argument("--verbose", action="store_true",
                        help="Print warnings for failed commands")
    parser.add_argument("--workers", type=int, default=4,
                        help="Number of parallel worker threads (default: 4)")
    args = parser.parse_args()

    collector = ROS2Collector(timeout=args.timeout, verbose=args.verbose, workers=args.workers)
    data = collector.collect()

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    n = len(data["nodes"])
    t = len(data["topics"])
    s = len(data["services"])
    a = len(data["actions"])
    print(f"\nSaved to {args.output} ({n} nodes, {t} topics, {s} services, {a} actions)")


if __name__ == "__main__":
    main()
