import { SYLLABUS_TEMPLATE } from "./seed";
import {
  coinRewardForMinutes,
  compareStrings,
  previousDay,
  todayKey
} from "./utils";
import type {
  ChapterProgress,
  ChapterTemplate,
  DerivedState,
  FocusFinalizeOperation,
  FocusSessionState,
  NotificationEvent,
  OperationBase,
  SubjectProgress,
  SubjectTemplate,
  SyncOperation,
  TaskEntityState,
  TaskStatus,
  TaskTemplate
} from "./types";

const STATUS_RANK: Record<TaskStatus, number> = {
  not_started: 0,
  in_progress: 1,
  done: 2
};

function compareMeta(a?: OperationBase, b?: OperationBase): number {
  if (!a && !b) {
    return 0;
  }
  if (!a) {
    return -1;
  }
  if (!b) {
    return 1;
  }
  if (a.baseVersion !== b.baseVersion) {
    return a.baseVersion - b.baseVersion;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  const deviceOrder = compareStrings(a.deviceId, b.deviceId);
  if (deviceOrder !== 0) {
    return deviceOrder;
  }
  return compareStrings(a.opId, b.opId);
}

function pickTaskWinner(
  current: TaskEntityState | undefined,
  challenger: TaskEntityState
): TaskEntityState {
  if (!current) {
    return challenger;
  }
  const currentMeta = current.winner;
  const challengerMeta = challenger.winner;
  if (!currentMeta || !challengerMeta) {
    return challenger;
  }

  if (current.deleted && !challenger.deleted) {
    return current;
  }
  if (!current.deleted && challenger.deleted) {
    if (challengerMeta.baseVersion !== currentMeta.baseVersion) {
      return challengerMeta.baseVersion >= currentMeta.baseVersion
        ? challenger
        : current;
    }
    return challenger;
  }

  if (challengerMeta.baseVersion !== currentMeta.baseVersion) {
    return challengerMeta.baseVersion > currentMeta.baseVersion
      ? challenger
      : current;
  }

  if (!challenger.deleted && !current.deleted) {
    const rankDiff =
      STATUS_RANK[challenger.status] - STATUS_RANK[current.status];
    if (rankDiff !== 0) {
      return rankDiff > 0 ? challenger : current;
    }
  }

  return compareMeta(challengerMeta, currentMeta) >= 0 ? challenger : current;
}

function applyTaskOperation(
  tasks: Record<string, TaskEntityState>,
  operation: SyncOperation
): void {
  if (operation.kind !== "task.set_status" && operation.kind !== "task.delete") {
    return;
  }
  const current = tasks[operation.taskId];
  const challenger: TaskEntityState =
    operation.kind === "task.delete"
      ? {
          taskId: operation.taskId,
          status: current?.status ?? "not_started",
          deleted: true,
          winner: operation
        }
      : {
          taskId: operation.taskId,
          status: operation.status,
          deleted: false,
          winner: operation
        };
  tasks[operation.taskId] = pickTaskWinner(current, challenger);
}

function applyFocusStart(
  sessions: Record<string, FocusSessionState>,
  operation: SyncOperation
): void {
  if (operation.kind !== "focus.start") {
    return;
  }
  const current = sessions[operation.sessionId];
  if (!current || compareMeta(operation, current.startMeta) >= 0) {
    sessions[operation.sessionId] = {
      sessionId: operation.sessionId,
      targetMinutes: operation.targetMinutes,
      startedAt: operation.startedAt,
      status: current?.status ?? "running",
      reason: current?.reason,
      completedAt: current?.completedAt,
      dayKey: current?.dayKey,
      startMeta: operation,
      finalMeta: current?.finalMeta,
      actualMinutes: current?.actualMinutes
    };
  }
}

function applyFocusFinalize(
  sessions: Record<string, FocusSessionState>,
  operation: SyncOperation
): void {
  if (operation.kind !== "focus.finalize") {
    return;
  }
  const current = sessions[operation.sessionId];
  const baseline: FocusSessionState =
    current ??
    ({
      sessionId: operation.sessionId,
      targetMinutes: 25,
      startedAt: operation.finishedAt,
      status: "running"
    } as FocusSessionState);
  if (!baseline.finalMeta || compareMeta(operation, baseline.finalMeta) >= 0) {
    sessions[operation.sessionId] = {
      ...baseline,
      status: operation.outcome,
      reason: operation.reason,
      completedAt: operation.finishedAt,
      dayKey: operation.dayKey,
      finalMeta: operation,
      actualMinutes: operation.actualMinutes
    };
  }
}

interface DynamicSyllabus {
  subjects: SubjectTemplate[];
  chapters: ChapterTemplate[];
  tasks: TaskTemplate[];
}

function applySyllabusOperation(
  dynamic: DynamicSyllabus,
  operation: SyncOperation
): void {
  if (operation.kind === "subject.add") {
    if (!dynamic.subjects.some((s) => s.id === operation.subjectId)) {
      dynamic.subjects.push({ id: operation.subjectId, title: operation.title });
    }
  } else if (operation.kind === "chapter.add") {
    if (!dynamic.chapters.some((c) => c.id === operation.chapterId)) {
      dynamic.chapters.push({
        id: operation.chapterId,
        subjectId: operation.subjectId,
        title: operation.title
      });
    }
  } else if (operation.kind === "task.add") {
    if (!dynamic.tasks.some((t) => t.id === operation.taskId)) {
      dynamic.tasks.push({
        id: operation.taskId,
        subjectId: operation.subjectId,
        chapterId: operation.chapterId,
        title: operation.title
      });
    }
  }
}

function buildSyllabus(
  tasks: Record<string, TaskEntityState>,
  dynamic: DynamicSyllabus
): SubjectProgress[] {
  // Merge seed + dynamic, deduplicating by id
  const allSubjects = [...SYLLABUS_TEMPLATE.subjects];
  for (const s of dynamic.subjects) {
    if (!allSubjects.some((x) => x.id === s.id)) {
      allSubjects.push(s);
    }
  }
  const allChapters = [...SYLLABUS_TEMPLATE.chapters];
  for (const c of dynamic.chapters) {
    if (!allChapters.some((x) => x.id === c.id)) {
      allChapters.push(c);
    }
  }
  const allTasks = [...SYLLABUS_TEMPLATE.tasks];
  for (const t of dynamic.tasks) {
    if (!allTasks.some((x) => x.id === t.id)) {
      allTasks.push(t);
    }
  }

  return allSubjects.map((subject) => {
    const chapters: ChapterProgress[] = allChapters
      .filter((chapter) => chapter.subjectId === subject.id)
      .map((chapter) => {
        const chapterTasks = allTasks
          .filter((task) => task.chapterId === chapter.id)
          .map((task) => {
            const resolved = tasks[task.id];
            return {
              id: task.id,
              title: task.title,
              status: resolved?.status ?? "not_started",
              deleted: resolved?.deleted ?? false
            };
          })
          .filter((task) => !task.deleted);
        const totalTasks = chapterTasks.length;
        const doneTasks = chapterTasks.filter((task) => task.status === "done").length;
        return {
          chapterId: chapter.id,
          subjectId: subject.id,
          title: chapter.title,
          doneTasks,
          totalTasks,
          progressPercent:
            totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100),
          tasks: chapterTasks
        };
      });
    const totalTasks = chapters.reduce((sum, chapter) => sum + chapter.totalTasks, 0);
    const doneTasks = chapters.reduce((sum, chapter) => sum + chapter.doneTasks, 0);
    return {
      subjectId: subject.id,
      title: subject.title,
      doneTasks,
      totalTasks,
      progressPercent:
        totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100),
      chapters
    };
  });
}

function buildFocusSummary(
  sessions: Record<string, FocusSessionState>,
  referenceDayKey: string
): DerivedState["focus"] {
  const successfulSessions = Object.values(sessions).filter(
    (session) => session.status === "succeeded"
  );
  const failedSessions = Object.values(sessions).filter(
    (session) => session.status === "failed"
  );
  const daySet = new Set(
    successfulSessions.map((session) => session.dayKey).filter(Boolean) as string[]
  );
  const sortedDays = Array.from(daySet).sort(compareStrings);
  let streakDays = 0;
  if (sortedDays.length > 0) {
    let cursor = sortedDays[sortedDays.length - 1];
    while (daySet.has(cursor)) {
      streakDays += 1;
      cursor = previousDay(cursor);
    }
  }

  // Count today's focus minutes from ALL finalized sessions (succeeded + failed)
  // For succeeded sessions, use targetMinutes (they completed the full time)
  // For failed sessions, use actualMinutes (partial time studied)
  const allFinalized = Object.values(sessions).filter(
    (session) => session.status !== "running" && session.dayKey === referenceDayKey
  );
  const todayFocusMinutes = allFinalized.reduce((sum, session) => {
    if (session.status === "succeeded") {
      return sum + session.targetMinutes;
    }
    return sum;
  }, 0);

  const coins = successfulSessions.reduce(
    (sum, session) => sum + coinRewardForMinutes(session.targetMinutes),
    0
  );
  return {
    streakDays,
    coins,
    todayFocusMinutes,
    successCount: successfulSessions.length,
    failedCount: failedSessions.length
  };
}

export function sortOperations(operations: SyncOperation[]): SyncOperation[] {
  return [...operations].sort((left, right) => compareMeta(left, right));
}

export function dedupeOperations(operations: SyncOperation[]): SyncOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (seen.has(operation.opId)) {
      return false;
    }
    seen.add(operation.opId);
    return true;
  });
}

export function buildDerivedState(
  operations: SyncOperation[],
  referenceDayKey: string = todayKey()
): DerivedState {
  const tasks: Record<string, TaskEntityState> = {};
  const sessions: Record<string, FocusSessionState> = {};
  const dynamic: DynamicSyllabus = { subjects: [], chapters: [], tasks: [] };

  for (const operation of dedupeOperations(sortOperations(operations))) {
    applyTaskOperation(tasks, operation);
    applyFocusStart(sessions, operation);
    applyFocusFinalize(sessions, operation);
    applySyllabusOperation(dynamic, operation);
  }

  return {
    tasks,
    sessions,
    syllabus: buildSyllabus(tasks, dynamic),
    focus: buildFocusSummary(sessions, referenceDayKey)
  };
}

export function newlySuccessfulSessions(
  before: DerivedState,
  after: DerivedState
): FocusSessionState[] {
  const beforeSet = new Set(
    Object.values(before.sessions)
      .filter((session) => session.status === "succeeded")
      .map((session) => session.sessionId)
  );
  return Object.values(after.sessions).filter(
    (session) =>
      session.status === "succeeded" && !beforeSet.has(session.sessionId)
  );
}

export function buildNotificationEvent(
  studentId: string,
  state: DerivedState,
  session: FocusSessionState
): NotificationEvent {
  return {
    eventId: `focus-success:${session.sessionId}`,
    sessionId: session.sessionId,
    delivered: false,
    payload: {
      eventId: `focus-success:${session.sessionId}`,
      studentId,
      sessionId: session.sessionId,
      streakDays: state.focus.streakDays,
      coinsAwarded: coinRewardForMinutes(session.targetMinutes),
      totalCoins: state.focus.coins,
      todayFocusMinutes: state.focus.todayFocusMinutes
    }
  };
}

export function getFocusFinalizeOp(
  operations: SyncOperation[],
  sessionId: string
): FocusFinalizeOperation | undefined {
  return sortOperations(operations).find(
    (operation): operation is FocusFinalizeOperation =>
      operation.kind === "focus.finalize" && operation.sessionId === sessionId
  );
}
