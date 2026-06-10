export type TaskStatus = "not_started" | "in_progress" | "done";

export type SessionFailureReason = "give_up" | "app_switch";

export type FocusOutcome = "running" | "succeeded" | "failed";

export interface TaskTemplate {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
}

export interface ChapterTemplate {
  id: string;
  subjectId: string;
  title: string;
}

export interface SubjectTemplate {
  id: string;
  title: string;
}

export interface SyllabusTemplate {
  subjects: SubjectTemplate[];
  chapters: ChapterTemplate[];
  tasks: TaskTemplate[];
}

export interface OperationBase {
  opId: string;
  deviceId: string;
  counter: number;
  baseVersion: number;
  createdAt: string;
}

export interface TaskSetStatusOperation extends OperationBase {
  kind: "task.set_status";
  taskId: string;
  status: TaskStatus;
}

export interface TaskDeleteOperation extends OperationBase {
  kind: "task.delete";
  taskId: string;
}

export interface FocusStartOperation extends OperationBase {
  kind: "focus.start";
  sessionId: string;
  targetMinutes: number;
  startedAt: string;
}

export interface FocusFinalizeOperation extends OperationBase {
  kind: "focus.finalize";
  sessionId: string;
  outcome: Exclude<FocusOutcome, "running">;
  reason?: SessionFailureReason;
  finishedAt: string;
  dayKey: string;
  actualMinutes?: number;
}

export interface SubjectAddOperation extends OperationBase {
  kind: "subject.add";
  subjectId: string;
  title: string;
}

export interface ChapterAddOperation extends OperationBase {
  kind: "chapter.add";
  chapterId: string;
  subjectId: string;
  title: string;
}

export interface TaskAddOperation extends OperationBase {
  kind: "task.add";
  taskId: string;
  subjectId: string;
  chapterId: string;
  title: string;
}

export type SyncOperation =
  | TaskSetStatusOperation
  | TaskDeleteOperation
  | FocusStartOperation
  | FocusFinalizeOperation
  | SubjectAddOperation
  | ChapterAddOperation
  | TaskAddOperation;

export interface TaskEntityState {
  taskId: string;
  status: TaskStatus;
  deleted: boolean;
  winner?: OperationBase & { kind: SyncOperation["kind"] };
}

export interface FocusSessionState {
  sessionId: string;
  targetMinutes: number;
  startedAt: string;
  status: FocusOutcome;
  reason?: SessionFailureReason;
  completedAt?: string;
  dayKey?: string;
  startMeta?: OperationBase;
  finalMeta?: OperationBase;
  actualMinutes?: number;
}

export interface ChapterProgress {
  chapterId: string;
  subjectId: string;
  title: string;
  doneTasks: number;
  totalTasks: number;
  progressPercent: number;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    deleted: boolean;
  }>;
}

export interface SubjectProgress {
  subjectId: string;
  title: string;
  doneTasks: number;
  totalTasks: number;
  progressPercent: number;
  chapters: ChapterProgress[];
}

export interface FocusSummary {
  streakDays: number;
  coins: number;
  todayFocusMinutes: number;
  successCount: number;
  failedCount: number;
}

export interface DerivedState {
  tasks: Record<string, TaskEntityState>;
  sessions: Record<string, FocusSessionState>;
  syllabus: SubjectProgress[];
  focus: FocusSummary;
}

export interface NotificationEvent {
  eventId: string;
  sessionId: string;
  delivered: boolean;
  deliveredAt?: string;
  lastError?: string;
  payload: {
    eventId: string;
    studentId: string;
    sessionId: string;
    streakDays: number;
    coinsAwarded: number;
    totalCoins: number;
    todayFocusMinutes: number;
  };
}

export interface MockNotificationLog {
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface SyncRequest {
  studentId: string;
  deviceId: string;
  knownServerVersion: number;
  pendingOperations: SyncOperation[];
}

export interface SyncResponse {
  studentId: string;
  serverVersion: number;
  serverOperations: SyncOperation[];
  state: DerivedState;
  acknowledgedOpIds: string[];
  automation: {
    outbox: NotificationEvent[];
    mockNotifications: MockNotificationLog[];
  };
}
