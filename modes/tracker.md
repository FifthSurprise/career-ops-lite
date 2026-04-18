# Mode: tracker — Application Tracker

Reads and displays `data/applications.md`.

**Tracker format:**
```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```

Possible statuses: `Evaluated` → `Applied` → `Responded` → `Contact` → `Interview` → `Offer` / `Rejected` / `Discarded` / `DO NOT APPLY`

- `Applied` = the candidate sent their application
- `Responded` = A recruiter/company made contact and the candidate responded (inbound)
- `Contact` = The candidate proactively reached out to someone at the company (outbound, e.g., LinkedIn power move)

If the user asks to update a status, edit the corresponding row.

Also display statistics:
- Total applications
- By status
- Average score
- % with PDF generated
- % with report generated
