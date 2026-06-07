'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE = {
  data: null,       // full JSON from /api/data
  index: {},        // { "/name": { type: "node"|"topic"|"service"|"action", obj } }
  selected: null,   // { type, name }
  depth: 1,
  activeTab: 'nodes',
  searchQuery: '',
  hiddenTypes: new Set(),    // entity types hidden from graph
  hiddenEntities: new Set(), // individual entity names hidden from graph
  colorMode: 'type',         // 'type' | 'namespace'
  nsRules: [],               // [{ pattern: string, color: string }]
};

// ---------------------------------------------------------------------------
// Cookie helpers for entity visibility
// ---------------------------------------------------------------------------

function loadHiddenFromCookie() {
  const match = document.cookie.split(';').find(c => c.trim().startsWith('ros2_hidden='));
  if (!match) return;
  try {
    const val = decodeURIComponent(match.trim().slice('ros2_hidden='.length));
    STATE.hiddenEntities = new Set(JSON.parse(val));
  } catch {}
}

function saveHiddenToCookie() {
  const val = encodeURIComponent(JSON.stringify([...STATE.hiddenEntities]));
  document.cookie = `ros2_hidden=${val}; max-age=31536000; path=/`;
}

function loadNsRulesFromCookie() {
  const match = document.cookie.split(';').find(c => c.trim().startsWith('ros2_ns_rules='));
  if (!match) return;
  try {
    const val = decodeURIComponent(match.trim().slice('ros2_ns_rules='.length));
    STATE.nsRules = JSON.parse(val);
  } catch {}
}

function saveNsRulesToCookie() {
  const val = encodeURIComponent(JSON.stringify(STATE.nsRules));
  document.cookie = `ros2_ns_rules=${val}; max-age=31536000; path=/`;
}

function toggleEntityVisibility(name) {
  if (STATE.hiddenEntities.has(name)) {
    STATE.hiddenEntities.delete(name);
  } else {
    STATE.hiddenEntities.add(name);
  }
  saveHiddenToCookie();
  renderSidebar();
  if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
}

// ---------------------------------------------------------------------------
// Cytoscape colors & styles
// ---------------------------------------------------------------------------

const THEME_COLORS = {
  dark: {
    node:    '#4a90d9',
    topic:   '#5dc95d',
    service: '#d9a44a',
    action:  '#c97ddc',
    cyBg:         '#12121f',
    edge:         '#3a3a5a',
    edgePublish:  '#3a6080',
    edgeSubscribe:'#3a7040',
    edgeServes:   '#806030',
    edgeCalls:    '#807030',
    edgeActSrv:   '#703080',
    edgeActCli:   '#504080',
    edgeLabel:    '#8080a0',
    edgeLabelBg:  '#12121f',
    rootBorder:   '#ffffff',
    nodeFallback: '#333',
  },
  light: {
    node:    '#2a6ec4',
    topic:   '#2a9e2a',
    service: '#c47a10',
    action:  '#9a3abf',
    cyBg:         '#ffffff',
    edge:         '#a0a0c0',
    edgePublish:  '#2060a0',
    edgeSubscribe:'#206040',
    edgeServes:   '#a06010',
    edgeCalls:    '#a08010',
    edgeActSrv:   '#802090',
    edgeActCli:   '#503090',
    edgeLabel:    '#505080',
    edgeLabelBg:  '#f0f0f8',
    rootBorder:   '#1a1a2e',
    nodeFallback: '#aaaacc',
  },
};

function isLight() {
  return document.documentElement.dataset.theme === 'light';
}

function getThemeColors() {
  return isLight() ? THEME_COLORS.light : THEME_COLORS.dark;
}

function nsColorForName(name) {
  for (const rule of STATE.nsRules) {
    if (rule.pattern && name.includes(rule.pattern)) return rule.color;
  }
  return '#888888';
}

// Returns '#111' for light backgrounds, '#fff' for dark ones
function textColorForBg(hex) {
  const h = hex.length === 4
    ? '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3]
    : hex;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#111111' : '#ffffff';
}

function buildCyStyle() {
  const c = getThemeColors();
  const styles = [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'color': '#ffffff',
        'font-size': 10,
        'font-family': 'monospace',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 120,
        'width': 'label',
        'height': 'label',
        'padding': '8px',
        'shape': 'round-rectangle',
        'background-color': c.nodeFallback,
      },
    },
    {
      selector: "node[entityType='node']",
      style: { 'background-color': c.node },
    },
    {
      selector: "node[entityType='topic']",
      style: {
        'background-color': c.topic,
        'color': '#111',
        'shape': 'ellipse',
      },
    },
    {
      selector: "node[entityType='service']",
      style: {
        'background-color': c.service,
        'color': '#111',
        'shape': 'diamond',
      },
    },
    {
      selector: "node[entityType='action']",
      style: {
        'background-color': c.action,
        'shape': 'pentagon',
      },
    },
    {
      selector: 'node.selected-root',
      style: {
        'border-width': 3,
        'border-color': c.rootBorder,
        'border-style': 'solid',
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'line-color': c.edge,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': c.edge,
        'label': '',
        'width': 1.5,
      },
    },
    {
      selector: "edge[edgeType='publishes']",
      style: { 'line-color': c.edgePublish, 'target-arrow-color': c.edgePublish },
    },
    {
      selector: "edge[edgeType='subscribes']",
      style: { 'line-color': c.edgeSubscribe, 'target-arrow-color': c.edgeSubscribe },
    },
    {
      selector: "edge[edgeType='serves']",
      style: { 'line-color': c.edgeServes, 'target-arrow-color': c.edgeServes },
    },
    {
      selector: "edge[edgeType='calls']",
      style: { 'line-color': c.edgeCalls, 'target-arrow-color': c.edgeCalls },
    },
    {
      selector: "edge[edgeType='action_server']",
      style: { 'line-color': c.edgeActSrv, 'target-arrow-color': c.edgeActSrv },
    },
    {
      selector: "edge[edgeType='action_client']",
      style: { 'line-color': c.edgeActCli, 'target-arrow-color': c.edgeActCli },
    },
  ];

  if (STATE.colorMode === 'namespace') {
    styles.push({
      selector: 'node',
      style: {
        'background-color': 'data(nsColor)',
        'color': 'data(nsTextColor)',
        'shape': 'round-rectangle',
      },
    });
  }

  return styles;
}

// ---------------------------------------------------------------------------
// Cytoscape instance
// ---------------------------------------------------------------------------

let cy = null;

function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: [],
    style: buildCyStyle(),
    layout: { name: 'grid' },
    wheelSensitivity: 0.3,
  });

  cy.on('tap', 'node', function (evt) {
    const id = evt.target.id();
    if (id === '__truncated__') return;
    const entry = STATE.index[id];
    if (entry) selectEntity(entry.type, id, false);
  });

  cy.on('cxttap', 'node', function (evt) {
    const id = evt.target.id();
    if (id === '__truncated__') return;
    showCtxMenu(evt.originalEvent, id);
  });

  cy.on('tap', function () { hideCtxMenu(); });
}

// ---------------------------------------------------------------------------
// Data loading (file-based)
// ---------------------------------------------------------------------------

function buildIndex() {
  const idx = STATE.index = {};
  const d = STATE.data;
  for (const n of d.nodes)    idx[n.name] = { type: 'node',    obj: n };
  for (const t of d.topics)   idx[t.name] = { type: 'topic',   obj: t };
  for (const s of d.services) idx[s.name] = { type: 'service', obj: s };
  for (const a of d.actions)  idx[a.name] = { type: 'action',  obj: a };
}

function loadDataFromFile(file) {
  _showOverlayMessage('Loading…');
  const reader = new FileReader();
  reader.onload = e => {
    try {
      STATE.data = JSON.parse(e.target.result);
      buildIndex();
      hideOverlay();
      updateCollectedAt();
      STATE.selected = null;
      document.getElementById('details-empty').style.display = '';
      document.getElementById('details-content').style.display = 'none';
      renderSidebar();
    } catch (err) {
      showOverlayError('Invalid JSON: ' + err.message);
    }
  };
  reader.onerror = () => showOverlayError('Could not read file.');
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------------------

function showFilePicker() {
  const overlay = document.getElementById('overlay');
  overlay.classList.remove('hidden');
  document.getElementById('file-picker').style.display = '';
  const msgEl = document.getElementById('overlay-message');
  msgEl.style.display = 'none';
  msgEl.classList.remove('error');
  // reset file input so re-selecting same file triggers change event
  document.getElementById('data-file-input').value = '';
}

function _showOverlayMessage(msg) {
  document.getElementById('file-picker').style.display = 'none';
  const msgEl = document.getElementById('overlay-message');
  msgEl.style.display = '';
  msgEl.textContent = msg;
  msgEl.classList.remove('error');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

function showOverlayError(msg) {
  document.getElementById('file-picker').style.display = 'none';
  const overlay = document.getElementById('overlay');
  overlay.classList.remove('hidden');
  const msgEl = document.getElementById('overlay-message');
  msgEl.style.display = '';
  msgEl.textContent = msg + ' — click to try again';
  msgEl.classList.add('error');
  overlay.onclick = () => { overlay.onclick = null; showFilePicker(); };
}

function updateCollectedAt() {
  const ts = STATE.data?.collected_at;
  if (!ts) return;
  const d = new Date(ts);
  document.getElementById('collected-at').textContent =
    'Collected: ' + d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderSidebar() {
  const tab = STATE.activeTab;          // "nodes" | "topics" | "services" | "actions"
  const q = STATE.searchQuery.toLowerCase();
  const allItems = STATE.data?.[tab] ?? [];
  const items = allItems.filter(e => e.name.toLowerCase().includes(q));

  document.getElementById('search-count').textContent = `${items.length}`;

  // Show/hide all buttons reflect state of currently visible (filtered) items
  const allVisible = items.every(e => !STATE.hiddenEntities.has(e.name));
  const allHidden  = items.length > 0 && items.every(e => STATE.hiddenEntities.has(e.name));
  document.getElementById('vis-show-all').disabled = allVisible;
  document.getElementById('vis-hide-all').disabled = allHidden;

  const ul = document.getElementById('entity-list');
  ul.innerHTML = items.map(e => {
    const type = tab.slice(0, -1); // strip trailing 's'
    const active = STATE.selected?.name === e.name ? 'active' : '';
    const hidden = STATE.hiddenEntities.has(e.name);
    const checked = hidden ? '' : 'checked';
    const hiddenClass = hidden ? ' entity-hidden' : '';
    return `<li class="${active}${hiddenClass}" data-name="${e.name}" data-type="${type}">` +
      `<input type="checkbox" class="visibility-cb" ${checked} data-name="${e.name}" title="Toggle visibility in graph">` +
      `<span class="entity-name">${e.name}</span>` +
      `</li>`;
  }).join('');
}

function setVisibilityForCurrentTab(hide) {
  const tab = STATE.activeTab;
  const q = STATE.searchQuery.toLowerCase();
  const items = (STATE.data?.[tab] ?? []).filter(e => e.name.toLowerCase().includes(q));
  for (const e of items) {
    if (hide) STATE.hiddenEntities.add(e.name);
    else      STATE.hiddenEntities.delete(e.name);
  }
  saveHiddenToCookie();
  renderSidebar();
  if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
}

// ---------------------------------------------------------------------------
// Details panel rendering
// ---------------------------------------------------------------------------

function renderDetails(type, name) {
  const entry = STATE.index[name];
  if (!entry) return;

  document.getElementById('details-empty').style.display = 'none';
  document.getElementById('details-content').style.display = 'block';

  const badge = document.getElementById('details-type-badge');
  badge.textContent = type;
  badge.className = `badge-${type}`;

  document.getElementById('details-name').textContent = name;

  const obj = entry.obj;
  let html = '<table>';

  if (type === 'node') {
    html += detailRow('Publishers', obj.publishers.map(p =>
      `<a class="entry-link" data-name="${p.topic}" data-type="topic">${p.topic}</a>
       <span class="detail-type-tag">${p.type}</span>`
    ).join('') || '—');
    html += detailRow('Subscribers', obj.subscribers.map(s =>
      `<a class="entry-link" data-name="${s.topic}" data-type="topic">${s.topic}</a>
       <span class="detail-type-tag">${s.type}</span>`
    ).join('') || '—');
    html += detailRow('Service servers', obj.service_servers.map(s =>
      `<a class="entry-link" data-name="${s.service}" data-type="service">${s.service}</a>
       <span class="detail-type-tag">${s.type}</span>`
    ).join('') || '—');
    html += detailRow('Service clients', obj.service_clients.map(s =>
      `<a class="entry-link" data-name="${s.service}" data-type="service">${s.service}</a>
       <span class="detail-type-tag">${s.type}</span>`
    ).join('') || '—');
    html += detailRow('Action servers', obj.action_servers.map(a =>
      `<a class="entry-link" data-name="${a.action}" data-type="action">${a.action}</a>
       <span class="detail-type-tag">${a.type}</span>`
    ).join('') || '—');
    html += detailRow('Action clients', obj.action_clients.map(a =>
      `<a class="entry-link" data-name="${a.action}" data-type="action">${a.action}</a>
       <span class="detail-type-tag">${a.type}</span>`
    ).join('') || '—');

  } else if (type === 'topic') {
    html += detailRow('Type', obj.types.join(', ') || '—');
    html += detailRow('Publishers', obj.publishers.map(p =>
      `<a class="entry-link" data-name="${p.node}" data-type="node">${p.node}</a>` +
      renderQosInline(p.qos)
    ).join('') || '—');
    html += detailRow('Subscribers', obj.subscribers.map(s =>
      `<a class="entry-link" data-name="${s.node}" data-type="node">${s.node}</a>` +
      renderQosInline(s.qos)
    ).join('') || '—');

  } else if (type === 'service') {
    html += detailRow('Type', obj.types.join(', ') || '—');
    html += detailRow('Servers', obj.servers.map(s =>
      `<a class="entry-link" data-name="${s.node}" data-type="node">${s.node}</a>`
    ).join('') || '—');
    html += detailRow('Clients', obj.clients.map(c =>
      `<a class="entry-link" data-name="${c.node}" data-type="node">${c.node}</a>`
    ).join('') || '—');

  } else if (type === 'action') {
    html += detailRow('Type', obj.types.join(', ') || '—');
    html += detailRow('Servers', obj.servers.map(s =>
      `<a class="entry-link" data-name="${s.node}" data-type="node">${s.node}</a>`
    ).join('') || '—');
    html += detailRow('Clients', obj.clients.map(c =>
      `<a class="entry-link" data-name="${c.node}" data-type="node">${c.node}</a>`
    ).join('') || '—');
  }

  html += '</table>';
  document.getElementById('details-body').innerHTML = html;
}

function detailRow(label, value) {
  return `<tr><th>${label}</th><td>${value}</td></tr>`;
}

function renderQosInline(qos) {
  if (!qos || Object.keys(qos).length === 0) return '';
  const parts = Object.entries(qos)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
  return `<div class="qos-block">${parts}</div>`;
}

// ---------------------------------------------------------------------------
// Namespace color rules panel
// ---------------------------------------------------------------------------

function renderNsRulesPanel() {
  const panel = document.getElementById('ns-rules-panel');
  const toggle = document.getElementById('color-mode-toggle');
  if (STATE.colorMode !== 'namespace') {
    panel.classList.add('hidden');
    toggle.classList.remove('active');
    toggle.textContent = 'NS Colors';
    return;
  }
  panel.classList.remove('hidden');
  toggle.classList.add('active');
  toggle.textContent = 'Type Colors';

  const list = document.getElementById('ns-rules-list');
  list.innerHTML = STATE.nsRules.map((rule, i) =>
    `<div class="ns-rule-row" data-index="${i}">` +
    `<input type="color" class="ns-color-pick" value="${rule.color}" data-index="${i}" title="Pick color">` +
    `<input type="text" class="ns-pattern-input" value="${escHtml(rule.pattern)}" placeholder="/namespace/" data-index="${i}">` +
    `<button class="ns-rule-delete" data-index="${i}" title="Remove rule">×</button>` +
    `</div>`
  ).join('');
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

const MAX_GRAPH_ELEMENTS = 300;

// incomingEdge: the edgeType by which this entity was reached in BFS (null for root).
// For topics/services/actions, used to follow only the data-flow direction and avoid
// showing co-publishers/co-subscribers that have no information exchange with the source node.
function getNeighbors(name, type, incomingEdge) {
  const entry = STATE.index[name];
  if (!entry) return [];
  const obj = entry.obj;
  const result = [];

  if (type === 'node') {
    for (const p of obj.publishers)
      result.push({ name: p.topic, type: 'topic', edgeLabel: 'publishes', edgeType: 'publishes', dir: 'out' });
    for (const s of obj.subscribers)
      result.push({ name: s.topic, type: 'topic', edgeLabel: 'subscribes', edgeType: 'subscribes', dir: 'in' });
    for (const ss of obj.service_servers)
      result.push({ name: ss.service, type: 'service', edgeLabel: 'serves', edgeType: 'serves', dir: 'out' });
    for (const sc of obj.service_clients)
      result.push({ name: sc.service, type: 'service', edgeLabel: 'calls', edgeType: 'calls', dir: 'out' });
    for (const as_ of obj.action_servers)
      result.push({ name: as_.action, type: 'action', edgeLabel: 'action_server', edgeType: 'action_server', dir: 'out' });
    for (const ac of obj.action_clients)
      result.push({ name: ac.action, type: 'action', edgeLabel: 'action_client', edgeType: 'action_client', dir: 'out' });

  } else if (type === 'topic') {
    // Follow data-flow direction: publisher-side → subscribers; subscriber-side → publishers.
    // When reached without direction context (topic selected as root), expand both sides.
    const wantPubs = !incomingEdge || incomingEdge === 'subscribes';
    const wantSubs = !incomingEdge || incomingEdge === 'publishes';
    if (wantPubs)
      for (const p of obj.publishers)
        result.push({ name: p.node, type: 'node', edgeLabel: 'publishes', edgeType: 'publishes', dir: 'in' });
    if (wantSubs)
      for (const s of obj.subscribers)
        result.push({ name: s.node, type: 'node', edgeLabel: 'subscribes', edgeType: 'subscribes', dir: 'out' });

  } else if (type === 'service') {
    const wantServers = !incomingEdge || incomingEdge === 'calls';
    const wantClients = !incomingEdge || incomingEdge === 'serves';
    if (wantServers)
      for (const s of obj.servers)
        result.push({ name: s.node, type: 'node', edgeLabel: 'serves', edgeType: 'serves', dir: 'in' });
    if (wantClients)
      for (const c of obj.clients)
        result.push({ name: c.node, type: 'node', edgeLabel: 'calls', edgeType: 'calls', dir: 'in' });

  } else if (type === 'action') {
    const wantServers = !incomingEdge || incomingEdge === 'action_client';
    const wantClients = !incomingEdge || incomingEdge === 'action_server';
    if (wantServers)
      for (const s of obj.servers)
        result.push({ name: s.node, type: 'node', edgeLabel: 'action_server', edgeType: 'action_server', dir: 'in' });
    if (wantClients)
      for (const c of obj.clients)
        result.push({ name: c.node, type: 'node', edgeLabel: 'action_client', edgeType: 'action_client', dir: 'in' });
  }

  return result;
}

function buildGraphElements(type, name, depth) {
  const visited = new Set();
  const edgeSet = new Set();
  const nodeElements = [];
  const pendingEdges = [];
  const queue = [{ name, type, hop: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    if (nodeElements.length >= MAX_GRAPH_ELEMENTS) {
      truncated = true;
      break;
    }

    const { name: cur, type: curType, hop, incomingEdge } = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);

    const label = shortLabel(cur);
    const isRoot = (cur === name);
    const nsColor = nsColorForName(cur);
    nodeElements.push({
      group: 'nodes',
      data: { id: cur, label, entityType: curType, nsColor, nsTextColor: textColorForBg(nsColor) },
      classes: isRoot ? 'selected-root' : '',
    });

    if (hop >= depth) continue;

    const neighbors = getNeighbors(cur, curType, incomingEdge);
    for (const nb of neighbors) {
      // Edge: source=publisher/server, target=subscriber/client
      let src, tgt;
      if (nb.dir === 'out') {
        src = cur; tgt = nb.name;
      } else {
        src = nb.name; tgt = cur;
      }
      const edgeId = `${src}--${nb.edgeType}--${tgt}`;
      if (!edgeSet.has(edgeId)) {
        edgeSet.add(edgeId);
        pendingEdges.push({
          group: 'edges',
          data: { id: edgeId, source: src, target: tgt, label: nb.edgeLabel, edgeType: nb.edgeType },
        });
      }
      if (!visited.has(nb.name)) {
        queue.push({ name: nb.name, type: nb.type, hop: hop + 1, incomingEdge: nb.edgeType });
      }
    }
  }

  if (truncated) {
    nodeElements.push({
      group: 'nodes',
      data: { id: '__truncated__', label: '... truncated', entityType: 'info' },
    });
  }

  // Apply type and individual entity visibility filters (root node is always kept)
  const visibleNodes = nodeElements.filter(n =>
    n.data.id === name ||
    (!STATE.hiddenTypes.has(n.data.entityType) && !STATE.hiddenEntities.has(n.data.id))
  );
  const visibleIds = new Set(visibleNodes.map(n => n.data.id));

  // Only include edges where both endpoints are visible
  const validEdges = pendingEdges.filter(e =>
    visibleIds.has(e.data.source) && visibleIds.has(e.data.target)
  );

  // Drop nodes that have no visible edges (all their connections were filtered out).
  // The root is always kept even if isolated.
  const connectedIds = new Set([name]);
  for (const e of validEdges) {
    connectedIds.add(e.data.source);
    connectedIds.add(e.data.target);
  }
  const connectedNodes = visibleNodes.filter(n => connectedIds.has(n.data.id));

  return [...connectedNodes, ...validEdges];
}

function shortLabel(name) {
  // Show last two path segments for readability
  const parts = name.split('/').filter(Boolean);
  if (parts.length <= 2) return name;
  return '.../' + parts.slice(-2).join('/');
}

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------

function renderGraph(type, name, depth) {
  const elements = buildGraphElements(type, name, depth);
  const container = document.getElementById('cy');

  container.style.opacity = '0';

  cy.batch(() => {
    cy.elements().remove();
    cy.add(elements);
  });

  const count = elements.length;

  const layoutOpts = {
    name: 'dagre',
    rankDir: 'LR',
    ranker: count > 300 ? 'longest-path' : 'network-simplex',
    nodeSep: 40,
    rankSep: 120,
    animate: false,
    fit: true,
    padding: 40,
  };

  const layout = cy.layout(layoutOpts);
  layout.one('layoutstop', () => { container.style.opacity = '1'; });
  layout.run();
}

// ---------------------------------------------------------------------------
// Entity selection
// ---------------------------------------------------------------------------

function selectEntity(type, name, scrollSidebar = true) {
  // Update tab if needed
  const tabName = type + 's';
  if (STATE.activeTab !== tabName) {
    STATE.activeTab = tabName;
    STATE.searchQuery = '';
    document.getElementById('search').value = '';
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.type === tabName);
    });
  }

  STATE.selected = { type, name };
  renderSidebar();
  renderDetails(type, name);
  renderGraph(type, name, STATE.depth);

  if (scrollSidebar) {
    const active = document.querySelector('#entity-list li.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      STATE.activeTab = btn.dataset.type;
      STATE.searchQuery = '';
      document.getElementById('search').value = '';
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t === btn)
      );
      renderSidebar();
    });
  });

  // Search input
  document.getElementById('search').addEventListener('input', e => {
    STATE.searchQuery = e.target.value;
    renderSidebar();
  });

  // Entity list click
  document.getElementById('entity-list').addEventListener('click', e => {
    if (e.target.classList.contains('visibility-cb')) {
      toggleEntityVisibility(e.target.dataset.name);
      return;
    }
    const li = e.target.closest('li');
    if (!li) return;
    selectEntity(li.dataset.type, li.dataset.name);
  });

  // Show all / Hide all buttons
  document.getElementById('vis-show-all').addEventListener('click', () => setVisibilityForCurrentTab(false));
  document.getElementById('vis-hide-all').addEventListener('click', () => setVisibilityForCurrentTab(true));

  // Legend type filters
  document.querySelectorAll('.legend-item[data-type]').forEach(item => {
    item.addEventListener('click', () => {
      const t = item.dataset.type;
      if (STATE.hiddenTypes.has(t)) {
        STATE.hiddenTypes.delete(t);
        item.classList.remove('hidden');
      } else {
        STATE.hiddenTypes.add(t);
        item.classList.add('hidden');
      }
      if (STATE.selected) {
        renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
      }
    });
  });

  // Depth slider
  const slider = document.getElementById('depth-slider');
  const depthLabel = document.getElementById('depth-value');
  slider.addEventListener('input', () => {
    STATE.depth = parseInt(slider.value, 10);
    depthLabel.textContent = STATE.depth;
    if (STATE.selected) {
      renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
    }
  });

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const html = document.documentElement;
    const light = html.dataset.theme === 'light';
    html.dataset.theme = light ? '' : 'light';
    document.getElementById('theme-toggle').textContent = light ? '☀' : '☾';
    cy.style(buildCyStyle());
  });

  // "Open file" button in header
  document.getElementById('open-file-btn').addEventListener('click', showFilePicker);

  // File picker overlay: file input
  document.getElementById('data-file-input').addEventListener('change', function () {
    if (this.files[0]) loadDataFromFile(this.files[0]);
  });

  // File picker overlay: drag & drop
  const overlay = document.getElementById('overlay');
  overlay.addEventListener('dragover', e => {
    e.preventDefault();
    overlay.classList.add('drag-over');
  });
  overlay.addEventListener('dragleave', () => overlay.classList.remove('drag-over'));
  overlay.addEventListener('drop', e => {
    e.preventDefault();
    overlay.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadDataFromFile(file);
  });

  // Clickable links in details panel (navigate to entity)
  document.getElementById('details-body').addEventListener('click', e => {
    const a = e.target.closest('.entry-link');
    if (!a) return;
    const entryName = a.dataset.name;
    const entryType = a.dataset.type;
    if (entryName && entryType && STATE.index[entryName]) {
      selectEntity(entryType, entryName);
    }
  });
}

// ---------------------------------------------------------------------------
// Right-click context menu
// ---------------------------------------------------------------------------

let _ctxTargetId = null;

function showCtxMenu(mouseEvt, nodeId) {
  _ctxTargetId = nodeId;
  const isHidden = STATE.hiddenEntities.has(nodeId);
  const menu = document.getElementById('cy-ctx-menu');
  document.getElementById('ctx-toggle-vis').textContent = isHidden ? 'Show in graph' : 'Hide from graph';
  menu.classList.remove('hidden');

  // Position relative to #main container
  const main = document.getElementById('main');
  const rect = main.getBoundingClientRect();
  let x = mouseEvt.clientX - rect.left;
  let y = mouseEvt.clientY - rect.top;
  // Keep menu inside container
  if (x + 170 > rect.width)  x = rect.width - 175;
  if (y + 80  > rect.height) y = rect.height - 85;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideCtxMenu() {
  document.getElementById('cy-ctx-menu').classList.add('hidden');
  _ctxTargetId = null;
}

function wireCtxMenu() {
  document.getElementById('ctx-toggle-vis').addEventListener('click', () => {
    if (_ctxTargetId) toggleEntityVisibility(_ctxTargetId);
    hideCtxMenu();
  });

  document.getElementById('ctx-select-entity').addEventListener('click', () => {
    if (_ctxTargetId) {
      const entry = STATE.index[_ctxTargetId];
      if (entry) selectEntity(entry.type, _ctxTargetId);
    }
    hideCtxMenu();
  });

  document.addEventListener('click', e => {
    const menu = document.getElementById('cy-ctx-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
      hideCtxMenu();
    }
  });
}

// ---------------------------------------------------------------------------
// Namespace color rules wiring
// ---------------------------------------------------------------------------

function wireNsRules() {
  document.getElementById('color-mode-toggle').addEventListener('click', () => {
    STATE.colorMode = STATE.colorMode === 'type' ? 'namespace' : 'type';
    cy.style(buildCyStyle());
    renderNsRulesPanel();
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  });

  document.getElementById('ns-add-rule').addEventListener('click', () => {
    STATE.nsRules.push({ pattern: '', color: '#88cc88' });
    saveNsRulesToCookie();
    renderNsRulesPanel();
  });

  document.getElementById('ns-rules-list').addEventListener('input', e => {
    const idx = parseInt(e.target.dataset.index, 10);
    if (isNaN(idx)) return;
    if (e.target.classList.contains('ns-color-pick')) {
      STATE.nsRules[idx].color = e.target.value;
    } else if (e.target.classList.contains('ns-pattern-input')) {
      STATE.nsRules[idx].pattern = e.target.value;
    }
    saveNsRulesToCookie();
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  });

  document.getElementById('ns-rules-list').addEventListener('click', e => {
    if (!e.target.classList.contains('ns-rule-delete')) return;
    const idx = parseInt(e.target.dataset.index, 10);
    if (isNaN(idx)) return;
    STATE.nsRules.splice(idx, 1);
    saveNsRulesToCookie();
    renderNsRulesPanel();
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  });
}

// ---------------------------------------------------------------------------
// Layout resize handles
// ---------------------------------------------------------------------------

function getPanelCookie(name) {
  const m = document.cookie.split(';').find(c => c.trim().startsWith(name + '='));
  return m ? parseInt(m.trim().slice(name.length + 1), 10) : null;
}

function setPanelCookie(name, value) {
  document.cookie = `${name}=${value}; max-age=31536000; path=/`;
}

function initResizeHandles() {
  // Restore saved sizes
  const savedSidebarW = getPanelCookie('ros2_sidebar_w');
  if (savedSidebarW) document.getElementById('sidebar').style.width = savedSidebarW + 'px';

  const savedDetailsH = getPanelCookie('ros2_details_h');
  if (savedDetailsH) document.getElementById('details-panel').style.height = savedDetailsH + 'px';

  if ((savedSidebarW || savedDetailsH) && cy) cy.resize();

  // Sidebar width (horizontal drag)
  const sidebarHandle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  initDrag(sidebarHandle, {
    onStart: () => ({ start: sidebar.offsetWidth }),
    onMove: ({ startVal, delta }) => {
      const w = Math.max(150, Math.min(600, startVal + delta.x));
      sidebar.style.width = w + 'px';
      if (cy) cy.resize();
    },
    onEnd: () => {
      if (cy) cy.resize();
      setPanelCookie('ros2_sidebar_w', sidebar.offsetWidth);
    },
  });

  // Details panel height (vertical drag)
  const detailsHandle = document.getElementById('details-resize');
  const detailsPanel = document.getElementById('details-panel');
  initDrag(detailsHandle, {
    onStart: () => ({ start: detailsPanel.offsetHeight }),
    onMove: ({ startVal, delta }) => {
      const h = Math.max(60, Math.min(window.innerHeight - 160, startVal + delta.y));
      detailsPanel.style.height = h + 'px';
      if (cy) cy.resize();
    },
    onEnd: () => {
      if (cy) cy.resize();
      setPanelCookie('ros2_details_h', detailsPanel.offsetHeight);
    },
  });
}

function initDrag(handle, { onStart, onMove, onEnd }) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const { start: startVal } = onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = handle.classList.contains('resize-handle-v') ? 'col-resize' : 'row-resize';

    const onMouseMove = ev => {
      onMove({ startVal, delta: { x: ev.clientX - startX, y: ev.clientY - startY } });
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      onEnd();
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ---------------------------------------------------------------------------
// Settings export / import
// ---------------------------------------------------------------------------

const SETTINGS_VERSION = 1;

function gatherSettings() {
  return {
    version: SETTINGS_VERSION,
    hiddenEntities: [...STATE.hiddenEntities],
    hiddenTypes:    [...STATE.hiddenTypes],
    nsRules:        STATE.nsRules,
    colorMode:      STATE.colorMode,
    depth:          STATE.depth,
    theme:          document.documentElement.dataset.theme || '',
    sidebarWidth:   document.getElementById('sidebar').offsetWidth || null,
    detailsHeight:  document.getElementById('details-panel').offsetHeight || null,
  };
}

// Registry of known settings keys. Add new entries here when new settings appear.
// Each applier receives the raw value and applies it to STATE / DOM.
function buildAppliers() {
  return {
    hiddenEntities: v => {
      if (Array.isArray(v)) STATE.hiddenEntities = new Set(v);
    },
    hiddenTypes: v => {
      if (Array.isArray(v)) STATE.hiddenTypes = new Set(v);
    },
    nsRules: v => {
      if (Array.isArray(v)) STATE.nsRules = v;
    },
    colorMode: v => {
      if (v === 'type' || v === 'namespace') STATE.colorMode = v;
    },
    depth: v => {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 6) {
        STATE.depth = n;
        const slider = document.getElementById('depth-slider');
        const label  = document.getElementById('depth-value');
        if (slider) slider.value = n;
        if (label)  label.textContent = n;
      }
    },
    theme: v => {
      const t = (v === 'light') ? 'light' : '';
      document.documentElement.dataset.theme = t;
      const btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = (t === 'light') ? '☾' : '☀';
      if (cy) cy.style(buildCyStyle());
    },
    sidebarWidth: v => {
      const n = parseInt(v, 10);
      if (n >= 150 && n <= 600) {
        document.getElementById('sidebar').style.width = n + 'px';
        setPanelCookie('ros2_sidebar_w', n);
        if (cy) cy.resize();
      }
    },
    detailsHeight: v => {
      const n = parseInt(v, 10);
      if (n >= 60) {
        document.getElementById('details-panel').style.height = n + 'px';
        setPanelCookie('ros2_details_h', n);
        if (cy) cy.resize();
      }
    },
  };
}

function applySettings(raw) {
  const appliers = buildAppliers();
  for (const [key, applyFn] of Object.entries(appliers)) {
    if (key in raw) {
      try { applyFn(raw[key]); } catch {}
    }
  }
  saveHiddenToCookie();
  saveNsRulesToCookie();
}

function exportSettings() {
  const settings = gatherSettings();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ros2_analyzer_settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

function wireSettingsIO() {
  document.getElementById('settings-export').addEventListener('click', exportSettings);

  document.getElementById('settings-import').addEventListener('click', () => {
    document.getElementById('settings-file-input').click();
  });

  document.getElementById('settings-file-input').addEventListener('change', async function () {
    const file = this.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      applySettings(raw);
      renderNsRulesPanel();
      renderSidebar();
      if (cy) cy.style(buildCyStyle());
      document.querySelectorAll('.legend-item[data-type]').forEach(item => {
        item.classList.toggle('hidden', STATE.hiddenTypes.has(item.dataset.type));
      });
      if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
    } catch (e) {
      alert('Failed to load settings: ' + e.message);
    }
    this.value = '';
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

loadHiddenFromCookie();
loadNsRulesFromCookie();
initCytoscape();
initResizeHandles();
wireEvents();
wireCtxMenu();
wireNsRules();
wireSettingsIO();
showFilePicker();
