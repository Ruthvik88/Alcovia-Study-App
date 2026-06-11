# Alcovia Offline-First Study App

This repo contains an offline-first implementation of Alcovia's two core features:

- Focus sessions with offline completion/failure, deterministic rewards, and exactly-once automation.
- Syllabus progress with instant local updates and explicit conflict resolution across two devices.
- Task deletion with delete-vs-edit conflict resolution.
- Automation visibility panel showing outbox events, delivery status, and mock notification deliveries.
- Bootstrap hydration from the server on first load.

Stack:

- `frontend/`: Expo + React Native (web-friendly demo surface)
- `backend/`: Express sync server
- `shared/`: shared TypeScript types and deterministic projection logic
- `n8n-workflow.json`: real n8n workflow export for focus-success notifications

Phone Device
    │
    ▼
Local Operation Queue
    │
    ▼
Express Sync Server
    │
    ▼
Outbox Event
    │
    ▼
n8n Workflow
    │
    ▼
Mock Notification Sink

## What is implemented

### Offline-first device model

Each client keeps its own durable local state in browser `localStorage`, namespaced by device id:

- `?device=phone`
- `?device=laptop`

Every user action becomes a durable operation with:

- `opId`: stable id for dedupe
- `deviceId`: source device
- `counter`: device-local Lamport-style increment
- `baseVersion`: server version the device had last seen when the op was created

The device always renders from:

- all synced server operations
- plus any pending local operations that have not been acknowledged yet

So every action works immediately without a network round trip.

### Focus sessions

Supported offline:

- start a session
- complete a session when the timer reaches target duration
- fail by tapping `Give up`
- fail by backgrounding the app for more than 5 seconds

Rewards are not stored as mutable counters. Instead, both client and server project:

- streak
- total coins
- today's focus minutes

from unique successful `sessionId`s. That is why retries and replayed sync messages do not double-award rewards.

### Syllabus progress

Task status changes apply locally at once and roll up into:

- chapter progress
- subject progress

Deleted tasks are tombstoned logically and excluded from rollups.

## Conflict strategy

This app does not use wall-clock last-write-wins.

### Same task changed on two devices

Resolution order:

1. Higher `baseVersion` wins because it was authored from a more recent shared server state.
2. If both ops were created from the same `baseVersion`, they are treated as concurrent.
3. For concurrent status edits, the more-complete status wins:
   - `done > in_progress > not_started`
4. If still tied, compare `(counter, deviceId, opId)` deterministically.

Reason: for students, preserving completed progress is usually safer than accidentally regressing it because of two offline edits from the same base state.

### Task edited on one device and deleted on the other

Delete wins, including concurrent delete-vs-edit conflicts.

Reason: this avoids resurrecting ghost tasks after one device has intentionally removed them.

To demonstrate, use the 🗑️ delete button on any task in the Syllabus view.

### Duplicate or out-of-order sync messages

- The server dedupes by `opId`.
- The client keeps local pending ops until the server acknowledges them by `opId`.
- The server projection is recomputed from the full deduped op set, so arrival order does not change the final state.

## Automation and exactly-once delivery

When the server sees a newly successful session for the first time, it creates one outbox event:

- `eventId = focus-success:<sessionId>`

The server attempts delivery to `N8N_WEBHOOK_URL`.

The n8n workflow in [n8n-workflow.json](n8n-workflow.json):

1. receives the webhook
2. dedupes by `eventId` using workflow static data
3. forwards the payload to the mock sink `POST /notifications/mock`

That means idempotency is enforced in two places:

- server outbox dedupe by `sessionId`
- n8n workflow dedupe by stable `eventId`

## Run locally

### 1. Install dependencies

```bash
npm install
```

If PowerShell blocks `npm`, use:

```powershell
npm.cmd install
```

### 2. Start the app

```bash
npm run dev
```

This starts:

- Express server on `http://localhost:4000`
- Expo web client on the URL Expo prints in the console

### 3. Open two device tabs

Open the Expo web URL twice:

- `...?device=phone`
- `...?device=laptop`

Those namespaces behave like separate devices while still sharing the same hardcoded student account.

## n8n setup

### 1. Start n8n

Example:

```bash
npx n8n
```

### 2. Import the workflow

Import [n8n-workflow.json](n8n-workflow.json).

### 3. Activate the workflow

The workflow webhook path is:

```text
/webhook/alcovia-focus-success
```

### 4. Point the server to the webhook

If you are using default local ports, this already matches:

```text
http://127.0.0.1:5678/webhook/alcovia-focus-success
```

Or override it:

```bash
N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/alcovia-focus-success npm run dev:server
```

The workflow forwards successful deduped events to:

```text
POST http://127.0.0.1:4000/notifications/mock
```

You can see those deliveries in the app's Automation panel and in the server response payload.

## Demo scenarios

### 1. Offline focus session succeeds and syncs later

1. Put `phone` offline in the dev panel.
2. Start and finish a focus session.
3. Bring `phone` back online.
4. Sync.

Expected:

- session becomes successful locally even while offline
- coins/streak/today total update locally right away
- server counts the session once
- one outbox event appears in the Automation Panel
- one mock notification appears in the Automation Panel once n8n is running

### 2. Replay the same focus sync batch

1. Finish a session.
2. Open Dev Tools from the sidebar.
3. Click `Replay last batch (N ops)` button.

Expected:

- server version does not increase for duplicate ops
- reward totals do not change
- outbox count stays the same in the Automation Panel
- n8n still emits at most one notification because `eventId` is stable

### 3. Divergent syllabus edits on two devices

1. Put both devices offline.
2. Change the same task to `Done` on one device and `In progress` on the other.
3. Bring both online and sync.

Expected:

- both devices converge to `Done`
- chapter and subject progress converge identically

### 4. Delete-vs-edit conflict

1. Put both devices offline.
2. Delete a task on one device using the 🗑️ button in the Syllabus view.
3. Mark that same task `Done` on the other.
4. Bring both online and sync.

Expected:

- delete wins
- the task disappears from progress rollups on both devices

### 5. Verify automation visibility

1. Complete a focus session online.
2. Open Dev Tools from the sidebar.
3. Check the Automation Panel.

Expected:

- Outbox Events count is 1
- Delivered count is 1 (if n8n is running) or Pending with an error
- Mock Notifs count is 1 (if n8n forwarded to `/notifications/mock`)
- Replaying the batch does not increase any of these counts

### 6. Bootstrap hydration

1. Reset the server from Dev Tools.
2. Complete a session from `phone`, let it sync.
3. Clear `laptop` localStorage (or use a fresh browser tab).
4. Open `laptop` — it will bootstrap from `/bootstrap` and show the session data immediately.

## Verified locally

I ran:

```bash
npx tsc -p frontend/tsconfig.json --noEmit
npx tsc -p backend/tsconfig.json --noEmit
npx expo export --platform web   # regenerated frontend/dist
```

I also ran direct sync requests against the live local server and confirmed:

- replaying the same successful session batch kept `serverVersion` stable on replay
- reward totals stayed at `50` coins for a 25-minute session
- outbox count remained `1`
- concurrent `done` vs `in_progress` resolved to `done`
- concurrent delete vs edit resolved to delete

## Assumptions

- One hardcoded student id is used as requested.
- Reward rule: `2 coins per focus minute`.
- Focus streak is derived from consecutive successful day keys ending at the latest successful day in the data set.
- If the app reloads while a session is still running, the client records it as `app_switch` on recovery.
- Web demo storage uses per-device namespaces instead of separate browser profiles.
- Bootstrap hydration is best-effort: if the server is unreachable the sync loop handles catchup.

## Assignment Requirements Mapping

| Requirement | Implementation |
|------------|----------------|
| Offline-first actions | Local operation queue + local projections |
| Two-device convergence | Deterministic merge rules |
| Idempotent rewards | Unique sessionId projection |
| Idempotent automation | Stable eventId + n8n dedupe |
| Conflict resolution | baseVersion + completion bias + tombstones |
| Demonstrable | Dev panel + automation panel |