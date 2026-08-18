---
type: concept
title: Fleet Job Protocol
tags: [tasks, lifecycle, v2-v3]
related: [fleet-tasks, fleet-job-protocol-source]
created: 2026-08-18
updated: 2026-08-18
---

# Fleet Job Protocol

V2 job kinds (43001-43006) mapped to V3 fleet task operations.

## Mapping

| V2 Kind | V2 Name | V3 Fleet Mapping |
|---------|---------|-------------------|
| 43001 | JOB_REQUEST | task_create |
| 43002 | JOB_ACCEPTED | claim (claimWake or task_claim) |
| 43003 | JOB_PROGRESS | task_update + fleet/task-progress |
| 43004 | JOB_RESULT | task_complete |
| — | QA gate | task_accept (PASS) / task_reject (FAIL) |
| 43005 | JOB_CANCEL | task_cancel |
| 43006 | JOB_ERROR | task_escalate |

## Dispatch Flow

```
owner → lead → task_create (claimRole, artifactContract)
  → supervisor wake → agent claims (Started, token)
  → agent works, posts progress
  → task_complete (evidence, artifacts)
  → QA gate: task_accept or task_reject
```
