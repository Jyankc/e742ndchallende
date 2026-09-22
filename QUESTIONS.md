1) How should late records reconcile with finance when a published day cannot change?

2) What calculation produces gross_reported and net_reported in the finance export? Please confirm included adjustments, refund attribution, and the timezone defining each reporting day.
Meanwhile: We preserve source amounts and timestamps. We have not implemented reporting or claimed reconciliation.

3) Which exchange rates and rounding rules does finance use? 
Should refunds use the original order’s rate or the refund date’s rate, and are amounts rounded per transaction or after aggregation?

4) Is cost_usd an exact replacement for spend, and was the original spend field always USD?
Meanwhile: Affected files fail validation with an explicit error. We retain the original files for review and replay.