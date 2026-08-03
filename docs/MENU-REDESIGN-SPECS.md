# Menu Redesign — Review & Implementation Specs

**Scope:** every hamburger-menu page except the Build Pipeline / Dev page (handled separately).
Pages reviewed: History, Insights, Analytics, Goals, Routines, Preferences
(`mobile/src/components/common/MenuOverlay.tsx` → `ITEMS`).

**Method:** all source read from remote `main` (2026-08-03). Every claim below is grounded in the
current code, not the docs' aspirations.

**Judging standard:** does this page genuinely help Mike quit / stay conscious / see something he
can't get from the conversation or the Mission dashboard? Conversation is the primary surface; the
Mission dashboard already owns "time since last cigarette" + the hour-by-hour day timeline +
scrollable multi-day history. Anything redundant with those, or fake, gets cut.

---

## Verdict summary & priority order

| Page | Today | Verdict |
|---|---|---|
| History | Broken-live: fetch always 401s → permanent empty state | **ELIMINATE** |
| Insights | Empty-state stub (backend never shipped) | **REDESIGN** — becomes the one reflective page |
| Analytics | Empty-state stub (real `/stats/all` exists but unused here) | **ELIMINATE** (fold trend into Insights) |
| Goals | Empty-state stub (placeholder data was fabricated, since removed) | **ELIMINATE** (fold records into Insights) |
| Routines | Placebo: toggles write to an unpersisted store **nothing reads** | **ELIMINATE** |
| Preferences | Mostly live and useful | **KEEP** with small fixes |

**Resulting menu:** `Insights`, `Preferences` (+ `Build Pipeline` when the dev flag is on).
Six rows become two. That is the correct shape for this product: the conversation and the Mission
dashboard do the daily work; the menu holds one reflective page and one settings page.

**Recommended PR sequence (each is one pipeline directive):**

1. **PR A — The Cut** (do first; pure deletion, lowest risk, immediately removes broken/placebo UI):
   eliminate History, Analytics, Goals, Routines; delete the dead drawer/nav components; purge the
   fabricated `PLACEHOLDER_*` data from `statsService.ts` and fix the one live consumer that can
   still fall back to it (StreamCard heatmap).
2. **PR B — Insights redesign**: new server endpoint exposing canonical memory facts + rebuild
   `insights.tsx` on real data (`user_facts` + `/stats/all`).
3. **PR C — Preferences polish**: real version number, wire "Export my data" to the existing
   `/context/dump` endpoint.

---

## 1. History — ELIMINATE

### Current state

[history.tsx](mobile/app/(app)/history.tsx) renders a `FlatList` of `SessionCard`s from
`fetchSessionStats()` ([sessionStats.ts](mobile/src/services/sessionStats.ts)), which calls
`GET /events?eventTypes=session…`.

**It is broken in production.** The server's `GET /events` handler requires
`authorizeProfileAccess` — a Supabase JWT (or admin secret) in the `Authorization` header
(`server/index.js` ~line 2550/2563). `fetchSessionStats.fetchEvents` sends **no headers at all**,
so every request 401s, the catch swallows it, and the screen shows the "Your story starts here"
empty state forever. The in-file audit comments marking it "LIVE" are wrong in practice.
(Same latent bug: [profile.tsx](mobile/app/(app)/profile.tsx) calls the same helper — see §7.)

### Verdict: ELIMINATE

Even fixed, a session-by-session card list is the wrong surface for this product:

- The **Mission dashboard's `MultiDayCalendarView`** is already the factual record — every logged
  event, hour by hour, scrollable back to account creation, with activity labels. A second
  chronological list of "sessions" is redundant and weaker (no context, no timeline).
- "Reviewing what we talked about" is the **conversation's** job. The canonical memory system and
  session reports feed the buddy's context; Mike can just ask "what did we figure out last week?"
  and get a better answer than any card list.
- Outcome/streak bookkeeping per session ("resisted", intensity 7→3) drifts toward per-cigarette
  scorekeeping, which the product explicitly avoids (resist mode is a per-moment conscious choice,
  not a ledger of every cigarette).

### Spec (part of PR A)

**Remove:**

- `mobile/app/(app)/history.tsx` (delete file).
- `mobile/src/components/history/SessionCard.tsx` and the now-empty `components/history/` dir.
- In [MenuOverlay.tsx](mobile/src/components/common/MenuOverlay.tsx): remove `'history'` from the
  `MenuKey` union and its row from `ITEMS`.
- In [_layout.tsx](mobile/app/(app)/_layout.tsx): remove the `case 'history'` from `handleNavigate`
  and the `<Stack.Screen name="history" …/>` entry. (The `never` exhaustiveness guard makes any
  missed reference a typecheck failure — rely on it.)

**Keep:** `sessionStats.ts` itself (profile.tsx still uses `fetchSessionStats`; see §7 for its
auth fix). Session/report **writes** (`outcomeRecorder.ts`, `/session/report`) are untouched —
they feed memory, which is their real job.

**Acceptance criteria:**

- `history` appears nowhere under `mobile/` except (possibly) old test snapshots, which are updated.
- Menu shows no History row; deep-navigating to `/history` no longer resolves.
- `tsc`, lint, and the existing test suite pass (the exhaustive `switch` compiles with the
  narrowed `MenuKey`).

---

## 2. Insights — REDESIGN (this becomes the menu's one reflective page)

### Current state

[insights.tsx](mobile/app/(app)/insights.tsx) is a hardcoded `EmptyState` ("Insights are
coming"). An earlier audit pass removed the render path because `GET /insights` doesn't exist on
bb-server and the client fell back to `PLACEHOLDER_INSIGHTS` — hardcoded fictional observations
("garage walk worked 8 of 10 times", "calling Alec") that were rendered as if real. Honest stub
today; zero value.

### Verdict: REDESIGN

This is the one menu page worth building, because the data now actually exists and nothing else
surfaces it:

- The **canonical memory store** (`server/factStore.js`, `user_facts`) holds exactly what a
  reflective page should show: `trigger`, `window`, `routine`, `coping`, `watch`, `motivation`
  facts with confidence and evidence — the buddy's actual model of Mike's habit loop (car-entry,
  post-meal, threshold moments…). Today Mike can only see this via admin tooling.
- Seeing "here's what Buddy is watching for you" serves the core skill — **staying conscious of
  the pattern** — and doubles as transparency into the memory system (trust; he can correct wrong
  facts in conversation: "that's not right, forget that").
- The real `/stats/all` endpoint (`buildJourneyStats`) already computes the 30-day daily-count
  trend and honest records (longest *waking* gap, best-week resists) — the two numbers from
  Analytics/Goals worth saving. They land here instead of on two dead pages.

The page's contract: **everything shown is real, attributed, and conversation-linked.** No
placeholder fallbacks of any kind — sections that lack data say so.

### Spec (PR B)

**Server — new endpoint `GET /facts/:userId` in `server/index.js`:**

- Auth: `authorizeProfileAccess(req, userId)` (Supabase JWT), same as `GET /events`. Not the
  shared client token — this is per-user memory content.
- Response: `{ facts: [{ key, category, text, confidence, updatedAt }] }` from
  `getActiveFacts(userId)` (`factStore.js`), filtered to categories
  `['trigger','window','routine','coping','watch','motivation','quit']` — exclude
  `identity`/`person`/`preference` (low reflective value, higher privacy surface on screen).
  Reuse the existing `publicFact` shaping; do not invent a new renderer.
- Independent of `MEMORY_FACTS_ENABLED` (that flag gates the *prompt read path*; this is a
  read-only display of the canonical store, which is already written under the merge gate).
  If the store is empty or `!isConfigured()`, return `{ facts: [] }`.

**Server — gate `/stats/*`:** the `GET /stats/` handler currently has **no auth check at all**
(anyone with a userId can read journey/records). Add `authorizeProfileAccess` there in the same
PR. Verify first that no server-to-server consumer hits `/stats/*` unauthenticated — the voice
agent uses `/context/stats` and `/context/factsline` (different routes, unaffected).

**Client — rebuild `mobile/app/(app)/insights.tsx`:**

Screen title: **"Insights"** (keep the name and menu row; no churn). Wrapped in the existing
`ScreenWithEntity`. Four sections, each independently loading, each with an honest empty state:

1. **"What Buddy's watching"** — trigger/window/watch/routine facts as cards (text + subtle
   category tag). Each card has a **"Talk about this"** action → navigates to `/session` with the
   fact text as trigger context (reuse the `triggerContext` mechanism in `sessionStore` that the
   session screen already consumes). This is the page's spine: every insight leads back into
   conversation, not into more dashboard.
2. **"What works for you"** — `coping` + `motivation` facts, same card treatment.
3. **"The trend"** — 30-day daily-count line from `fetchStatsAll().journey`
   (reuse [ArcChart](mobile/src/components/journey/ArcChart.tsx) and the existing
   `arcFromStatsAll` adapter). Baseline line included. If `< 7` days of data: "Not enough days
   logged yet."
4. **"Personal records"** — two rows only, from `fetchStatsAll().records`: *Longest waking gap*
   (`formatGapMs(longest_waking_gap_ms)`, with date) and *Best week of resists*
   (`best_week_resists`). Keep the existing framing: records only grow; sleep isn't a struggle;
   a slip never resets anything. No milestones, no badges, no celebration banner.

Data plumbing:

- New `fetchFacts(userId)` in a small `mobile/src/services/factsService.ts` — JWT header via
  `getAuthToken()` (`services/supabase.ts`), returns `[]` on any failure. **No placeholder data.**
- `fetchStatsAll` gains the same `Authorization: Bearer <jwt>` header (required once `/stats/*`
  is gated). Its other consumer (StreamCard) picks the header up for free.

**Files touched:** `server/index.js` (+~40 lines), `mobile/app/(app)/insights.tsx` (rewrite),
`mobile/src/services/factsService.ts` (new), `mobile/src/services/statsService.ts` (auth header),
reuse `ArcChart`. `InsightCards.tsx`/`WhatWorksList.tsx` may be adapted or replaced by simpler
local components — delete whichever aren't used when done.

**Acceptance criteria:**

- With facts in `user_facts` and a signed-in JWT: sections 1–2 render those facts verbatim from
  the server; nothing renders that isn't in the API response.
- "Talk about this" opens the session screen and the buddy's first response reflects the passed
  trigger context (manual E2E once; automated: sessionStore receives the context string).
- With an empty store / new user: all four sections show their empty states; zero fabricated data.
- `GET /facts/:userId` and `GET /stats/*` return 401 without a valid JWT for that user.
- lint + typecheck + unit tests green.

---

## 3. Analytics ("Journey") — ELIMINATE

### Current state

[analytics.tsx](mobile/app/(app)/analytics.tsx) is a hardcoded `EmptyState` ("Your journey is
loading up"). The audit pass stripped ArcChart/HoursHeatmap/WhatWorksList/IndependenceTrend/
InsightCards because they all fell back to fabricated `PLACEHOLDER_JOURNEY` data. Note the audit
comment is slightly stale: `/stats/journey|heatmap|records|all` **do** exist on the server now
(`buildJourneyStats`) — but in a different shape, and this screen was never rewired.

### Verdict: ELIMINATE

- The one genuinely motivating artifact (30-day trend) moves to Insights (§2), where it sits next
  to the "why" (patterns, what works) instead of alone on a chart page.
- The urge-time heatmap **already renders inside the conversation surface** — StreamCard's
  `HeatmapCard` ("Your hours — what Buddy watches for you") on the session screen. A second copy
  on a menu page is clutter.
- "Independence trend" (self-initiated vs prompted) has no real data pipeline and is
  analytics-for-analytics — the buddy can *say* "you've been coming to me before the urge peaks
  lately", which lands better than a stacked bar.
- A dedicated charts page is the definition of dashboard clutter for a one-user product whose
  dashboard already exists.

### Spec (part of PR A)

**Remove:**

- `mobile/app/(app)/analytics.tsx` (delete file).
- `'analytics'` from `MenuKey` + `ITEMS` in MenuOverlay; `case 'analytics'` + its `Stack.Screen`
  in `_layout.tsx`.
- `mobile/src/components/journey/IndependenceTrend.tsx` (no other consumer; delete).
  **Keep** `ArcChart.tsx` (Insights §2 reuses it) and `HoursHeatmap.tsx` (StreamCard uses it).

**Purge fabricated data (same PR):** in [statsService.ts](mobile/src/services/statsService.ts)
delete `PLACEHOLDER_RECORDS`, `PLACEHOLDER_JOURNEY`, `PLACEHOLDER_INSIGHTS` and the functions
that serve them (`fetchRecords`, `fetchJourney`, `fetchInsights`). One live consumer depends on
the fallback: `StreamCard.tsx` `HeatmapCard` falls back to `fetchJourney()` → fake heatmap when
`/stats/all` fails validation. Change it to render "Not enough data yet" instead. After this, the
codebase contains **no fictional stats anywhere** — the same principle as the fabricated-count
fix on the server side.

**Acceptance criteria:**

- No `PLACEHOLDER_` identifier remains under `mobile/`.
- Session-screen heatmap card shows live data or an honest empty state — never the old fake grid
  (verify by pointing the client at a dead server).
- Menu row gone, route gone, typecheck/lint/tests green.

---

## 4. Goals ("Records") — ELIMINATE

### Current state

[goals.tsx](mobile/app/(app)/goals.tsx) is a hardcoded `EmptyState` ("Records start here"). The
removed version rendered `PLACEHOLDER_RECORDS` — fabricated records/milestones (fake dates, fake
"calling Alec" context) plus a celebration banner that **fired on every mount** because the
placeholder always had `isNew: true`. Rightly gutted.

### Verdict: ELIMINATE

- The two honest records the server actually computes (longest waking gap, best-week resists)
  move to Insights (§2) as two quiet rows. They don't justify a page.
- A milestones/badges wall is gamification surface the product explicitly rejects
  (no dependency-farming; success = needing the app less). A celebration wall pointed at a
  54-year-old quitting a 45-year habit is the wrong voice — the buddy celebrating a real record
  *in conversation, at the moment it happens* is the right one. (The server already computes
  `best_week_resists`/gap records; surfacing "new personal best" belongs to the agent's context,
  not a trophy room.)
- "Goals" as a label was a lie anyway — the page never contained goals, and goal-setting
  (the quit itself, resist-mode choices) lives in conversation.

### Spec (part of PR A)

**Remove:**

- `mobile/app/(app)/goals.tsx` (delete file).
- `'goals'` from `MenuKey` + `ITEMS`; `case 'goals'` + `Stack.Screen` in `_layout.tsx`.
- `RecordStat` / `Milestone` / `RecordsData` types + `fetchRecords` +
  `PLACEHOLDER_RECORDS` from `statsService.ts` (covered by the §3 purge).

**Explicitly out:** do not re-add milestones/celebration UI anywhere. StreamCard's existing
"Records & milestones" card on the session screen already shows the two live records; it stays.

**Acceptance criteria:** menu row gone, route gone, no records/milestone types remain except the
live `StatsAllResponse.records` shape; typecheck/lint/tests green.

---

## 5. Routines — ELIMINATE

### Current state

[routines.tsx](mobile/app/(app)/routines.tsx) is a polished settings screen (check-in times,
streak celebrations, re-engagement, quiet hours) writing to
[notificationStore.ts](mobile/src/stores/notificationStore.ts). Two fatal facts:

1. **Nothing reads the store.** Repo-wide, `useNotificationStore` is consumed only by
   routines.tsx itself. The real outreach path — `engagementEngine.ts` (risk-window monitor →
   `/nudge/send`) and `usePushSetup` — never consults `checkInEnabled`, `checkInTime1`,
   `quietStart`, or any of it. The server's `/nudge/send` doesn't either.
2. **It isn't even persisted.** The store is plain `create()` with no persist middleware (the
   in-file audit header claiming "persisted locally" is wrong). Every toggle resets on app
   restart.

So the page is a placebo: it promises "your buddy will reach out at these times" and "no
notifications during these hours" — and none of it is true. That's worse than useless in a trust
product.

Also misnamed: given always-on observation mode, "Routines" reads as *Mike's* routines (gym →
park → home drive), which is memory/dashboard territory — not notification scheduling.

### Verdict: ELIMINATE

Cut the page and the store. Proactive outreach is the engagement engine's job, driven by learned
risk windows — which is the product's actual design (observation mode learns the routine; the
server decides when to nudge). Preference-shaped control ("don't ping me after 10pm") belongs in
**conversation** — say it once, canonical memory keeps it, the server nudge path honors it. If a
hard mute is ever needed, that's one row in Preferences wired to a real server-side flag —
a separate, later directive; do not rebuild this page for it.

### Spec (part of PR A)

**Remove:**

- `mobile/app/(app)/routines.tsx` (delete file).
- `mobile/src/stores/notificationStore.ts` (delete file — no other consumers).
- `'routines'` from `MenuKey` + `ITEMS`; `case 'routines'` + `Stack.Screen` in `_layout.tsx`.

**Untouched:** `engagementEngine.ts`, `usePushSetup`, `/nudge/send`, `/push/register` — the real
nudge path keeps working exactly as before (it never read these prefs).

**Follow-up directive (not in this PR):** server-side quiet-hours honored by `/nudge/send`
(a `quiet_hours` fact or profile field checked before dispatch), settable in conversation
("stop nudging me after 10"). Only build a UI control if conversational control proves
insufficient.

**Acceptance criteria:** page, store, menu row, route all gone; grep for `notificationStore`
returns nothing; push registration and risk-window nudges still function (existing tests +
manual nudge smoke test); typecheck/lint green.

---

## 6. Preferences — KEEP (with small fixes)

### Current state

[preferences.tsx](mobile/app/(app)/preferences.tsx): About/disclaimer link, Buddy's Voice
(→ voice-settings), account row (live from Supabase auth), "Export my data — Coming soon"
(inert), Sign out (live), Developer section (dev-mode status + Build Pipeline entry, correctly
flag-gated), Version row showing the literal string **"Stat unavailable"** (the audit replaced a
hardcoded "1.0.0" with placeholder text and nobody wired the real value).

### Verdict: KEEP — this is the one page doing its job

Every row except two is real and necessary (voice settings, sign-out, disclaimer, dev entry).
It also becomes the natural home for any future one-off controls (e.g. a notifications mute),
which is exactly why the menu doesn't need a separate settings-ish page like Routines.

### Spec (PR C — small)

1. **Version row:** read the real version — `Constants.expoConfig?.version` (+
   `runtimeVersion`/build number if present) via `expo-constants` (already an Expo dependency).
   Render e.g. `1.4.2 (build 57)`. Never a hardcoded literal; never "Stat unavailable".
2. **Export my data:** wire the existing row to the **already-implemented** JWT-gated
   `GET /context/dump/:userId` (`server/index.js` ~line 2135): fetch with `getAuthToken()`,
   write JSON to a temp file, hand to the OS share sheet (`expo-sharing` is standard Expo; if
   adding it violates the "ask before new SDKs" rule, fall back to `Share.share` with the JSON
   string). This closes half of the CLAUDE.md privacy promise ("in-app delete + export") that is
   currently a dead row. In-app **delete** remains a separate follow-up directive (needs a server
   endpoint; don't fake it client-side).
3. Leave everything else exactly as is — including the dev-section gating comments and the
   launch-gate constraints they reference.

**Acceptance criteria:** version row shows the value from `app.json` config (change config →
value changes); Export produces a share sheet containing the same JSON `/context/dump` returns
for that user, and fails gracefully (toast, no crash) offline; no other row's behavior changes;
typecheck/lint/tests green.

---

## 7. Cross-cutting cleanups (fold into PR A)

These fell out of the review; they're small and belong with The Cut:

1. **Dead drawer/nav stack:** `mobile/src/components/drawer/AppDrawer.tsx`, `DrawerMenu.tsx`
   (a stale duplicate of the menu ITEMS list — would silently drift from MenuOverlay),
   `DrawerScreen.tsx`, `mobile/src/components/common/BBNavOverlay.tsx`, and
   `mobile/navigation/AppNavigator.tsx` (a one-line re-export). None are imported by any live
   screen. Delete all five.
2. **`fetchSessionStats` auth bug:** add `Authorization: Bearer <jwt>` (via `getAuthToken()`) to
   `fetchEvents` in `sessionStats.ts` — its remaining consumer, [profile.tsx](mobile/app/(app)/profile.tsx),
   currently 401s on every call and silently renders zero-state stats (session count, streak,
   resist rate). Same class of bug that killed History; fix it where the code survives.
   If profile.tsx's stats block turns out to be unwanted too, that's a separate review — it's a
   hub destination, not a menu page, and was out of scope here.
3. **MenuOverlay footprint after the cut:** `ITEMS` shrinks to
   `insights`, `preferences`; `MenuKey` union shrinks to match (plus `dev`). The compile-time
   exhaustiveness guard in `_layout.tsx` enforces consistency — let it.

---

## What Mike loses and why that's fine

- **A session log** → the Mission dashboard's multi-day calendar *is* the log, with more context.
- **Charts page** → the one chart that matters (30-day trend) lands in Insights next to the
  patterns that explain it; the heatmap already lives on the session screen.
- **Records/milestones wall** → the two honest records live in Insights; celebrations happen in
  conversation, when they're real.
- **Notification toggles** → they never worked. The buddy's outreach is driven by learned risk
  windows, and "don't ping me at night" is one sentence to the buddy, remembered permanently.

Net: fewer places to poke, one page that actually reflects what Buddy has learned, and zero
fabricated numbers anywhere in the app.
