'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

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
  nodeAnalyzeMode: false,    // collapse topics/services/actions into node-to-node edges
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

function loadNodeAnalyzeModeFromCookie() {
  const m = document.cookie.split(';').find(c => c.trim().startsWith('ros2_node_analyze='));
  if (m) STATE.nodeAnalyzeMode = m.trim().slice('ros2_node_analyze='.length) === '1';
}

function saveNodeAnalyzeModeToCookie() {
  document.cookie = `ros2_node_analyze=${STATE.nodeAnalyzeMode ? 1 : 0}; max-age=31536000; path=/`;
}

function toggleEntityVisibility(name) {
  if (STATE.hiddenEntities.has(name)) {
    STATE.hiddenEntities.delete(name);
  } else {
    STATE.hiddenEntities.add(name);
  }
  saveHiddenToCookie();
  renderSidebar();
  applyVisibilityToExistingGraph();
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

let _styleCache = null;
let _styleCacheKey = null;

function buildCyStyleCached() {
  const key = `${STATE.colorMode}|${document.body.dataset.theme ?? ''}|${JSON.stringify(STATE.nsRules)}`;
  if (key === _styleCacheKey && _styleCache) return _styleCache;
  _styleCache = buildCyStyle();
  _styleCacheKey = key;
  return _styleCache;
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
    // Node Analyze mode: one edge per intermediate topic/service/action
    {
      selector: "edge[edgeType='topic']",
      style: { 'line-color': c.topic, 'target-arrow-color': c.topic },
    },
    {
      selector: "edge[edgeType='service']",
      style: { 'line-color': c.service, 'target-arrow-color': c.service },
    },
    {
      selector: "edge[edgeType='action']",
      style: { 'line-color': c.action, 'target-arrow-color': c.action },
    },
    {
      selector: 'edge[?analyzeEdge]',
      style: {
        'label': 'data(label)',
        'color': c.edgeLabel,
        'font-size': 9,
        'font-family': 'monospace',
        'text-rotation': 'autorotate',
        'text-background-color': c.edgeLabelBg,
        'text-background-opacity': 0.7,
        'text-background-padding': '2px',
        'width': 2,
      },
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
    styles.push({
      selector: 'edge[?analyzeEdge]',
      style: {
        'line-color': 'data(nsColor)',
        'target-arrow-color': 'data(nsColor)',
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
    style: buildCyStyleCached(),
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
  _neighborsCache = null;
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
      updateScriptButtonsState();
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
  const name = STATE.data?.build_name;
  const label = (name ? name + ' — ' : '') + 'Collected: ' + d.toLocaleString();
  document.getElementById('collected-at').textContent = label;
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

  const MAX_SIDEBAR_ITEMS = 200;
  const visibleItems = items.length > MAX_SIDEBAR_ITEMS ? items.slice(0, MAX_SIDEBAR_ITEMS) : items;
  const truncated = items.length > MAX_SIDEBAR_ITEMS;

  const ul = document.getElementById('entity-list');
  ul.innerHTML = visibleItems.map(e => {
    const type = tab.slice(0, -1); // strip trailing 's'
    const active = STATE.selected?.name === e.name ? 'active' : '';
    const hidden = STATE.hiddenEntities.has(e.name);
    const checked = hidden ? '' : 'checked';
    const hiddenClass = hidden ? ' entity-hidden' : '';
    return `<li class="${active}${hiddenClass}" data-name="${e.name}" data-type="${type}">` +
      `<input type="checkbox" class="visibility-cb" ${checked} data-name="${e.name}" title="Toggle visibility in graph">` +
      `<span class="entity-name">${e.name}</span>` +
      `</li>`;
  }).join('') + (truncated
    ? `<li class="sidebar-truncated">Showing ${MAX_SIDEBAR_ITEMS} of ${items.length} — refine search to see more</li>`
    : '');
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
  applyVisibilityToExistingGraph();
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

let _neighborsCache = null;

function getNeighborsCached(name, type, incomingEdge) {
  if (!_neighborsCache) _neighborsCache = new Map();
  const key = `${name}|${type}|${incomingEdge ?? ''}`;
  if (_neighborsCache.has(key)) return _neighborsCache.get(key);
  const result = getNeighbors(name, type, incomingEdge);
  _neighborsCache.set(key, result);
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

    const neighbors = getNeighborsCached(cur, curType, incomingEdge);
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

// Node Analyze mode: collapse intermediate topics/services/actions into direct node-to-node edges.
function buildNodeAnalyzeElements(name, depth) {
  const visited = new Set();
  const edgeSet = new Set();
  const nodeElements = [];
  const pendingEdges = [];
  const queue = [{ name, hop: 0 }];
  let truncated = false;

  const addEdge = (src, tgt, intermediateEntity, edgeType) => {
    if (src === tgt) return;
    if (STATE.hiddenEntities.has(intermediateEntity)) return;
    if (STATE.hiddenTypes.has(edgeType)) return;
    const edgeId = `${src}--${intermediateEntity}--${tgt}`;
    if (edgeSet.has(edgeId)) return;
    edgeSet.add(edgeId);
    pendingEdges.push({
      group: 'edges',
      data: {
        id: edgeId,
        source: src,
        target: tgt,
        label: shortLabel(intermediateEntity),
        edgeType,
        analyzeEdge: true,
        nsColor: nsColorForName(intermediateEntity),
      },
    });
  };

  while (queue.length > 0) {
    if (nodeElements.length >= MAX_GRAPH_ELEMENTS) {
      truncated = true;
      break;
    }

    const { name: cur, hop } = queue.shift();
    if (visited.has(cur)) continue;

    const entry = STATE.index[cur];
    if (!entry || entry.type !== 'node') continue;

    if (cur !== name && (STATE.hiddenEntities.has(cur) || STATE.hiddenTypes.has('node'))) continue;

    visited.add(cur);

    const isRoot = cur === name;
    const nsColor = nsColorForName(cur);
    nodeElements.push({
      group: 'nodes',
      data: { id: cur, label: shortLabel(cur), entityType: 'node', nsColor, nsTextColor: textColorForBg(nsColor) },
      classes: isRoot ? 'selected-root' : '',
    });

    if (hop >= depth) continue;

    const obj = entry.obj;

    const canVisit = n => !visited.has(n) && !STATE.hiddenEntities.has(n) && !STATE.hiddenTypes.has('node');

    for (const pub of obj.publishers) {
      const te = STATE.index[pub.topic];
      if (!te) continue;
      for (const sub of te.obj.subscribers) {
        addEdge(cur, sub.node, pub.topic, 'topic');
        if (canVisit(sub.node)) queue.push({ name: sub.node, hop: hop + 1 });
      }
    }

    for (const sub of obj.subscribers) {
      const te = STATE.index[sub.topic];
      if (!te) continue;
      for (const pub of te.obj.publishers) {
        addEdge(pub.node, cur, sub.topic, 'topic');
        if (canVisit(pub.node)) queue.push({ name: pub.node, hop: hop + 1 });
      }
    }

    for (const srv of obj.service_servers) {
      const se = STATE.index[srv.service];
      if (!se) continue;
      for (const cli of se.obj.clients) {
        addEdge(cli.node, cur, srv.service, 'service');
        if (canVisit(cli.node)) queue.push({ name: cli.node, hop: hop + 1 });
      }
    }

    for (const cli of obj.service_clients) {
      const se = STATE.index[cli.service];
      if (!se) continue;
      for (const srv of se.obj.servers) {
        addEdge(cur, srv.node, cli.service, 'service');
        if (canVisit(srv.node)) queue.push({ name: srv.node, hop: hop + 1 });
      }
    }

    for (const srv of obj.action_servers) {
      const ae = STATE.index[srv.action];
      if (!ae) continue;
      for (const cli of ae.obj.clients) {
        addEdge(cli.node, cur, srv.action, 'action');
        if (canVisit(cli.node)) queue.push({ name: cli.node, hop: hop + 1 });
      }
    }

    for (const cli of obj.action_clients) {
      const ae = STATE.index[cli.action];
      if (!ae) continue;
      for (const srv of ae.obj.servers) {
        addEdge(cur, srv.node, cli.action, 'action');
        if (canVisit(srv.node)) queue.push({ name: srv.node, hop: hop + 1 });
      }
    }
  }

  if (truncated) {
    nodeElements.push({
      group: 'nodes',
      data: { id: '__truncated__', label: '... truncated', entityType: 'info' },
    });
  }

  const visibleNodes = nodeElements.filter(n =>
    n.data.id === name ||
    n.data.id === '__truncated__' ||
    (!STATE.hiddenEntities.has(n.data.id) && !STATE.hiddenTypes.has(n.data.entityType))
  );
  const visibleIds = new Set(visibleNodes.map(n => n.data.id));

  const validEdges = pendingEdges.filter(e =>
    visibleIds.has(e.data.source) && visibleIds.has(e.data.target)
  );

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

function applyVisibilityToExistingGraph() {
  if (!cy) return;
  cy.batch(() => {
    cy.nodes().forEach(n => {
      if (n.id() === '__truncated__') return;
      const entityType = n.data('entityType');
      const hidden = STATE.hiddenTypes.has(entityType) || STATE.hiddenEntities.has(n.id());
      n.style('display', hidden ? 'none' : 'element');
    });
    cy.edges().forEach(e => {
      const srcHidden = e.source().style('display') === 'none';
      const tgtHidden = e.target().style('display') === 'none';
      e.style('display', (srcHidden || tgtHidden) ? 'none' : 'element');
    });
  });
}

function renderGraph(type, name, depth) {
  const elements = (STATE.nodeAnalyzeMode && type === 'node')
    ? buildNodeAnalyzeElements(name, depth)
    : buildGraphElements(type, name, depth);
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
  const debouncedRenderSidebar = debounce(renderSidebar, 150);
  document.getElementById('search').addEventListener('input', e => {
    STATE.searchQuery = e.target.value;
    debouncedRenderSidebar();
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
      applyVisibilityToExistingGraph();
    });
  });

  // Refresh layout button
  document.getElementById('graph-refresh-btn').addEventListener('click', () => {
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  });

  // Node Analyze toggle
  document.getElementById('node-analyze-toggle').addEventListener('click', () => {
    STATE.nodeAnalyzeMode = !STATE.nodeAnalyzeMode;
    document.getElementById('node-analyze-toggle').classList.toggle('active', STATE.nodeAnalyzeMode);
    saveNodeAnalyzeModeToCookie();
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  });

  // Depth slider
  const slider = document.getElementById('depth-slider');
  const depthLabel = document.getElementById('depth-value');
  const debouncedRenderGraph = debounce(() => {
    if (STATE.selected) renderGraph(STATE.selected.type, STATE.selected.name, STATE.depth);
  }, 200);
  slider.addEventListener('input', () => {
    STATE.depth = parseInt(slider.value, 10);
    depthLabel.textContent = STATE.depth;
    debouncedRenderGraph();
  });

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const html = document.documentElement;
    const light = html.dataset.theme === 'light';
    html.dataset.theme = light ? '' : 'light';
    document.getElementById('theme-toggle').textContent = light ? '☀' : '☾';
    cy.style(buildCyStyleCached());
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
    cy.style(buildCyStyleCached());
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

  // Restore scripts panel size and collapsed state
  const savedScriptsW = getCookieStr('ros2_scripts_w');
  if (savedScriptsW) document.getElementById('scripts-panel').style.width = parseInt(savedScriptsW, 10) + 'px';
  if (getCookieStr('ros2_scripts_collapsed') === '1') applyScriptsPanelCollapsed(true);
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
    nodeAnalyzeMode: STATE.nodeAnalyzeMode,
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
    nodeAnalyzeMode: v => {
      STATE.nodeAnalyzeMode = !!v;
      const btn = document.getElementById('node-analyze-toggle');
      if (btn) btn.classList.toggle('active', STATE.nodeAnalyzeMode);
      saveNodeAnalyzeModeToCookie();
    },
    theme: v => {
      const t = (v === 'light') ? 'light' : '';
      document.documentElement.dataset.theme = t;
      const btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = (t === 'light') ? '☾' : '☀';
      if (cy) cy.style(buildCyStyleCached());
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
      if (cy) cy.style(buildCyStyleCached());
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
loadNodeAnalyzeModeFromCookie();
initCytoscape();
initResizeHandles();
wireEvents();
wireCtxMenu();
wireNsRules();
wireSettingsIO();
if (STATE.nodeAnalyzeMode) {
  document.getElementById('node-analyze-toggle').classList.add('active');
}
initScriptsPanelResize();
wireScriptsPanel();
wireScriptModal();
showFilePicker();

// ---------------------------------------------------------------------------
// Scripts panel — cookie helper, resize, collapse
// ---------------------------------------------------------------------------

function getCookieStr(name) {
  const m = document.cookie.split(';').find(c => c.trim().startsWith(name + '='));
  return m ? m.trim().slice(name.length + 1) : null;
}

function updateScriptButtonsState() {
  document.querySelectorAll('.script-btn').forEach(b => { b.disabled = STATE.data === null; });
}

function initScriptsPanelResize() {
  const panel  = document.getElementById('scripts-panel');
  const handle = document.getElementById('scripts-resize');

  const savedOut = getCookieStr('ros2_scripts_output') || 'modal';
  document.getElementById(savedOut === 'tab' ? 'scripts-out-tab' : 'scripts-out-modal').checked = true;

  // Handle is LEFT of panel, so dragging right shrinks panel: width = startVal - delta.x
  initDrag(handle, {
    onStart: () => ({ start: panel.offsetWidth }),
    onMove: ({ startVal, delta }) => {
      panel.style.width = Math.max(180, Math.min(520, startVal - delta.x)) + 'px';
      if (cy) cy.resize();
    },
    onEnd: () => {
      if (cy) cy.resize();
      setPanelCookie('ros2_scripts_w', panel.offsetWidth);
    },
  });

  document.getElementById('scripts-collapse-btn').addEventListener('click', () => {
    const collapsed = !panel.classList.contains('collapsed');
    applyScriptsPanelCollapsed(collapsed);
    setPanelCookie('ros2_scripts_collapsed', collapsed ? '1' : '0');
  });

  document.querySelectorAll('input[name="scripts_output"]').forEach(r =>
    r.addEventListener('change', () => setPanelCookie('ros2_scripts_output', r.value))
  );
}

function applyScriptsPanelCollapsed(collapsed) {
  document.getElementById('scripts-panel').classList.toggle('collapsed', collapsed);
  document.getElementById('scripts-resize').classList.toggle('panel-collapsed', collapsed);
  if (cy) cy.resize();
}

function getScriptsOutputMode() {
  return document.querySelector('input[name="scripts_output"]:checked')?.value ?? 'modal';
}

// ---------------------------------------------------------------------------
// Scripts — analytics
// ---------------------------------------------------------------------------

function scriptLostNodes() {
  const results = [];
  for (const node of STATE.data.nodes) {
    if (node.publishers.length > 0) {
      const orphans = node.publishers.filter(p => {
        const e = STATE.index[p.topic];
        return !e || (e.obj.subscribers ?? []).length === 0;
      });
      if (orphans.length === node.publishers.length)
        results.push({ node: node.name, category: 'Publishes to void', topics: orphans.map(p => p.topic) });
    }
    if (node.subscribers.length > 0) {
      const orphans = node.subscribers.filter(s => {
        const e = STATE.index[s.topic];
        return !e || (e.obj.publishers ?? []).length === 0;
      });
      if (orphans.length === node.subscribers.length)
        results.push({ node: node.name, category: 'Listens to void', topics: orphans.map(s => s.topic) });
    }
  }
  return results;
}

function scriptHeavyTopics(threshold) {
  const n = Math.max(1, parseInt(threshold, 10) || 3);
  return STATE.data.topics
    .filter(t => (t.publishers ?? []).length > n)
    .map(t => ({
      name: t.name,
      pubCount: t.publishers.length,
      subCount: (t.subscribers ?? []).length,
      types: (t.types ?? []).join(', ') || '—',
    }))
    .sort((a, b) => b.pubCount - a.pubCount);
}

// pub BEST_EFFORT + sub RELIABLE = incompatible
// pub VOLATILE + sub TRANSIENT_LOCAL = incompatible
function scriptQosErrors() {
  const RULES = [
    { field: 'reliability', check: (p, s) => p === 'BEST_EFFORT' && s === 'RELIABLE' },
    { field: 'durability',  check: (p, s) => p === 'VOLATILE'    && s === 'TRANSIENT_LOCAL' },
  ];
  const results = [];
  for (const topic of STATE.data.topics) {
    const pubs = (topic.publishers  ?? []).filter(p => p.qos && Object.keys(p.qos).length > 0);
    const subs = (topic.subscribers ?? []).filter(s => s.qos && Object.keys(s.qos).length > 0);
    if (!pubs.length || !subs.length) continue;
    for (const rule of RULES) {
      const pv = [...new Set(pubs.map(p => (p.qos[rule.field] || '').toUpperCase()).filter(Boolean))];
      const sv = [...new Set(subs.map(s => (s.qos[rule.field] || '').toUpperCase()).filter(Boolean))];
      if (pv.length && sv.length && pv.some(p => sv.some(s => rule.check(p, s))))
        results.push({ topic: topic.name, field: rule.field, pubValues: pv, subValues: sv });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Scripts — HTML builders
// ---------------------------------------------------------------------------

function buildLostNodesHtml(rows) {
  if (!rows.length) return '<p class="script-result-empty">No orphan nodes found.</p>';
  const trs = rows.map(r =>
    `<tr><td>${escHtml(r.node)}</td>` +
    `<td><span class="result-category-badge">${escHtml(r.category)}</span></td>` +
    `<td>${r.topics.map(escHtml).join('<br>')}</td></tr>`
  ).join('');
  return `<table class="script-result-table"><thead><tr><th>Node</th><th>Category</th><th>Topics</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function buildHeavyTopicsHtml(rows, n) {
  if (!rows.length) return `<p class="script-result-empty">No topics with more than ${n} publishers.</p>`;
  const trs = rows.map(r =>
    `<tr><td>${escHtml(r.name)}</td><td>${r.pubCount}</td><td>${r.subCount}</td><td>${escHtml(r.types)}</td></tr>`
  ).join('');
  return `<table class="script-result-table"><thead><tr><th>Topic</th><th>Pubs</th><th>Subs</th><th>Types</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function buildQosErrorsHtml(rows) {
  if (!rows.length) return '<p class="script-result-empty">No QoS errors found.</p>';
  const trs = rows.map(r =>
    `<tr><td>${escHtml(r.topic)}</td>` +
    `<td class="qos-conflict">${escHtml(r.field)}</td>` +
    `<td>${r.pubValues.map(escHtml).join(', ')}</td>` +
    `<td>${r.subValues.map(escHtml).join(', ')}</td></tr>`
  ).join('');
  return `<table class="script-result-table"><thead><tr><th>Topic</th><th>Field</th><th>Publisher(s)</th><th>Subscriber(s)</th></tr></thead><tbody>${trs}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Scripts — modal
// ---------------------------------------------------------------------------

function openScriptModal(title, html) {
  document.getElementById('script-modal-title').textContent = title;
  document.getElementById('script-modal-body').innerHTML = html;
  document.getElementById('script-modal').classList.remove('hidden');
}

function closeScriptModal() {
  document.getElementById('script-modal').classList.add('hidden');
  document.getElementById('script-modal-body').innerHTML = '';
}

function wireScriptModal() {
  document.getElementById('script-modal-close').addEventListener('click', closeScriptModal);
  document.getElementById('script-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('script-modal')) closeScriptModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('script-modal').classList.contains('hidden'))
      closeScriptModal();
  });
}

// ---------------------------------------------------------------------------
// Scripts — new tab output
// ---------------------------------------------------------------------------

function openScriptInTab(title, htmlContent) {
  const isDark = (document.documentElement.dataset.theme || '') !== 'light';
  const c = isDark
    ? { bg: '#12121f', bg2: '#1a1a2e', border: '#2e2e4a', text: '#d0d0e8', muted: '#7070a0', accent: '#4a90d9' }
    : { bg: '#ffffff', bg2: '#f4f4fc', border: '#c8c8dc', text: '#1a1a2e', muted: '#6060a0', accent: '#2a6ec4' };
  const doc = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<title>${escHtml(title)} — ROS2 Analyzer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;font-size:13px;background:${c.bg};color:${c.text};padding:24px 32px}
h1{font-size:15px;font-weight:600;color:${c.accent};margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:12px}
th{text-align:left;padding:6px 10px;color:${c.muted};font-weight:600;border-bottom:2px solid ${c.border};white-space:nowrap}
td{padding:5px 10px;color:${c.text};border-bottom:1px solid ${c.border};vertical-align:top;word-break:break-all}
tr:last-child td{border-bottom:none}tr:hover td{background:${c.bg2}}
.script-result-empty{color:${c.muted};text-align:center;padding:20px}
.result-category-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:${c.bg2};color:${c.muted};border:1px solid ${c.border}}
.qos-conflict{color:#e06060;font-weight:600}
</style></head><body>
<h1>${escHtml(title)}</h1>${htmlContent}</body></html>`;
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------------------
// Scripts — dispatch and button wiring
// ---------------------------------------------------------------------------

function runScript(title, html) {
  if (getScriptsOutputMode() === 'tab') openScriptInTab(title, html);
  else openScriptModal(title, html);
}

function wireScriptsPanel() {
  document.getElementById('script-lost-nodes').addEventListener('click', () =>
    runScript('Orphan nodes (topics)', buildLostNodesHtml(scriptLostNodes()))
  );

  document.getElementById('script-heavy-topics').addEventListener('click', () => {
    const n = parseInt(document.getElementById('heavy-topics-n').value, 10) || 3;
    runScript(`Heavy topics (> ${n} publishers)`, buildHeavyTopicsHtml(scriptHeavyTopics(n), n));
  });

  document.getElementById('script-qos-errors').addEventListener('click', () =>
    runScript('QoS errors', buildQosErrorsHtml(scriptQosErrors()))
  );
}
