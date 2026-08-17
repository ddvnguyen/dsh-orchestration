/**
 * The fleet-teams-ui rooms page (issue #26, orchestration-v3 §4 P4.2): a
 * single self-contained HTML file — no build step, no framework, the board
 * page pattern. Served as-is by the standalone `fleet-teams-ui-server` bin
 * and (optionally) by dsh's webServer at `/fleet-teams-ui`.
 *
 * The page is a COMPANION to the dsh chat UI (owner constraint: the dsh web
 * app is READ-ONLY and stays the normal chat surface). It renders each room's
 * fleet thread with SENDER IDENTITY (name/avatar/role badge per message,
 * resolved from the fleet-agent profile registry via `/api/profiles`), a
 * grant-checked composer (posts via `/api/rooms/:id/post`), and a team menu
 * opening the room settings dialog (room name, members + grants read/post/join,
 * memory file, scope, linked tasks, archive) backed by `/api/rooms/:id`.
 *
 * Live updates: poll `/api/rooms/:id/messages?since=` every 3 s (the board
 * page's polling machinery — seq watermark, no SSE needed at prototype
 * volumes).
 * @module @hydra/dsh-fleet-teams-ui/page
 */

/** The complete standalone page body (served as `text/html; charset=utf-8`). */
export const FLEET_TEAMS_UI_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet-teams — rooms</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; z-index: 10; }
  h1 { display: inline-block; margin: 0 16px 0 0; font-size: 15px; letter-spacing: .04em; }
  #statusline { margin-top: 6px; color: #8b949e; }
  #layout { display: flex; min-height: calc(100vh - 64px); }
  #sidebar { width: 280px; flex: 0 0 280px; border-right: 1px solid #30363d; padding: 12px; overflow-y: auto; }
  #main { flex: 1; padding: 12px 16px 64px; min-width: 0; }
  .section-title { color: #8b949e; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; margin: 12px 0 6px; }
  .team { margin-bottom: 8px; }
  .team-name { font-weight: 600; color: #c9d1d9; margin-bottom: 4px; }
  .room { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .room:hover { background: #1c2128; }
  .room.active { background: #1f2937; border-color: #30363d; }
  .room-archived { opacity: .55; }
  .room-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .room-badge { color: #8b949e; font-size: 11px; }
  button { font: inherit; background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.danger { border-color: #da3633; color: #f85149; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  input[type=text], input[type=checkbox], textarea, select { font: inherit; }
  input[type=text], textarea, select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; }
  textarea { width: 100%; resize: vertical; }
  .empty { color: #8b949e; padding: 24px; text-align: center; }
  #thread { max-width: 760px; }
  .briefing { border: 1px solid #30363d; border-radius: 8px; background: #161b22; margin-bottom: 12px; overflow: hidden; }
  .briefing summary { padding: 8px 12px; cursor: pointer; color: #8b949e; user-select: none; }
  .briefing pre { margin: 0; padding: 10px 12px; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
  .msg { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #21262d; }
  .avatar { flex: 0 0 32px; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; font-size: 13px; }
  .msg-body { flex: 1; min-width: 0; }
  .msg-head { display: flex; align-items: baseline; gap: 8px; }
  .msg-name { font-weight: 600; color: #e6edf3; }
  .role-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #30363d; color: #d2a8ff; text-transform: uppercase; letter-spacing: .04em; }
  .msg-ts { color: #8b949e; font-size: 11px; }
  .msg-text { margin-top: 3px; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
  .msg-origin { color: #484f58; font-size: 10px; margin-left: auto; }
  #composer { position: sticky; bottom: 0; background: #0d1117; padding: 10px 0; border-top: 1px solid #21262d; max-width: 760px; }
  #composer-row { display: flex; gap: 8px; }
  #composer-body { flex: 1; }
  .dialog-backdrop { position: fixed; inset: 0; background: rgba(1,4,9,.7); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dialog { width: 560px; max-width: 94vw; max-height: 86vh; overflow-y: auto; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; }
  .dialog h2 { margin: 0 0 12px; font-size: 15px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .member-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #21262d; }
  .member-name { flex: 1; display: flex; align-items: center; gap: 6px; }
  .member-avatar { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; }
  .grant-check { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; color: #c9d1d9; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; color: #79c0ff; }
  .pill { display: inline-block; background: #21262d; border-radius: 8px; padding: 1px 8px; margin: 2px 4px 2px 0; color: #c9d1d9; }
  a { color: #79c0ff; }
</style>
</head>
<body>
<header>
  <h1>fleet-teams · rooms</h1>
  <span id="statusline">loading…</span>
  <div id="acting-row" style="margin-top:6px;display:none">
    <label style="color:#8b949e">posting as
      <select id="acting-agent"></select>
    </label>
    <label style="color:#8b949e;margin-left:12px"><input type="checkbox" id="show-archived"> show archived</label>
  </div>
</header>
<div id="layout">
  <aside id="sidebar">
    <div id="room-list"><div class="empty">loading…</div></div>
  </aside>
  <main id="main">
    <div id="room-view" style="display:none">
      <div id="thread"></div>
      <div id="composer">
        <div id="composer-row">
          <textarea id="composer-body" rows="2" placeholder="Message this room…"></textarea>
          <button id="post-btn">Post</button>
        </div>
      </div>
    </div>
    <div id="placeholder" class="empty">Select a room from the sidebar.</div>
  </main>
</div>
<div id="dialog-host"></div>
<script>
(function () {
  'use strict'
  var rooms = []          // teams[].rooms[]
  var profiles = []       // /api/profiles
  var currentRoom = null  // the open room (list row)
  var lastSeq = 0         // thread seq watermark
  var POLL_MS = 3000

  function esc(s) { return String(s) }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = esc(text)
    return node
  }

  function api(path) { return '/api' + path }

  function setStatus(text) { document.getElementById('statusline').textContent = text }

  function badge(agentId) {
    var p = profiles.find(function (x) { return x.agentId === agentId })
    if (!p) return { agentId: agentId, name: agentId, role: 'agent', avatar: esc(agentId)[0] || '?', color: '#3b82f6' }
    return { agentId: p.agentId, name: p.name, role: p.role, avatar: p.avatar || (p.name || p.agentId)[0], color: p.avatar || '#3b82f6' }
  }

  function avatarChip(b, cls) {
    var node = el('span', cls || 'avatar', b.avatar)
    node.style.background = b.color
    return node
  }

  // ---- room list ----
  function renderRooms() {
    var host = document.getElementById('room-list')
    host.textContent = ''
    var showArchived = document.getElementById('show-archived').checked
    var any = false
    rooms.forEach(function (team) {
      if (!team.rooms || team.rooms.length === 0) return
      var block = el('div', 'team')
      block.appendChild(el('div', 'team-name', team.team.name))
      team.rooms.forEach(function (row) {
        var archived = row.overlay && row.overlay.archived === true
        if (archived && !showArchived) return
        any = true
        var r = el('div', 'room' + (archived ? ' room-archived' : '') + (currentRoom && currentRoom.id === row.room.id ? ' active' : ''))
        r.appendChild(el('span', 'room-name', (row.overlay && row.overlay.displayName) || row.room.name))
        r.appendChild(el('span', 'room-badge', row.room.memberIds.length + ' · ' + (archived ? 'archived' : row.room.scope)))
        r.addEventListener('click', function () { openRoom(row) })
        block.appendChild(r)
      })
      host.appendChild(block)
    })
    if (!any) host.appendChild(el('div', 'empty', 'no rooms yet'))
  }

  function loadRooms() {
    fetch(api('/rooms'), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) {
        rooms = body.teams || []
        renderRooms()
        if (currentRoom) {
          var fresh = findRoom(currentRoom.id)
          if (fresh) currentRoom = fresh
          else { currentRoom = null; showPlaceholder() }
        }
        setStatus(body.teams.length + ' team(s) · ' + new Date().toLocaleTimeString())
      })
      .catch(function (err) { setStatus('rooms error: ' + err.message) })
  }

  function findRoom(roomId) {
    var found = null
    rooms.forEach(function (team) {
      team.rooms.forEach(function (row) { if (row.room.id === roomId) found = row })
    })
    return found
  }

  // ---- thread ----
  function openRoom(row) {
    currentRoom = row
    lastSeq = 0
    document.getElementById('room-view').style.display = ''
    document.getElementById('placeholder').style.display = 'none'
    renderRooms()
    loadThread()
  }

  function showPlaceholder() {
    document.getElementById('room-view').style.display = 'none'
    document.getElementById('placeholder').style.display = ''
  }

  function loadThread() {
    if (!currentRoom) return
    var url = api('/rooms/' + encodeURIComponent(currentRoom.id) + '/messages')
    if (lastSeq > 0) url += '?since=' + lastSeq
    fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (body) {
        if (currentRoom && body.roomId !== currentRoom.id) return
        lastSeq = body.lastSeq
        renderThread(body)
        setStatus('seq ' + body.lastSeq + ' · ' + new Date().toLocaleTimeString())
      })
      .catch(function (err) { setStatus('thread error: ' + err.message) })
  }

  function renderThread(body) {
    var host = document.getElementById('thread')
    host.textContent = ''
    // Briefing header: the shared-room memory file (durable context).
    var briefing = el('details', 'briefing')
    briefing.appendChild(el('summary', '', 'Room memory (shared context)'))
    briefing.appendChild(el('pre', '', body.briefing))
    host.appendChild(briefing)
    // Chat thread: each message with sender name/avatar/role badge.
    var messages = body.messages || []
    if (messages.length === 0) host.appendChild(el('div', 'empty', 'no messages yet — start the conversation'))
    messages.forEach(function (m) {
      var row = el('div', 'msg')
      row.appendChild(avatarChip(m.sender))
      var bodyEl = el('div', 'msg-body')
      var head = el('div', 'msg-head')
      head.appendChild(el('span', 'msg-name', m.sender.name))
      head.appendChild(el('span', 'role-badge', m.sender.role))
      head.appendChild(el('span', 'msg-ts', new Date(m.ts).toISOString().slice(11, 19)))
      head.appendChild(el('span', 'msg-origin', m.origin === 'event' ? 'live' : 'memory'))
      bodyEl.appendChild(head)
      bodyEl.appendChild(el('div', 'msg-text', m.body))
      row.appendChild(bodyEl)
      host.appendChild(row)
    })
  }

  // ---- composer ----
  function postMessage() {
    if (!currentRoom) return
    var text = document.getElementById('composer-body').value.trim()
    if (!text) return
    var actor = document.getElementById('acting-agent').value
    fetch(api('/rooms/' + encodeURIComponent(currentRoom.id) + '/post'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: actor, body: text }),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (post) {
        document.getElementById('composer-body').value = ''
        setStatus('posted as ' + post.sender.name)
        lastSeq = 0
        loadThread()
        loadRooms()
      })
      .catch(function (err) { setStatus('post error: ' + err.message) })
  }

  // ---- profiles + acting agent ----
  function loadProfiles() {
    fetch(api('/profiles'), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) {
        profiles = body.profiles || []
        var select = document.getElementById('acting-agent')
        select.textContent = ''
        if (profiles.length === 0) {
          var none = document.createElement('option')
          none.value = ''
          none.textContent = '(no profiles)'
          select.appendChild(none)
        }
        profiles.forEach(function (p) {
          var opt = document.createElement('option')
          opt.value = p.agentId
          opt.textContent = p.name + ' (' + p.role + ')'
          select.appendChild(opt)
        })
        document.getElementById('acting-row').style.display = ''
      })
      .catch(function () { /* profiles optional — senders fall back to ids */ })
  }

  // ---- settings dialog ----
  function openSettings() {
    if (!currentRoom) return
    fetch(api('/rooms/' + encodeURIComponent(currentRoom.id)), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (detail) { renderSettings(detail) })
      .catch(function (err) { setStatus('settings error: ' + err.message) })
  }

  function grantCheck(name, value) {
    var input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = value === true
    input.setAttribute('data-grant', name)
    input.setAttribute('data-agent', '')
    return input
  }

  function renderSettings(d) {
    var host = document.getElementById('dialog-host')
    host.textContent = ''
    var backdrop = el('div', 'dialog-backdrop')
    var box = el('div', 'dialog')
    box.appendChild(el('h2', '', (d.overlay && d.overlay.displayName) || d.room.name))
    box.appendChild(el('div', 'field', 'room ' + d.room.id + ' · scope ' + d.scope + ' · team ' + d.team.name))

    // Room name (rename = UI-layer overlay; canonical rename is a follow-up).
    var nameField = el('div', 'field')
    nameField.appendChild(el('label', '', 'Room name'))
    var nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.value = (d.overlay && d.overlay.displayName) || d.room.name
    nameInput.id = 'settings-name'
    nameField.appendChild(nameInput)
    box.appendChild(nameField)

    // Members + grants (the read/post/join model).
    var membersField = el('div', 'field')
    membersField.appendChild(el('label', '', 'Members + grants'))
    d.room.memberIds.forEach(function (agentId) {
      var grants = d.memberGrants[agentId] || { read: false, post: false, join: false }
      var b = d.memberBadges[agentId]
      var row = el('div', 'member-row')
      var name = el('div', 'member-name')
      name.appendChild(avatarChip(b, 'member-avatar'))
      name.appendChild(document.createTextNode(b.name + ' (' + agentId + ')'))
      row.appendChild(name)
      var r = grantCheck('read', grants.read); r.dataset.agent = agentId
      var p = grantCheck('post', grants.post); p.dataset.agent = agentId
      var j = grantCheck('join', grants.join); j.dataset.agent = agentId
      row.appendChild(wrapCheck('read', r)); row.appendChild(wrapCheck('post', p)); row.appendChild(wrapCheck('join', j))
      membersField.appendChild(row)
    })
    box.appendChild(membersField)

    // Memory file + linked tasks + archive.
    var memoryField = el('div', 'field')
    memoryField.appendChild(el('label', '', 'Shared memory file'))
    memoryField.appendChild(el('div', '', d.memoryFile))
    box.appendChild(memoryField)

    var tasksField = el('div', 'field')
    tasksField.appendChild(el('label', '', 'Linked tasks (from memory Task refs)'))
    var tasks = d.linkedTasks || []
    if (tasks.length === 0) tasksField.appendChild(el('div', 'empty', 'no linked tasks yet'))
    tasks.forEach(function (t) { tasksField.appendChild(el('span', 'pill', t)) })
    box.appendChild(tasksField)

    var archiveField = el('div', 'field')
    archiveField.appendChild(el('label', '', 'Archive'))
    var archiveLabel = el('label', '')
    var archiveInput = document.createElement('input')
    archiveInput.type = 'checkbox'
    archiveInput.id = 'settings-archive'
    archiveInput.checked = d.overlay && d.overlay.archived === true
    archiveLabel.appendChild(archiveInput)
    archiveLabel.appendChild(document.createTextNode(' archive this room (hidden from the default list)'))
    archiveField.appendChild(archiveLabel)
    box.appendChild(archiveField)

    // Actions.
    var actions = el('div', 'dialog-actions')
    var cancel = el('button', '', 'Close'); cancel.addEventListener('click', function () { host.textContent = '' })
    var save = el('button', '', 'Save')
    save.addEventListener('click', function () { saveSettings(d.room.id) })
    actions.appendChild(cancel)
    actions.appendChild(save)
    box.appendChild(actions)

    backdrop.appendChild(box)
    host.appendChild(backdrop)
  }

  function wrapCheck(label, input) {
    var wrap = el('label', 'grant-check')
    wrap.appendChild(document.createTextNode(label + ' '))
    wrap.appendChild(input)
    return wrap
  }

  function saveSettings(roomId) {
    var actor = document.getElementById('acting-agent').value
    var overrides = {}
    document.querySelectorAll('#dialog-host input[data-grant]').forEach(function (input) {
      var agent = input.getAttribute('data-agent')
      if (!agent) return
      if (!overrides[agent]) overrides[agent] = {}
      overrides[agent][input.getAttribute('data-grant')] = input.checked
    })
    var payload = {
      actor: actor,
      overrides: overrides,
      displayName: document.getElementById('settings-name').value.trim(),
      archived: document.getElementById('settings-archive').checked,
    }
    fetch(api('/rooms/' + encodeURIComponent(roomId) + '/settings'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (body) {
        document.getElementById('dialog-host').textContent = ''
        setStatus('settings saved (' + body.room.name + ')')
        loadRooms()
        if (currentRoom && currentRoom.id === roomId) { lastSeq = 0; loadThread() }
      })
      .catch(function (err) { setStatus('save error: ' + err.message) })
  }

  // ---- wiring ----
  document.getElementById('post-btn').addEventListener('click', postMessage)
  document.getElementById('composer-body').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postMessage()
  })
  document.getElementById('show-archived').addEventListener('change', renderRooms)

  // A small "settings" affordance per room in the sidebar + the main view.
  var settingsBtn = el('button', '', 'Team settings')
  settingsBtn.style.marginLeft = '8px'
  settingsBtn.addEventListener('click', openSettings)
  document.getElementById('main').insertBefore(settingsBtn, document.getElementById('room-view'))

  loadProfiles()
  loadRooms()
  window.setInterval(function () {
    loadRooms()
    if (currentRoom) loadThread()
  }, POLL_MS)
})()
</script>
</body>
</html>
`

/** Build the page with an optional API base prefix (plugin mount uses /fleet-teams-ui). */
export function teamsUiPageHtml(base: string): string {
  if (base === '' || base === '/') return FLEET_TEAMS_UI_PAGE_HTML
  return FLEET_TEAMS_UI_PAGE_HTML.replaceAll('/api', `${base}/api`)
}
