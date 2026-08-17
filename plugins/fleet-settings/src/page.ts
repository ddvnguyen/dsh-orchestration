/**
 * The fleet-settings page (issue #26, orchestration-v3 §4.4): a single
 * self-contained HTML file — no build step, no framework (the board-page /
 * fleet-teams-ui pattern). Served as-is by GET / (standalone
 * `fleet-settings-server`) and by dsh's webServer (`/fleet-settings`).
 *
 * The page is the sanctioned settings surface (the dsh settings dialog is NOT
 * extensible). It renders five tabs:
 *   Sessions — the dsh session ledger ($DSH_HOME/sessions) with per-log status
 *     (running/done/idle from the turn balance) + title + updated time, resume
 *     (the session.prompt seam, prompts for the followup text) and
 *     archive/restore (overlay marker + the workspace.archiveSession seam).
 *   Agents   — fleet-agent profiles (model/provider edit + enabled toggle).
 *   Teams    — fleet-teams teams + rooms + members + effective grants.
 *   Budgets  — fleet-budget caps + spend levels (set a global cap).
 *   Policy   — fleet-policy postures (context + per-identity).
 * @module @hydra/dsh-fleet-settings/page
 */

/** The settings page body (served as `text/html; charset=utf-8`). */
export function settingsPageHtml(apiBase = '/api'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet-settings — sessions + fleet settings</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; z-index: 10; }
  h1 { display: inline-block; margin: 0 16px 0 0; font-size: 15px; letter-spacing: .04em; }
  nav { display: inline-block; }
  nav button { font: inherit; color: #8b949e; background: none; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; margin-right: 6px; cursor: pointer; }
  nav button.active { color: #e6edf3; background: #1c2128; border-color: #79c0ff; }
  #statusline { margin-top: 6px; color: #8b949e; }
  main { padding: 12px 16px 48px; }
  .tab { display: none; }
  .tab.active { display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; white-space: nowrap; }
  td.mono { font-size: 12px; color: #79c0ff; word-break: break-all; }
  .status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .status.running { background: #2ea04333; color: #3fb950; }
  .status.done { background: #30363d; color: #8b949e; }
  .status.idle { background: #1f6feb33; color: #58a6ff; }
  button.action { font: inherit; color: #e6edf3; background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 2px 8px; margin-right: 4px; cursor: pointer; }
  button.action:hover { border-color: #79c0ff; }
  button.action.danger:hover { border-color: #f85149; }
  form.inline { display: inline-flex; gap: 6px; align-items: center; }
  form.inline input, form.inline select { font: inherit; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 3px 6px; }
  .card { margin-top: 10px; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; background: #161b22; }
  .card h3 { margin: 0 0 6px; font-size: 13px; color: #79c0ff; }
  .muted { color: #8b949e; }
  .empty { color: #8b949e; padding: 24px; text-align: center; }
  pre.json { margin: 6px 0 0; padding: 8px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; color: #8b949e; white-space: pre-wrap; word-break: break-all; }
  .level.ok { color: #3fb950; } .level.warning { color: #d29922; } .level.critical { color: #f85149; }
  .bar { display: inline-block; height: 8px; min-width: 2px; border-radius: 4px; background: #3fb950; vertical-align: middle; }
</style>
</head>
<body>
<header>
  <h1>fleet-settings</h1>
  <nav>
    <button id="tab-sessions" class="active" onclick="showTab('sessions')">Sessions</button>
    <button id="tab-agents" onclick="showTab('agents')">Agents</button>
    <button id="tab-teams" onclick="showTab('teams')">Teams</button>
    <button id="tab-budgets" onclick="showTab('budgets')">Budgets</button>
    <button id="tab-policy" onclick="showTab('policy')">Policy</button>
  </nav>
  <div id="statusline">loading…</div>
</header>
<main>
  <section id="panel-sessions" class="tab active"><h2>Sessions</h2><div id="sessions"></div></section>
  <section id="panel-agents" class="tab"><h2>Agents</h2><div id="agents"></div></section>
  <section id="panel-teams" class="tab"><h2>Teams &amp; Rooms</h2><div id="teams"></div></section>
  <section id="panel-budgets" class="tab"><h2>Budgets</h2><div id="budgets"></div></section>
  <section id="panel-policy" class="tab"><h2>Policy</h2><div id="policy"></div></section>
</main>
<script>
const API = ${JSON.stringify(apiBase)}
const $ = (id) => document.getElementById(id)
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  $('tab-' + name).classList.add('active')
  $('panel-' + name).classList.add('active')
  if (name === 'sessions') loadSessions()
  if (name === 'agents') loadAgents()
  if (name === 'teams') loadTeams()
  if (name === 'budgets') loadBudgets()
  if (name === 'policy') loadPolicy()
}
async function post(path, body) {
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!json.ok) throw new Error(json.error || JSON.stringify(json))
  return json
}
async function setStatus(line) { $('statusline').textContent = line }

async function loadSessions() {
  setStatus('sessions: loading…')
  try {
    const res = await fetch(API + '/sessions')
    const data = await res.json()
    const rows = data.sessions.map(s => \`<tr>
      <td class="mono">\${esc(s.id)}</td>
      <td>\${esc(s.agentPreset || s.origin || '—')}</td>
      <td>\${esc(s.title || '')}</td>
      <td><span class="status \${s.status}">\${s.status}</span>\${s.archived ? ' <span class="muted">(archived)</span>' : ''}</td>
      <td>\${new Date(s.updatedAt).toLocaleString()}</td>
      <td>
        <button class="action" onclick="resumeSession('\${esc(s.id)}')">resume</button>
        \${s.archived
          ? '<button class="action" onclick="restoreSession(\'' + esc(s.id) + '\')">restore</button>'
          : '<button class="action danger" onclick="archiveSession(\'' + esc(s.id) + '\')">archive</button>'}
      </td>
    </tr>\`)
    $('sessions').innerHTML = \`<table><thead><tr><th>id</th><th>agent</th><th>title</th><th>status</th><th>updated</th><th>actions</th></tr></thead><tbody>\${rows.join('')}</tbody></table>
      <p class="muted">\${data.count} sessions (\${data.running} running), \${data.archived.length} archived.</p>\`
    setStatus('sessions: \${data.count} loaded')
  } catch (e) { $('sessions').innerHTML = '<div class="empty">failed: ' + esc(e.message) + '</div>'; setStatus('sessions: error') }
}
async function resumeSession(id) {
  const text = prompt('Followup text to resume this session (sent via session.prompt, mode queue):', 'Please continue.')
  if (text === null) return
  try {
    const result = await post('/sessions/' + encodeURIComponent(id) + '/resume', { text })
    setStatus(\`resume → \${result.seam} \${result.executed ? '(accepted=' + result.accepted + ')' : '(not executed — no dsh web base URL; seam returned)'}\`)
    loadSessions()
  } catch (e) { alert('resume failed: ' + e.message) }
}
async function archiveSession(id) {
  try {
    const result = await post('/sessions/' + encodeURIComponent(id) + '/archive', { archived: true })
    setStatus(\`archive → \${result.seam} (overlay \${result.archived}) \${result.executed ? 'accepted=' + result.accepted : ''}\`)
    loadSessions()
  } catch (e) { alert('archive failed: ' + e.message) }
}
async function restoreSession(id) {
  try {
    await post('/sessions/' + encodeURIComponent(id) + '/archive', { archived: false })
    loadSessions()
  } catch (e) { alert('restore failed: ' + e.message) }
}

async function loadAgents() {
  setStatus('agents: loading…')
  try {
    const res = await fetch(API + '/agents')
    const data = await res.json()
    const rows = data.profiles.map(a => \`<tr>
      <td class="mono">\${esc(a.agentId)}</td>
      <td>\${esc(a.name)}</td>
      <td>\${esc(a.role)}</td>
      <td>\${esc(a.model || a.provider || '—')}</td>
      <td>\${a.enabled ? '<span class="status running">enabled</span>' : '<span class="status idle">disabled</span>'}</td>
      <td>
        <button class="action" onclick="editAgent('\${esc(a.agentId)}')">edit</button>
        \${a.enabled
          ? '<button class="action danger" onclick="toggleAgent(\'' + esc(a.agentId) + '\', false)">disable</button>'
          : '<button class="action" onclick="toggleAgent(\'' + esc(a.agentId) + '\', true)">enable</button>'}
      </td>
    </tr>\`)
    $('agents').innerHTML = \`<table><thead><tr><th>agentId</th><th>name</th><th>role</th><th>model</th><th>enabled</th><th>actions</th></tr></thead><tbody>\${rows.join('')}</tbody></table>\`
    setStatus('agents: \${data.count} profiles')
  } catch (e) { $('agents').innerHTML = '<div class="empty">failed: ' + esc(e.message) + '</div>'; setStatus('agents: error') }
}
async function editAgent(id) {
  const model = prompt('Set model for ' + id + ' (leave empty to skip):', '')
  const body = {}
  if (model) body.model = model
  if (!model) return
  try {
    await post('/agents/' + encodeURIComponent(id), body)
    setStatus('agent ' + id + ' updated')
    loadAgents()
  } catch (e) { alert('update failed: ' + e.message) }
}
async function toggleAgent(id, enabled) {
  try {
    await post('/agents/' + encodeURIComponent(id) + (enabled ? '/enable' : '/disable'), {})
    setStatus('agent ' + id + (enabled ? ' enabled' : ' disabled'))
    loadAgents()
  } catch (e) { alert('toggle failed: ' + e.message) }
}

async function loadTeams() {
  setStatus('teams: loading…')
  try {
    const res = await fetch(API + '/teams')
    const data = await res.json()
    $('teams').innerHTML = data.teams.map(team => {
      const roomCards = team.rooms.map(room => \`<div class="card">
        <h3>\${esc(room.room.name)} <span class="muted">(\${esc(room.room.id)})</span></h3>
        <p class="muted">members: \${room.members.map(esc).join(', ') || '—'}</p>
        <p class="muted">grants: \${Object.entries(room.grants).map(([a, g]) => esc(a) + ' read=' + g.read + ' post=' + g.post + ' join=' + g.join).join(' · ')}</p>
      </div>\`).join('')
      return \`<div class="card"><h3>\${esc(team.team.name)} <span class="muted">(\${esc(team.team.id)})</span></h3>\${roomCards || '<p class="muted">no rooms</p>'}</div>\`
    }).join('') || '<div class="empty">no teams</div>'
    setStatus('teams: \${data.teams.length} teams')
  } catch (e) { $('teams').innerHTML = '<div class="empty">failed: ' + esc(e.message) + '</div>'; setStatus('teams: error') }
}

async function loadBudgets() {
  setStatus('budgets: loading…')
  try {
    const res = await fetch(API + '/budgets')
    const data = await res.json()
    const rows = data.budgets.map(b => \`<tr>
      <td class="mono">\${esc(b.id)}</td>
      <td>\${esc(b.scope.kind)}</td>
      <td>\${esc(b.scope.agentId || b.scope.taskKind || 'fleet')}</td>
      <td>\${b.cap} \${b.unit}</td>
      <td>\${Math.round(b.spentTokens)} tok / \${Math.round(b.spentCost)} cost</td>
      <td><span class="level \${data.levels[b.id] || 'ok'}">\${data.levels[b.id] || 'ok'}</span></td>
    </tr>\`)
    $('budgets').innerHTML = \`<table><thead><tr><th>id</th><th>scope</th><th>key</th><th>cap</th><th>spent</th><th>level</th></tr></thead><tbody>\${rows.join('')}</tbody></table>
      <div class="card"><h3>set a budget cap</h3>
        <form class="inline" onsubmit="return setBudget(event)">
          <input id="budget-agent" placeholder="agentId (blank = global)">
          <input id="budget-cap" type="number" min="1" step="1" placeholder="cap (tokens)" required>
          <button class="action" type="submit">set</button>
        </form>
        <p class="muted">totals: \${Math.round(data.totals.tokens)} tokens / \${Math.round(data.totals.cost)} cost · worst \${data.worst}</p>
      </div>\`
    setStatus('budgets: \${data.budgets.length} budgets')
  } catch (e) { $('budgets').innerHTML = '<div class="empty">failed: ' + esc(e.message) + '</div>'; setStatus('budgets: error') }
}
async function setBudget(event) {
  event.preventDefault()
  const agentId = $('budget-agent').value.trim()
  const cap = Number($('budget-cap').value)
  try {
    const body = { cap, actor: 'settings-page', scope: agentId ? { kind: 'agent', agentId } : { kind: 'global' } }
    await post('/budgets', body)
    setStatus('budget cap set: ' + cap)
    loadBudgets()
  } catch (e) { alert('set budget failed: ' + e.message) }
  return false
}

async function loadPolicy() {
  setStatus('policy: loading…')
  try {
    const res = await fetch(API + '/policy')
    const data = await res.json()
    const identities = Object.entries(data.identities).map(([agent, posture]) => \`<tr><td class="mono">\${esc(agent)}</td><td class="level \${posture}">\${posture}</td></tr>\`).join('')
    $('policy').innerHTML = \`<div class="card"><h3>context posture: \${data.context}</h3>
        <form class="inline" onsubmit="return setPolicy(event)">
          <select id="policy-posture"><option>Strict</option><option>Auto</option><option>Dangerous</option></select>
          <button class="action" type="submit">set context posture</button>
        </form></div>
      <table><thead><tr><th>identity</th><th>posture</th></tr></thead><tbody>\${identities || '<tr><td class="muted" colspan="2">no per-identity overrides</td></tr>'}</tbody></table>
      <div class="card"><h3>command policy</h3><p class="muted">\${data.rules.length} rules active (\${data.rules.filter(r => r.mode === 'deny').length} denials).</p></div>\`
    setStatus('policy: context=' + data.context)
  } catch (e) { $('policy').innerHTML = '<div class="empty">failed: ' + esc(e.message) + '</div>'; setStatus('policy: error') }
}
async function setPolicy(event) {
  event.preventDefault()
  const posture = $('policy-posture').value
  try {
    await post('/policy', { scope: 'context', posture, actor: 'settings-page' })
    setStatus('context posture set: ' + posture)
    loadPolicy()
  } catch (e) { alert('set posture failed: ' + e.message) }
  return false
}

loadSessions()
</script>
</body>
</html>`
}
