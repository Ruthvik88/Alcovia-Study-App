import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildDerivedState,
  buildNotificationEvent,
  dedupeOperations,
  newlySuccessfulSessions
} from "../../shared/sync";
import { STUDENT_ID, SYLLABUS_TEMPLATE } from "../../shared/seed";
import type {
  MockNotificationLog,
  NotificationEvent,
  SyncOperation,
  SyncRequest,
  SyncResponse
} from "../../shared/types";

interface PersistedServerState {
  studentId: string;
  serverVersion: number;
  operations: SyncOperation[];
  outbox: NotificationEvent[];
  mockNotifications: MockNotificationLog[];
}

const app = express();
const port = Number(process.env.PORT ?? 4000);
const dataDirectory = path.resolve(process.cwd(), "..", "server-data");
const dbFilePath = path.join(dataDirectory, "db.json");
const n8nWebhookUrl =
  process.env.N8N_WEBHOOK_URL ??
  "http://127.0.0.1:5678/webhook/alcovia-focus-success";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

async function ensureDb(): Promise<PersistedServerState> {
  await fs.mkdir(dataDirectory, { recursive: true });
  try {
    const existing = await fs.readFile(dbFilePath, "utf8");
    return JSON.parse(existing) as PersistedServerState;
  } catch (error) {
    const initial: PersistedServerState = {
      studentId: STUDENT_ID,
      serverVersion: 0,
      operations: [],
      outbox: [],
      mockNotifications: []
    };
    await fs.writeFile(dbFilePath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

async function saveDb(db: PersistedServerState): Promise<void> {
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(dbFilePath, JSON.stringify(db, null, 2), "utf8");
}

function buildSyncResponse(db: PersistedServerState): SyncResponse {
  return {
    studentId: db.studentId,
    serverVersion: db.serverVersion,
    serverOperations: db.operations,
    state: buildDerivedState(db.operations),
    acknowledgedOpIds: [],
    automation: {
      outbox: db.outbox,
      mockNotifications: db.mockNotifications
    }
  };
}

async function deliverOutbox(db: PersistedServerState): Promise<void> {
  for (const event of db.outbox) {
    if (event.delivered) {
      continue;
    }
    try {
      const response = await fetch(n8nWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event.payload)
      });
      if (!response.ok) {
        throw new Error(`Webhook responded ${response.status}`);
      }
      event.delivered = true;
      event.deliveredAt = new Date().toISOString();
      event.lastError = undefined;
    } catch (error) {
      event.lastError =
        error instanceof Error ? error.message : "Unknown delivery error";
    }
  }
}

app.get("/health", async (_request, response) => {
  const db = await ensureDb();
  response.json({
    ok: true,
    studentId: db.studentId,
    serverVersion: db.serverVersion,
    webhookUrl: n8nWebhookUrl
  });
});

app.get("/bootstrap", async (_request, response) => {
  const db = await ensureDb();
  response.json({
    ...buildSyncResponse(db),
    syllabus: SYLLABUS_TEMPLATE
  });
});

app.get("/debug/automation", async (_request, response) => {
  const db = await ensureDb();
  response.json({
    webhookUrl: n8nWebhookUrl,
    outbox: db.outbox,
    mockNotifications: db.mockNotifications
  });
});

app.post("/notifications/mock", async (request, response) => {
  const db = await ensureDb();
  db.mockNotifications.push({
    receivedAt: new Date().toISOString(),
    payload: request.body as Record<string, unknown>
  });
  await saveDb(db);
  response.status(202).json({
    ok: true,
    accepted: true,
    receivedCount: db.mockNotifications.length
  });
});

app.post("/debug/reset", async (_request, response) => {
  const reset: PersistedServerState = {
    studentId: STUDENT_ID,
    serverVersion: 0,
    operations: [],
    outbox: [],
    mockNotifications: []
  };
  await saveDb(reset);
  response.json({
    ok: true
  });
});

app.post("/sync", async (request, response) => {
  const body = request.body as SyncRequest;
  const db = await ensureDb();
  const beforeState = buildDerivedState(db.operations);
  const seenOpIds = new Set(db.operations.map((operation) => operation.opId));
  const incoming = dedupeOperations(body.pendingOperations ?? []);
  const acknowledgedOpIds: string[] = [];

  for (const operation of incoming) {
    acknowledgedOpIds.push(operation.opId);
    if (seenOpIds.has(operation.opId)) {
      continue;
    }
    seenOpIds.add(operation.opId);
    db.operations.push(operation);
    db.serverVersion += 1;
  }

  const afterState = buildDerivedState(db.operations);
  const newSuccesses = newlySuccessfulSessions(beforeState, afterState);
  for (const session of newSuccesses) {
    const alreadyQueued = db.outbox.some(
      (event) => event.sessionId === session.sessionId
    );
    if (!alreadyQueued) {
      db.outbox.push(buildNotificationEvent(db.studentId, afterState, session));
    }
  }

  await deliverOutbox(db);
  await saveDb(db);

  const payload: SyncResponse = {
    studentId: db.studentId,
    serverVersion: db.serverVersion,
    serverOperations: db.operations,
    state: afterState,
    acknowledgedOpIds,
    automation: {
      outbox: db.outbox,
      mockNotifications: db.mockNotifications
    }
  };
  response.json(payload);
});

app.listen(port, () => {
  console.log(`Alcovia sync server listening on http://localhost:${port}`);
});
