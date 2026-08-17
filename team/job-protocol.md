# Fleet job protocol — V2 kinds (43001-43006) → fleet mapping

Port of the V2 job protocol (orchestration/v2/prompts/shared-v2-context.md:21-39,
Buzz custom kinds) onto the fleet plugins. In V2 a job was a threaded chat event
in the responsible agent's role channel; in V3 a job IS a fleet-tasks entry and
every lifecycle transition is a fleet-bus event the board renders.

## Mapping table

| V2 kind | V2 name | V3 fleet mapping | Fleet verb / event |
|---|---|---|---|
| 43001 | JOB_REQUEST | `task_create` — title + objective + `claimRole` + `artifactContract` | `FleetTasksService.create` → `fleet/task-created` (originKind `task`) |
| 43002 | JOB_ACCEPTED | claim by the responsible role agent — via `claimWake` (heartbeat-wake seam) or `task_claim` | `FleetTasksService.claim` → state `Started`, execution lock + token → `fleet/task-claimed` |
| 43003 | JOB_PROGRESS | `task_update` (mutable fields only) + a `fleet/task-progress` bus event (custom kind, scope `fleet`) | `FleetTasksService.update` (requires claim token) → `fleet/task-updated` |
| 43004 | JOB_RESULT | `task_complete` — requires claim token + artifact evidence (`result` = measured contract metric; `artifacts[]` = PR/artifact link) | `FleetTasksService.complete` → state `Completed`, acceptance `pending` → `fleet/task-completed` |
| — | QA gate | qa claims the review + `task_accept` (contract check) OR fleet-watchdog verifies the stopped tree structurally | `accept` → `fleet/task-accepted` (PASS) / `fleet/task-rejected` (false-done: reopen + release lock) |
| 43005 | JOB_CANCEL | `task_cancel` — requires claim token; cancels the descendant subtree | `FleetTasksService.cancel` → state `Cancelled` → `fleet/task-cancelled` |
| 43006 | JOB_ERROR | `task_escalate` — severity-routed (P0/P1/P2) with a named owner + next action (gastown, #28) | `FleetTasksService.escalate` (no lock required — a lead/watchdog intervention) → `fleet/task-escalated` |

Severity ladder (plugins/fleet-tasks/src/types.ts:11): P0 urgent, P1 normal,
P2 low. Escalation raises severity + records `{ severity, owner, nextAction,
raisedAt }` (types.ts:105-114) — no lock required because escalation is an
intervention, not the assignee's verb (service.ts:315-342).

## Dispatch flow

```
owner ──► lead ──► task_create (claimRole=dev-1, artifactContract{expectedResult,metric,passRange})
        │
        ├─► supervisor wake (kind: task-claim, context.taskId) ──► claimWake ──► dev-1 claims (Started, token)
        │                                                                        └─► fleet/task-claimed
        │
        ├─► dev-1 works in a task/<slug> worktree, posts progress: task_update + fleet/task-progress
        │
        ├─► dev-1 task_complete (evidence.result = metric value, artifacts = PR/run links)
        │        └─► fleet/task-completed ──► fleet-watchdog may verify the stopped tree
        │
        └─► qa gate: qa claims review ──► task_accept
                 ├─ PASS  → fleet/task-accepted (state Completed, acceptance accepted)
                 └─ FAIL  → fleet/task-rejected (false-done: reopen to Unstarted, lock+assignee released)
                            └─► watchdog: create [watchdog] review task + reassign by claimRole
```

## How the board shows it

Every verb publishes to fleet-bus with `originKind: 'task'` (service.ts:463-495);
supervisor/wake events use `originKind: 'supervisor'`, watchdog decisions
`originKind: 'watchdog'`. fleet-board renders the store:

- `fleet log` — text feed of events: `fleet/task-created`, `fleet/task-claimed`,
  `fleet/task-completed`, `fleet/task-accepted`, `fleet/task-rejected`,
  `fleet/task-escalated`, `fleet/task-cancelled`, `fleet/wake`, `fleet/digest`,
  `fleet/watchdog-*` — each with actor + originKind + payload (intent line).
- `fleet status` — per-actor summary derived from stored events (last event per
  agent, active/quiet/stalled counts). The board deliberately reads the DURABLE
  store, not the in-memory registry (plugins/fleet-board/src/feed.ts).
- HTTP `/fleet-board*` (dsh webServer routes or standalone bin) + the single-file
  output-first page: each event is an intent line → expandable context → raw JSON.
- `fleet_feed` tool — any agent asks "what is everyone working on?" and gets
  recent events + an activity summary (plugins/fleet-board/src/index.ts:74-121).

Filter by `originKind` to isolate a mechanism, e.g. the lead watches
`fleet/task-*` (originKind `task`) and `fleet/digest` (originKind `supervisor`),
and can `excludeOriginKinds: ['supervisor', 'watchdog']` to avoid self-triggers.
