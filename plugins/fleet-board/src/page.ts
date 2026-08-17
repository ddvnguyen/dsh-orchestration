/**
 * The fleet-board web page (issue #26, orchestration-v3 §4 P1.1): a single
 * self-contained HTML file — no build step, no framework. Served as-is by
 * GET / (standalone `fleet-board-server`) and by dsh's webServer
 * (`/fleet-board`).
 *
 * OUTPUT-FIRST PROGRESSIVE DISCLOSURE (#28, paperclip principle): every event
 * renders as three stacked levels instead of one blob —
 *   1. intent line (always visible): the human-readable one-liner.
 *   2. Context (collapsed): the payload flattened into key/value facts.
 *   3. Raw (collapsed): the complete event as JSON.
 * The page polls the bus feed (`/events`) every 3 seconds and filters
 * client-side by mechanism (originKind), scope, type, and actor.
 * @module @hydra/dsh-fleet-board/page
 */

/** The complete standalone page body (served as `text/html; charset=utf-8`). */
export const FLEET_BOARD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet-board — fleet activity feed</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; z-index: 10; }
  h1 { display: inline-block; margin: 0 16px 0 0; font-size: 15px; letter-spacing: .04em; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
  .controls label, .controls input, .controls select { font: inherit; }
  .controls input[type=text], .controls select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; }
  .controls input[type=text] { width: 150px; }
  #statusline { margin-top: 6px; color: #8b949e; }
  #events { padding: 8px 16px 48px; }
  .event { margin: 8px 0; border: 1px solid #30363d; border-radius: 8px; background: #161b22; overflow: hidden; }
  .l1 { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 12px; align-items: baseline; cursor: pointer; }
  .ts { color: #8b949e; white-space: nowrap; }
  .type { color: #79c0ff; font-weight: 600; }
  .scope { color: #8b949e; }
  .originkind { color: #d2a8ff; }
  .actor { color: #ffd585; }
  .intent { color: #e6edf3; }
  .l1:hover { background: #1c2128; }
  .levels { border-top: 1px solid #21262d; }
  details { border-bottom: 1px solid #21262d; }
  details:last-child { border-bottom: none; }
  summary { padding: 6px 12px; cursor: pointer; color: #8b949e; user-select: none; }
  summary:hover { color: #e6edf3; }
  .context ul { margin: 0; padding: 4px 12px 10px 28px; }
  .context li { margin: 2px 0; color: #c9d1d9; }
  .context .k { color: #7ee787; }
  .context .v { color: #c9d1d9; white-space: pre-wrap; word-break: break-all; }
  pre.raw { margin: 0; padding: 10px 12px; color: #8b949e; white-space: pre-wrap; word-break: break-all; }
  .empty { color: #8b949e; padding: 24px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>fleet-board</h1>
  <span id="statusline">loading…</span>
  <div class="controls">
    <label><input type="checkbox" id="autorefresh" checked> auto-refresh (3s)</label>
    <select id="f-originkind" title="filter by mechanism (originKind)">
      <option value="">all mechanisms</option>
      <option value="agent">agent</option>
      <option value="heartbeat">heartbeat</option>
      <option value="watchdog">watchdog</option>
      <option value="scheduler">scheduler</option>
      <option value="task">task</option>
      <option value="system">system</option>
    </select>
    <select id="f-scope" title="filter by scope">
      <option value="">all scopes</option>
      <option value="agent">agent</option>
      <option value="team">team</option>
      <option value="fleet">fleet</option>
    </select>
    <input type="text" id="f-type" placeholder="filter type" title="filter by event type (substring)">
    <input type="text" id="f-actor" placeholder="filter actor" title="filter by actor (substring)">
  </div>
</header>
<main id="events"><div class="empty">loading…</div></main>
<script>
(function () {
  'use strict'
  var events = []        // newest first
  var seen = new Set()   // event ids already shown
  var lastTs = 0         // watermark for the since= param
  var refreshing = false
  var POLL_MS = 3000

  function esc(s) { return String(s) }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = esc(text)
    return node
  }

  function render() {
    var filterKind = document.getElementById('f-originkind').value
    var filterScope = document.getElementById('f-scope').value
    var filterType = document.getElementById('f-type').value.toLowerCase()
    var filterActor = document.getElementById('f-actor').value.toLowerCase()
    var list = events.filter(function (e) {
      if (filterKind && e.originKind !== filterKind) return false
      if (filterScope && e.scope !== filterScope) return false
      if (filterType && e.type.toLowerCase().indexOf(filterType) === -1) return false
      if (filterActor && e.actor.toLowerCase().indexOf(filterActor) === -1) return false
      return true
    })
    var host = document.getElementById('events')
    host.textContent = ''
    if (list.length === 0) {
      host.appendChild(el('div', 'empty', 'no events match the current filters'))
      return
    }
    list.forEach(function (e) { host.appendChild(card(e)) })
  }

  function card(e) {
    var wrap = el('article', 'event')
    var l1 = el('div', 'l1')
    l1.appendChild(el('span', 'ts', new Date(e.ts).toISOString().slice(11, 19)))
    l1.appendChild(el('span', 'type', e.type))
    l1.appendChild(el('span', 'scope', '[' + e.scope + ']'))
    l1.appendChild(el('span', 'actor', e.actor))
    if (e.originKind && e.originKind !== 'agent') l1.appendChild(el('span', 'originkind', '(' + e.originKind + ')'))
    l1.appendChild(el('span', 'intent', e.summary ? e.summary.intent : e.type))
    wrap.appendChild(l1)

    var levels = el('div', 'levels')
    var context = el('details', 'context')
    context.appendChild(el('summary', '', 'Context'))
    var ul = el('ul')
    var facts = (e.summary && e.summary.checklist) || []
    if (facts.length === 0) {
      var liNone = el('li', '', '(no payload facts)')
      ul.appendChild(liNone)
    } else {
      facts.forEach(function (fact) {
        var li = el('li')
        li.appendChild(el('span', 'k', fact.key))
        li.appendChild(document.createTextNode(': '))
        li.appendChild(el('span', 'v', fact.value))
        ul.appendChild(li)
      })
    }
    context.appendChild(ul)
    levels.appendChild(context)

    var raw = el('details', 'raw')
    raw.appendChild(el('summary', '', 'Raw'))
    var pre = el('pre', 'raw', JSON.stringify(omit(e, 'summary'), null, 2))
    raw.appendChild(pre)
    levels.appendChild(raw)
    wrap.appendChild(levels)
    return wrap
  }

  function omit(obj, key) {
    var out = {}
    Object.keys(obj).forEach(function (k) { if (k !== key) out[k] = obj[k] })
    return out
  }

  function applyBatch(batch) {
    batch.forEach(function (e) {
      if (seen.has(e.id)) return
      seen.add(e.id)
      events.unshift(e)
      if (e.ts > lastTs) lastTs = e.ts
    })
    if (events.length > 1000) events.length = 1000
  }

  function setStatus(text) { document.getElementById('statusline').textContent = text }

  function load(query) {
    refreshing = true
    fetch('/events' + query, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (body) {
        applyBatch(body.events || [])
        render()
        setStatus(body.count + ' events · seq ' + body.lastSeq + ' · ' + new Date().toLocaleTimeString())
      })
      .catch(function (err) { setStatus('poll error: ' + err.message) })
      .then(function () { refreshing = false })
  }

  function poll() {
    if (!document.getElementById('autorefresh').checked) return
    var q = '?limit=200'
    if (lastTs > 0) q += '&since=' + lastTs
    load(q)
  }

  ['f-originkind', 'f-scope', 'f-type', 'f-actor'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', render)
    document.getElementById(id).addEventListener('change', render)
  })
  document.getElementById('autorefresh').addEventListener('change', function (e) {
    if (e.target.checked) poll()
  })

  load('?limit=100')
  window.setInterval(function () {
    if (!refreshing) poll()
  }, POLL_MS)
})()
</script>
</body>
</html>
`
