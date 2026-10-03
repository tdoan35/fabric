# Agent status files

One file per workstream, written only by that agent: `status/<code>.md` (data, dana, team, ctx, tools, lab, ui-chat, ui-work, ops).
The integrator reads them at every checkpoint (WORK-PLAN §5.1). Template:

```markdown
# <CODE> status — updated <time>
## Spikes
- S? — pass/fail · notes · fallback chosen
## Done
## Next
## Blocked (on whom)
## Requests (contract / path / decision)
```
