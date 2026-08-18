---
type: schema
title: Wiki Schema — Page Types and Conventions
created: 2026-08-18
updated: 2026-08-18
---

# Schema

## Page Types

| type | directory | description |
|------|-----------|-------------|
| entity | wiki/entities/ | Named things: plugins, services, scripts, agents, configs |
| concept | wiki/concepts/ | Ideas, patterns, architecture decisions |
| source | wiki/sources/ | Documents, references, external docs |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related things |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |

## Naming Conventions

- Files: kebab-case.md
- Entities: match the official name (fleet-agent.md, fleet-supervisor.sh)
- Concepts: descriptive noun phrases (cordis-composition.md, fleet-agent-model.md)
- Sources: document-slug.md (deploy-prod.md, leader-contract.md)
- Queries: question as slug (missing-file-tools.md)

## Frontmatter (all pages)

```yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

## Cross-References

- Use `[[page-slug]]` syntax to link between wiki pages
- Every entity and concept should appear in wiki/index.md
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via related:

## Contradiction Handling

1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists
