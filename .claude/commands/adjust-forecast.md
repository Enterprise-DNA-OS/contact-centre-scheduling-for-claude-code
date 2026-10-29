---
description: Add a planner adjustment: a marketing send, a billing run, a known event, as a percentage on a queue for a time window.
---

Ask for the queue, window, percentage and reason. Write them to a private JSON file and run `npm run wfm -- add forecast_adjustments --data=imports/adjustment.json` with code, queue_id (queue code), starts_at, ends_at, volume_pct, reason, created_by. Then run /forecast to show the effect.
