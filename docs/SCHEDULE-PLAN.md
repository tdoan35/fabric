# Schedule page: agents' recurring jobs on a weekly calendar

## Context
Fabric's agents only work when the user asks: a chat handoff starts a team run, or a dev route does. We want them to also work **proactively**, on schedules the user sets, and we want one page where the user can see that. The page is **Schedule**, placed in the sidebar above **Work**.

The page has two parts:
- **A weekly calendar.** Each time slot shows which agent does what. Past slots show what actually ran and its status. Future slots show what is planned.
- **A right rail.** It holds a mini month calendar, an agent filter, and the list of routines.

The flagship example is **Dana's morning digest, every day at 8:00 AM**.

Decisions already made:
- **Scope.** A real scheduler runs in `apps/server`. The page also works in mock mode.
- **Two job kinds:**
  - **Team jobs** start a real team run, which lands on the Work board with a report.
  - **Dana jobs** run one assistant turn and post the result in that schedule's own chat thread.
- **Recurrence** is set with a friendly picker: Once, Daily, Weekdays, Weekly on chosen days, or Monthly, plus a time. It is stored as cron underneath.
- **The calendar shows past runs with their status, plus upcoming occurrences.**
- **Google Calendar is out of scope.** The occurrences API is the seam where outside events can merge in later.

## Data model (`packages/contracts`)
The contracts package is frozen at `contracts-v1`, so this is an integrator change. Add a new file `src/schedule.ts` and re-export it from `src/index.ts`.

- **`Recurrence`** = `{ freq: "once"|"daily"|"weekdays"|"weekly"|"monthly", time: "HH:mm", days?: number[] /*0=Sun*/, date?: "YYYY-MM-DD" }`
- **`Schedule`** has these fields:
  - `id`, `title`
  - `kind: "team"|"assistant"`
  - `agentId`: the face shown on the calendar. For Dana jobs this is `"dana"`; for team jobs it is the team lead.
  - `teamId?`, `projectId?`
  - `prompt`: the objective or instructions
  - `recurrence`, `cron` (derived), `tz` (IANA)
  - `durationMin`: block height only, default 30
  - `enabled`
  - `sessionId`: the schedule's thread
  - `createdAt`
- **`ScheduleFire`** = `{ id, scheduleId, scheduledFor, firedAt, status: "fired"|"skipped"|"missed"|"failed", runId?, taskId?, messageId?, error? }`
- **`Occurrence`** is the read model the calendar draws:
  - `{ scheduleId, at, end, agentId, title, kind, state, runId?, taskId?, reportId?, sessionId?, messageId? }`
  - `state` is one of: `upcoming`, `running`, `accepted`, `blocked`, `stopped`, `posted`, `skipped`, `missed`, `failed`.
- **Pure helpers, no dependencies:**
  - `toCron(r)`: weekdays → `0 8 * * 1-5`, and so on.
  - `describeRecurrence(r)` → "Weekdays at 8:00 AM".
- **Zod schemas:**
  - `ScheduleSchema`, `ScheduleInputSchema` (create and patch), `OccurrenceSchema`.
  - Bind each to its interface with `satisfies z.ZodType<T>`, the same way `api.ts` does.
- **`AppEventSchema`** (`events.ts:52`) gets a new member `{ type: "schedule.changed" }`.
- **`apps/server/src/__tests__/contract.test.ts`** must cover the new schemas.

## Persistence (`packages/db`)
- **`schema.ts`** gets two tables:
  - `schedules`: one column per `Schedule` field. `recurrence` is jsonb.
  - `schedule_fires`: has a **unique index on `(schedule_id, scheduled_for)`**. Claiming an occurrence is `INSERT … ON CONFLICT DO NOTHING RETURNING`, which makes firing idempotent even if two processes or two ticks race.
- **Migration:** generate `0004_*` with drizzle-kit, against `DATABASE_URL_UNPOOLED`.
  - The `migrate` script cited in `drizzle.config.ts` doesn't exist. Add `"migrate": "drizzle-kit migrate"` and `"generate": "drizzle-kit generate"` to `packages/db/package.json`.
- **New `src/schedules.ts`**, exported from `index.ts`:
  - `listSchedules`, `getSchedule`, `insertSchedule`, `updateSchedule`, `deleteSchedule`
  - `claimFire`, `finishFire`
  - `listFires(from, to)`: joins `runs` for `status`, `report_id` and `task_id`.
- **`seed.ts`** seeds the fixtures from `packages/fixtures/src/schedules.ts` (new):
  - Dana: "Morning digest", daily at 08:00.
  - Research Team (lead Elliot): "Weekly literature sweep", Mon 09:00.
  - Product Team (lead Diego): "Demand pulse", Fri 14:00.
  - A few past fires (accepted, posted, blocked), so the week isn't empty.

## Server (`apps/server`)
- **Dependency:** `croner`, which is tz-aware and has zero dependencies. It handles both "next occurrences" and the window expansion.
- **`routes/schedules.ts`** is mounted in `index.ts` with `.route("/", schedules)`:
  - `GET /schedules`
  - `POST /schedules`: validates, derives `cron`, creates the schedule's thread via the assistant store's `ensureSession`, then publishes `schedule.changed` and `registry.changed` so the sidebar's Threads list updates.
  - `PATCH /schedules/:id`: edits, and toggles `enabled`.
  - `DELETE /schedules/:id`
  - `POST /schedules/:id/run`: fires now, recorded as a fire at `now`.
  - `POST /schedules/:id/skip` `{ at }`: pre-claims that occurrence as `skipped`.
  - `GET /schedules/occurrences?from&to`: expands each enabled schedule with croner over the window, then overlays the fires. Fires win, and a fire outside the cron pattern (from "Run now") is still shown.
- **`services/scheduler.ts`:** `startScheduler()` is called after `serve()` in `index.ts`. It is disabled when `SCHEDULER=off`, and tests set that.
  - Every 30 s, for each enabled schedule, it takes the occurrences in `(now − 10 min, now]` and fires each one it successfully claims.
  - Older unclaimed occurrences, from while the server was down, are claimed as `missed` and not run late. A 7 AM digest at noon is noise.
- **`services/schedule-fire.ts`** has two functions, one per job kind:
  - **`fireTeamJob`** generalizes `services/dev-team.ts:50-76`:
    - Build the `Brief` from `prompt` plus the team's `criteria`, with tokens from `countTokens(renderBrief(…))`.
    - `writer.createTask({ projectId, teamId, title: "<title> · <date>", sessionId: schedule.sessionId })`. If `createTask` doesn't take `sessionId` yet, extend it in `writer.ts`.
    - Then `writer.startRun(…)`, then `runtime().team()!.startTeamRun(run.id)`.
    - Store `runId` and `taskId` on the fire. The existing `finalizeRun` then has Dana post the results into the schedule's thread for free.
    - The default project is a "Routines" project, created on first use.
  - **`fireAssistantJob`** calls a new `Assistant.runScheduled({ sessionId, title, prompt })`. It stores `messageId` and publishes `session.message`.
- Every fire publishes `schedule.changed`.

## Dana's scheduled turn (`packages/agents/src/assistant`)
- Add `runScheduled` to the `Assistant` interface (`index.ts:40`).
- **The turn is one `generateText` call:**
  - It uses Dana's system prompt from her profile, `readDanaView` and her memories.
  - Its tools are read-only: Exa search if available. There are no propose or handoff tools, because a routine never starts a team behind the user's back.
- **Output:** the reply is inserted with `insertMessage(db, sessionId, "assistant", parts)` as a header part ("Morning digest · Sun Oct 4") plus text. Then `touchSession(…, "unread")`.
- **Fixture mode** (`DANA_MODE=fixture`) returns a canned digest, so demos work without a model.

## Web (`apps/web/src`)
- **Navigation:**
  - `components/shell/app-shell.tsx:28`: insert `{ href: "/schedule", label: "Schedule", icon: CalendarClock, match: p => p.startsWith("/schedule") }` before Work.
  - `router.tsx`: add the `schedule` route → `routes/schedule.tsx`, with `scheduleLoader` and `scheduleShouldRevalidate`.
  - The loader reads `?week=YYYY-MM-DD` (that week's Sunday, matching the mini calendar's S-first grid). It loads `listSchedules()` plus `listOccurrences(from, to)` and stores the registry via `setRegistry`, which is already loaded.
  - Revalidate when `week` changes. Don't revalidate when only `?occ=` (the selection) changes.
- **API** (`lib/api/http.ts`, `lib/api/mock.ts`): add `listSchedules`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `runScheduleNow`, `skipOccurrence`, `listOccurrences`.
  - Mock mode keeps an in-memory store seeded from `@fabric/fixtures/schedules`. It expands occurrences with croner, which the web app also takes as a dependency.
  - In mock mode, "Run now" just appends a `posted` or `running` fire.
- **`routes/root.tsx` SSE:** on `schedule.changed`, revalidate. `run.changed` already revalidates, which moves blocks from running to accepted live.
- **Extract `MiniCalendar`** from `components/weave/day-rail.tsx:146` into `components/calendar/mini-calendar.tsx`, with props `{ selected, onPick, marks?(day), highlightWeek? }`. Weave keeps its behavior by passing `weaveDayMarkers`.
- **`lib/schedule.ts`:** local-time week math (`weekStart`, `weekDays`, `minutesOfDay`) and a layout helper that splits overlapping blocks into side-by-side columns.
  - Unlike Weave's `format.ts`, this uses the user's local tz and real `Date.now()`, not UTC and `WEAVE_NOW`.
- **`components/schedule/`** (new):
  - **`schedule-page.tsx`:**
    - A `PageHeader` with "Schedule", a ‹ Today › week nav, a range label ("Oct 4 – 10"), and a **New schedule** button.
    - The same glass panel as `components/work/board.tsx:38-84`, split into the `WeekGrid` (flex-1) and a `w-72` right rail.
    - The rail holds the `MiniCalendar` (picking a day jumps to its week, and days with jobs get dots), an **Agents** filter (a `Face` plus a count per agent, toggling visibility), and a **Routines** list (title, `describeRecurrence`, an enabled `Switch`, click to edit).
  - **`week-grid.tsx`:**
    - 7 day columns and an hour gutter covering a 24 h scroller that auto-scrolls to about 7 AM. It reuses the `Timebox` idiom from `day-rail.tsx:198-260` (absolute blocks at px-per-minute, a now line in `bg-warn`).
    - **Blocks** are tinted by agent `tone` and show the `Face` from `components/weave/parts.tsx:22`, the title and the time.
    - **State styling:**
      - upcoming: dashed border
      - running: `bg-run`, pulsing dot
      - accepted or posted: ok
      - blocked: warn
      - failed: destructive
      - skipped or missed: faded and struck through
    - **Clicking** an empty slot opens the editor prefilled with that day and time. Clicking a block sets `?occ=`.
  - **`occurrence-sheet.tsx`** (`Sheet`): the schedule summary, this occurrence's state and links, and the actions **Run now**, **Skip this one**, **Edit routine** and **Pause**.
    - Links go to `/work/:taskId`, `/reports/:reportId` and the thread via `sessionHref`.
  - **`schedule-editor.tsx`** (`Dialog`):
    - **Fields:**
      - Title
      - **Who**: a `DropdownMenu` listing Dana plus each team from `studioTeams()`, with its lead's face.
      - Instructions (a textarea)
      - Project (team jobs only)
      - **Repeat**: the existing `Segmented` from the Work board, with Once, Daily, Weekdays, Weekly and Monthly.
      - Day chips when weekly; a native `date` input when once or monthly.
      - A native `time` input, and duration.
    - **Footer:** a live summary ("Weekdays at 8:00 AM · next Mon, Oct 5 · America/Los_Angeles") and Delete when editing.
- **Not in v1:** drag-to-create or drag-to-move, and Google Calendar.

## Docs
- `docs/ARCHITECTURE.md`: a short Scheduler section covering the tick, claims and the two job kinds.
- `docs/MOCKUP-GAPS.md` AGT-5: Dana's morning digest is now real.

## Verification
1. **Unit tests:**
   - In `apps/server/src/__tests__/schedule.test.ts`: `toCron` and `describeRecurrence` for every freq, and croner expansion across a DST boundary in `America/Los_Angeles`.
   - The occurrences overlay merges fires correctly: a skip hides the occurrence, and "Run now" adds an off-pattern one.
2. **Database test:** `packages/db/src/__tests__/schedule-claim.test.ts` makes 10 concurrent `claimFire` calls for the same slot and checks that exactly one wins. Like `writer-race.test.ts`, it is skipped without `DATABASE_URL`.
3. Run `npm run typecheck` and the existing test suites, including `contract.test.ts`.
4. **Mock mode:** run the web app with `VITE_API_MODE` unset, open `/schedule`, and check:
   - The seeded week shows Dana at 8:00 every day, Elliot on Monday and Diego on Friday.
   - Creating, editing, pausing and skipping all update the grid.
   - The Weave mini calendar still works.
5. **HTTP mode:** run against a Neon branch after `npm run migrate -w @fabric/db` and the seed.
   - Create a Dana job and a Research Team job, each 2 minutes out. Watch them fire within about 30 s of the minute.
   - The Dana block turns `posted`, and its thread shows the digest as unread.
   - The team block turns `running`, the task appears on Work, and the block turns `accepted` with a report link when the run finishes.
   - Restart the server across a scheduled minute and confirm the job is marked `missed`, not run late.
6. **Screenshots:** use the `run` skill or Chrome for the page, the light and dark themes, and the collapsed sidebar icon.
