/**
 * The fleet-admin web page (issue #26, orchestration-v3 §4.3): a single
 * self-contained HTML file — no build step, no framework. Served as-is by
 * GET / (standalone `fleet-agent-admin`) and by dsh's webServer (`/admin`).
 * Same style language as the fleet-board page.
 *
 * The page is the buzz app-UI management surface for agent config: list
 * (name/avatar/role/model/provider/tier/status incl. enabled), create/edit/
 * disable/enable, and a profile JSON view. All edits go through the service
 * (`/api/agents*`) which persists runtime overrides in
 * `$DSH_HOME/fleet/agent/profiles.json`.
 * @module @hydra/dsh-fleet-agent/page
 */

/** The complete standalone page body (served as `text/html; charset=utf-8`). */
export const FLEET_ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet-admin — agent config</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; z-index: 10; }
  h1 { display: inline-block; margin: 0 16px 0 0; font-size: 15px; letter-spacing: .04em; }
  #statusline { margin-top: 6px; color: #8b949e; }
  main { padding: 12px 16px 48px; max-width: 900px; }
  .card { margin: 10px 0; border: 1px solid #30363d; border-radius: 8px; background: #161b22; overflow: hidden; }
  .card > summary { padding: 8px 12px; cursor: pointer; color: #e6edf3; list-style: none; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary:hover { background: #1c2128; }
  .card.open { border-color: #58a6ff; }
  .row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 8px 12px; border-top: 1px solid #21262d; }
  .row .id { color: #79c0ff; font-weight: 600; min-width: 90px; }
  .row .avatar { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; background: #1f6feb; color: #fff; font-size: 11px; }
  .row .name { color: #e6edf3; }
  .row .role { color: #d2a8ff; }
  .row .model { color: #8b949e; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .badge.on { background: #238636; color: #fff; }
  .badge.off { background: #b62324; color: #fff; }
  .kv { color: #8b949e; }
  .kv b { color: #7ee787; font-weight: 400; }
  .body { padding: 8px 12px 12px; border-top: 1px solid #21262d; }
  label { display: block; margin: 6px 0 2px; color: #8b949e; }
  input[type=text], input[type=number] { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; font: inherit; }
  input[type=checkbox] { accent-color: #1f6feb; }
  button { font: inherit; background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button.danger { background: #b62324; border-color: #b62324; color: #fff; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  pre { margin: 8px 0 0; padding: 10px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; color: #8b949e; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
  .empty { color: #8b949e; padding: 24px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>fleet-admin</h1>
  <span id="statusline">loading…</span>
</header>
<main>
  <details id="new-card" class="card">
    <summary>+ create agent</summary>
    <div class="body">
      <label>agentId</label><input type="text" id="new-agentId" placeholder="e.g. dev-3">
      <label>name</label><input type="text" id="new-name" placeholder="Developer 3">
      <label>role</label><input type="text" id="new-role" placeholder="dev-3">
      <label>provider</label><input type="text" id="new-provider" placeholder="opencode/opencode-go/deepseek-v4-flash">
      <label>tier</label><input type="text" id="new-tier" placeholder="t1">
      <label>model</label><input type="text" id="new-model" placeholder="">
      <div style="margin-top:10px"><button class="primary" id="btn-create">create agent</button></div>
    </div>
  </details>
  <div id="agents"><div class="empty">loading…</div></div>
</main>
<script>
(function () {
  'use strict'
  var agents = []

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function setStatus(text) { document.getElementById('statusline').textContent = text }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      cache: 'no-store',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
  }

  function refresh() {
    api('GET', '/api/agents').then(function (res) {
      agents = res.body.profiles || []
      render()
      setStatus(agents.length + ' agents · ' + new Date().toLocaleTimeString())
    }).catch(function (err) { setStatus('load error: ' + err.message) })
  }

  function avatarColor(id) {
    var hash = 0
    for (var i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
    var palette = ['#1f6feb', '#8957e5', '#238636', '#d29922', '#a371f7', '#e3b341']
    return palette[Math.abs(hash) % palette.length]
  }

  function render() {
    var host = document.getElementById('agents')
    host.textContent = ''
    if (agents.length === 0) {
      host.appendChild(el('div', 'empty', 'no agents yet — create one above'))
      return
    }
    agents.forEach(function (p) { host.appendChild(card(p)) })
  }

  function rowField(label, value) {
    var row = el('div', 'row')
    row.appendChild(el('span', 'kv', label + ':'))
    row.appendChild(el('span', 'kv', value === undefined || value === null || value === '' ? '<unset>' : value))
    return row
  }

  function card(p) {
    var wrap = el('details', 'card')
    var summary = el('summary')
    var avatar = el('span', 'avatar', (p.avatar || p.name || p.agentId).charAt(0).toUpperCase())
    avatar.style.background = p.avatar && p.avatar.indexOf('#') === 0 ? p.avatar : avatarColor(p.agentId)
    summary.appendChild(avatar)
    summary.appendChild(el('span', 'name', ' ' + p.name))
    summary.appendChild(el('span', 'role', ' [' + p.role + ']'))
    summary.appendChild(el('span', 'model', ' · ' + (p.model || p.provider || 'no provider')))
    var badge = el('span', 'badge ' + (p.enabled ? 'on' : 'off'), p.enabled ? 'enabled' : 'disabled')
    summary.appendChild(badge)
    wrap.appendChild(summary)

    var body = el('div', 'body')
    body.appendChild(rowField('agentId', p.agentId))
    body.appendChild(rowField('claimRole', p.claimRole))
    body.appendChild(rowField('cwd', p.cwd))
    body.appendChild(rowField('tier', p.tier))
    body.appendChild(rowField('provider', p.provider))
    body.appendChild(rowField('model', p.model))
    body.appendChild(rowField('promptFile', p.promptFile))
    body.appendChild(rowField('status', p.status))

    var grid = el('div', 'grid2')
    grid.appendChild(field('name', 'name', p))
    grid.appendChild(field('role', 'role', p))
    grid.appendChild(field('provider', 'provider', p))
    grid.appendChild(field('model', 'model', p))
    grid.appendChild(field('tier', 'tier', p))
    grid.appendChild(field('claimRole', 'claimRole', p))
    grid.appendChild(field('promptFile', 'promptFile', p))
    grid.appendChild(field('avatar', 'avatar', p))
    body.appendChild(grid)

    var actions = el('div', 'row')
    var save = el('button', 'primary', 'save')
    save.onclick = function () { saveAgent(p, grid.querySelectorAll('input[data-k]')) }
    actions.appendChild(save)
    var toggle = el('button', p.enabled ? 'danger' : undefined, p.enabled ? 'disable' : 'enable')
    toggle.onclick = function () {
      api('POST', '/api/agents/' + encodeURIComponent(p.agentId) + (p.enabled ? '/disable' : '/enable'))
        .then(function () { refresh() }).catch(function (err) { setStatus('error: ' + err.message) })
    }
    actions.appendChild(toggle)
    body.appendChild(actions)

    var pre = el('pre', undefined, JSON.stringify(p, null, 2))
    body.appendChild(pre)
    wrap.appendChild(body)
    return wrap
  }

  function field(label, key) {
    var host = el('div')
    host.appendChild(el('label', undefined, label))
    var input = el('input', undefined)
    input.type = 'text'
    input.setAttribute('data-k', key)
    host.appendChild(input)
    return host
  }

  function saveAgent(p, inputs) {
    var patch = {}
    Array.prototype.forEach.call(inputs, function (input) {
      var v = input.value.trim()
      if (v !== '') patch[input.getAttribute('data-k')] = v
    })
    api('POST', '/api/agents/' + encodeURIComponent(p.agentId), patch).then(function (res) {
      setStatus(res.status === 200 ? 'saved ' + p.agentId : 'save failed: ' + (res.body.error || res.status))
      refresh()
    }).catch(function (err) { setStatus('error: ' + err.message) })
  }

  document.getElementById('btn-create').addEventListener('click', function () {
    var body = {
      agentId: document.getElementById('new-agentId').value.trim(),
      name: document.getElementById('new-name').value.trim(),
      role: document.getElementById('new-role').value.trim(),
      provider: document.getElementById('new-provider').value.trim(),
      tier: document.getElementById('new-tier').value.trim(),
      model: document.getElementById('new-model').value.trim(),
    }
    if (!body.agentId) { setStatus('agentId is required to create'); return }
    var patch = {}
    Object.keys(body).forEach(function (k) { if (body[k]) patch[k] = body[k] })
    api('POST', '/api/agents', patch).then(function (res) {
      setStatus(res.status === 201 ? 'created ' + body.agentId : 'create failed: ' + (res.body.error || res.status))
      refresh()
    }).catch(function (err) { setStatus('error: ' + err.message) })
  })

  refresh()
  window.setInterval(refresh, 5000)
})()
</script>
</body>
</html>
`
