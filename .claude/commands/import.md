---
description: Bring interval history or agents across from a Verint (or Calabrio) export.
---

Read docs/replace-verint-workforce-management.md. Check the export's columns against the accepted names. Run `npm run wfm -- import verint --file=imports/<file>.csv --dry-run`, show the counts, then repeat without --dry-run. Agents: `npm run wfm -- import agents --file=...`. A row that conflicts with recorded figures stops the whole import.
