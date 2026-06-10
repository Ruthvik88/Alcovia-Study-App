import React, { startTransition, useEffect, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { FOCUS_GRACE_PERIOD_SECONDS, STUDENT_ID } from "../shared/seed";
import { buildDerivedState, dedupeOperations } from "../shared/sync";
import { dateKeyFromIso } from "../shared/utils";
import FocusTimer from "./FocusTimer";
import { useTheme } from "./theme";
import type { ThemeMode } from "./theme";
import type {
  DerivedState,
  MockNotificationLog,
  NotificationEvent,
  OperationBase,
  SyncOperation,
  SyncResponse,
  TaskStatus
} from "../shared/types";

type DeviceAlias = "phone" | "laptop";
type AppView = "dashboard" | "timer" | "syllabus" | "rewards" | "settings";

interface BootstrapResponse extends SyncResponse {
  syllabus: {
    subjects: { id: string; title: string }[];
    chapters: { id: string; subjectId: string; title: string }[];
    tasks: { id: string; subjectId: string; chapterId: string; title: string }[];
  };
}

interface LocalAutomationState {
  outbox: NotificationEvent[];
  mockNotifications: MockNotificationLog[];
}

interface DeviceState {
  deviceId: string;
  namespace: string;
  online: boolean;
  lamport: number;
  knownServerVersion: number;
  serverOperations: SyncOperation[];
  pendingOperations: SyncOperation[];
  lastSentBatch: SyncOperation[];
  logs: string[];
  automation: LocalAutomationState;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "To Do",
  in_progress: "Doing",
  done: "Done"
};

const SERVER_BASE_URL =
  process.env.EXPO_PUBLIC_SERVER_BASE_URL ??
  (typeof window !== "undefined"
    ? `http://${window.location.hostname || "localhost"}:4000`
    : "http://localhost:4000");

function makeStorageKey(namespace: string): string {
  return `alcovia-device:${namespace}`;
}

function createEmptyDeviceState(deviceId: string): DeviceState {
  return {
    deviceId,
    namespace: deviceId,
    online: true,
    lamport: 0,
    knownServerVersion: 0,
    serverOperations: [],
    pendingOperations: [],
    lastSentBatch: [],
    logs: [`[${new Date().toLocaleTimeString()}] Device ${deviceId} ready`],
    automation: {
      outbox: [],
      mockNotifications: []
    }
  };
}

function normalizeDeviceState(
  deviceId: string,
  raw: Partial<DeviceState> | null | undefined
): DeviceState {
  const fallback = createEmptyDeviceState(deviceId);
  if (!raw) {
    return fallback;
  }
  return {
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : deviceId,
    namespace: typeof raw.namespace === "string" ? raw.namespace : deviceId,
    online: typeof raw.online === "boolean" ? raw.online : fallback.online,
    lamport: typeof raw.lamport === "number" ? raw.lamport : fallback.lamport,
    knownServerVersion:
      typeof raw.knownServerVersion === "number"
        ? raw.knownServerVersion
        : fallback.knownServerVersion,
    serverOperations: Array.isArray(raw.serverOperations)
      ? raw.serverOperations
      : fallback.serverOperations,
    pendingOperations: Array.isArray(raw.pendingOperations)
      ? raw.pendingOperations
      : fallback.pendingOperations,
    lastSentBatch: Array.isArray(raw.lastSentBatch)
      ? raw.lastSentBatch
      : fallback.lastSentBatch,
    logs: Array.isArray(raw.logs) ? raw.logs : fallback.logs,
    automation: {
      outbox: Array.isArray(raw.automation?.outbox)
        ? raw.automation.outbox
        : fallback.automation.outbox,
      mockNotifications: Array.isArray(raw.automation?.mockNotifications)
        ? raw.automation.mockNotifications
        : fallback.automation.mockNotifications
    }
  };
}

function parseDeviceFromUrl(): DeviceAlias {
  if (typeof window === "undefined") {
    return "phone";
  }
  const device = new URLSearchParams(window.location.search).get("device");
  return device === "laptop" ? "laptop" : "phone";
}

function readState(namespace: string): DeviceState {
  if (typeof window === "undefined") {
    return createEmptyDeviceState(namespace);
  }
  try {
    const stored = window.localStorage.getItem(makeStorageKey(namespace));
    if (!stored) {
      return createEmptyDeviceState(namespace);
    }
    return normalizeDeviceState(
      namespace,
      JSON.parse(stored) as Partial<DeviceState>
    );
  } catch {
    window.localStorage.removeItem(makeStorageKey(namespace));
    return createEmptyDeviceState(namespace);
  }
}

function writeState(state: DeviceState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    makeStorageKey(state.namespace),
    JSON.stringify(state)
  );
}

function appendLog(state: DeviceState, message: string): DeviceState {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  return {
    ...state,
    logs: [line, ...state.logs].slice(0, 40)
  };
}

function buildProjection(state: DeviceState): DerivedState {
  return buildDerivedState(
    dedupeOperations([...state.serverOperations, ...state.pendingOperations])
  );
}

function nextBase(
  state: DeviceState
): Pick<OperationBase, "baseVersion" | "counter" | "createdAt" | "deviceId"> {
  return {
    deviceId: state.deviceId,
    counter: state.lamport + 1,
    baseVersion: state.knownServerVersion,
    createdAt: new Date().toISOString()
  };
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

function withOperation(
  state: DeviceState,
  create: (
    base: Pick<OperationBase, "baseVersion" | "counter" | "createdAt" | "deviceId">
  ) => SyncOperation,
  logMessage: string
): DeviceState {
  const base = nextBase(state);
  const operation = create(base);
  return appendLog(
    {
      ...state,
      lamport: base.counter,
      pendingOperations: [...state.pendingOperations, operation]
    },
    logMessage
  );
}

function repairInterruptedSession(state: DeviceState): DeviceState {
  const projection = buildProjection(state);
  const running = Object.values(projection.sessions).find(
    (session) => session.status === "running"
  );
  if (!running) {
    return state;
  }
  return withOperation(
    state,
    (base) => ({
      ...base,
      opId: randomId("focus-finalize"),
      kind: "focus.finalize",
      sessionId: running.sessionId,
      outcome: "failed",
      reason: "app_switch",
      finishedAt: new Date().toISOString(),
      dayKey: dateKeyFromIso(new Date().toISOString()),
      actualMinutes: 0
    }),
    `Recovered an interrupted session ${running.sessionId} as app_switch`
  );
}

function getSessionCountdown(
  state: DerivedState,
  nowMs: number
): {
  sessionId: string;
  secondsLeft: number;
  minutesTarget: number;
} | null {
  const running = Object.values(state.sessions)
    .filter((session) => session.status === "running")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!running) {
    return null;
  }
  const targetSeconds = running.targetMinutes * 60;
  const elapsedMs = nowMs - new Date(running.startedAt).getTime();
  // Use Math.max(0, ...) to prevent negative elapsed (e.g. if clock is slightly behind startedAt)
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return {
    sessionId: running.sessionId,
    minutesTarget: running.targetMinutes,
    secondsLeft: Math.max(0, targetSeconds - elapsedSeconds)
  };
}

function formatDuration(secondsLeft: number): string {
  const minutes = Math.floor(secondsLeft / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(secondsLeft % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Subject icon palette for dynamically assigned icons
const SUBJECT_ICONS = ["🧮", "🔬", "📖", "🌍", "🎨", "📐", "🧪", "💻", "🎵", "🏛️", "📝", "🧠"];
function getSubjectIcon(subjectId: string, index: number): string {
  // Known subjects get fixed icons
  if (subjectId === "math") return "🧮";
  if (subjectId === "science") return "🔬";
  return SUBJECT_ICONS[index % SUBJECT_ICONS.length];
}

// Color palette for subject badges
const SUBJECT_BADGE_COLORS = [
  { bg: "#dbeafe", text: "#2563eb" },
  { bg: "#dcfce7", text: "#16a34a" },
  { bg: "#fef3c7", text: "#d97706" },
  { bg: "#fce7f3", text: "#db2777" },
  { bg: "#ede9fe", text: "#7c3aed" },
  { bg: "#e0f2fe", text: "#0284c7" },
  { bg: "#fef2f2", text: "#dc2626" },
  { bg: "#f0fdf4", text: "#15803d" },
];
function getSubjectBadgeColor(index: number) {
  return SUBJECT_BADGE_COLORS[index % SUBJECT_BADGE_COLORS.length];
}

export default function App(): React.JSX.Element {
  const { colors, mode, toggleTheme, setThemeMode } = useTheme();
  const initialDevice = parseDeviceFromUrl();
  const [selectedMinutes, setSelectedMinutes] = useState(25);
  const [customMinutesStr, setCustomMinutesStr] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customError, setCustomError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [deviceState, setDeviceState] = useState<DeviceState>(() =>
    repairInterruptedSession(readState(initialDevice))
  );
  const [showDevTools, setShowDevTools] = useState(false);
  const [currentView, setCurrentView] = useState<AppView>("dashboard");
  const [addSubjectName, setAddSubjectName] = useState("");
  const [actualBrowserOnline, setActualBrowserOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const syncInFlight = useRef(false);
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projection = buildProjection(deviceState);
  const activeCountdown = getSessionCountdown(projection, clock);
  const canSync = deviceState.online && actualBrowserOnline;

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    writeState(deviceState);
  }, [deviceState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleOnline = () => setActualBrowserOnline(true);
    const handleOffline = () => setActualBrowserOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!activeCountdown || activeCountdown.secondsLeft > 0) {
      return;
    }
    setDeviceState((current) => {
      const currentProjection = buildProjection(current);
      const running = Object.values(currentProjection.sessions).find(
        (session) => session.sessionId === activeCountdown.sessionId
      );
      if (!running || running.status !== "running") {
        return current;
      }
      return withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("focus-finalize"),
          kind: "focus.finalize",
          sessionId: running.sessionId,
          outcome: "succeeded",
          finishedAt: new Date().toISOString(),
          dayKey: dateKeyFromIso(new Date().toISOString()),
          actualMinutes: running.targetMinutes
        }),
        `Completed focus session ${running.sessionId} offline`
      );
    });
  }, [activeCountdown]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const onVisibilityChange = () => {
      if (!activeCountdown) {
        return;
      }
      if (document.hidden) {
        backgroundTimer.current = setTimeout(() => {
          setDeviceState((current) => {
            const currentProjection = buildProjection(current);
            const running = Object.values(currentProjection.sessions).find(
              (session) => session.sessionId === activeCountdown.sessionId
            );
            if (!running || running.status !== "running") {
              return current;
            }
            const targetSec = running.targetMinutes * 60;
            const elapsedSec = Math.max(0, Math.floor(
              (Date.now() - new Date(running.startedAt).getTime()) / 1000
            ));
            const actualMins = Math.round(Math.min(elapsedSec, targetSec) / 60);
            return withOperation(
              current,
              (base) => ({
                ...base,
                opId: randomId("focus-finalize"),
                kind: "focus.finalize",
                sessionId: running.sessionId,
                outcome: "failed",
                reason: "app_switch",
                finishedAt: new Date().toISOString(),
                dayKey: dateKeyFromIso(new Date().toISOString()),
                actualMinutes: actualMins
              }),
              `Failed session ${running.sessionId} after background grace window`
            );
          });
        }, FOCUS_GRACE_PERIOD_SECONDS * 1000);
      } else if (backgroundTimer.current) {
        clearTimeout(backgroundTimer.current);
        backgroundTimer.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (backgroundTimer.current) {
        clearTimeout(backgroundTimer.current);
        backgroundTimer.current = null;
      }
    };
  }, [activeCountdown]);

  async function syncWithServer(operationsOverride?: SyncOperation[]): Promise<void> {
    if (!canSync) {
      setDeviceState((current) =>
        appendLog(current, "Sync skipped because this device is offline")
      );
      return;
    }
    if (syncInFlight.current) {
      return;
    }
    syncInFlight.current = true;
    try {
      const outgoing = operationsOverride ?? deviceState.pendingOperations;
      const response = await fetch(`${SERVER_BASE_URL}/sync`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          studentId: STUDENT_ID,
          deviceId: deviceState.deviceId,
          knownServerVersion: deviceState.knownServerVersion,
          pendingOperations: outgoing
        })
      });
      if (!response.ok) {
        throw new Error(`Sync failed with ${response.status}`);
      }
      const payload = (await response.json()) as SyncResponse;
      startTransition(() => {
        setDeviceState((current) =>
          appendLog(
            {
              ...current,
              knownServerVersion: payload.serverVersion,
              serverOperations: payload.serverOperations,
              pendingOperations: current.pendingOperations.filter(
                (operation) => !payload.acknowledgedOpIds.includes(operation.opId)
              ),
              lastSentBatch: outgoing,
              automation: payload.automation
            },
            `Synced ${outgoing.length} local ops, server v${payload.serverVersion}`
          )
        );
      });
    } catch (error) {
      setDeviceState((current) =>
        appendLog(
          current,
          error instanceof Error ? error.message : "Sync failed unexpectedly"
        )
      );
    } finally {
      syncInFlight.current = false;
    }
  }

  useEffect(() => {
    if (!canSync) {
      return;
    }
    void syncWithServer();
    const timer = setInterval(() => {
      void syncWithServer();
    }, 3500);
    return () => clearInterval(timer);
  }, [canSync]);

  // Bootstrap from server on first load (if online and no local data yet)
  useEffect(() => {
    if (!canSync) return;
    if (deviceState.serverOperations.length > 0 || deviceState.pendingOperations.length > 0) return;
    (async () => {
      try {
        const response = await fetch(`${SERVER_BASE_URL}/bootstrap`);
        if (!response.ok) return;
        const payload = (await response.json()) as BootstrapResponse;
        startTransition(() => {
          setDeviceState((current) => {
            // Only hydrate if still empty (avoid race)
            if (current.serverOperations.length > 0 || current.pendingOperations.length > 0) {
              return current;
            }
            return appendLog(
              {
                ...current,
                knownServerVersion: payload.serverVersion,
                serverOperations: payload.serverOperations,
                automation: payload.automation
              },
              `Bootstrapped from server (v${payload.serverVersion}, ${payload.serverOperations.length} ops)`
            );
          });
        });
      } catch {
        // Bootstrap is best-effort; sync loop will catch up
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTaskStatus(taskId: string, status: TaskStatus): void {
    setDeviceState((current) =>
      withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("task"),
          kind: "task.set_status",
          taskId,
          status
        }),
        `Set ${taskId} to ${status}`
      )
    );
  }

  function deleteTask(taskId: string): void {
    setDeviceState((current) =>
      withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("task-del"),
          kind: "task.delete" as const,
          taskId
        }),
        `Deleted task ${taskId}`
      )
    );
  }

  async function replayLastBatch(): Promise<void> {
    if (deviceState.lastSentBatch.length === 0) {
      setDeviceState((current) =>
        appendLog(current, "No last batch to replay")
      );
      return;
    }
    setDeviceState((current) =>
      appendLog(current, `Replaying ${current.lastSentBatch.length} ops from last batch…`)
    );
    await syncWithServer(deviceState.lastSentBatch);
  }

  function startFocusSession(): void {
    if (activeCountdown) {
      return;
    }
    // Validate custom input
    if (showCustomInput) {
      const parsed = parseInt(customMinutesStr, 10);
      if (!customMinutesStr.trim() || isNaN(parsed) || parsed <= 0) {
        setCustomError("Please enter a valid time in minutes");
        return;
      }
    }
    setCustomError("");
    const sessionId = randomId("session");
    // Sync the clock immediately to prevent the off-by-one second
    const now = Date.now();
    setClock(now);
    const startedAt = new Date(now).toISOString();
    setDeviceState((current) =>
      withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("focus-start"),
          kind: "focus.start",
          sessionId,
          startedAt,
          targetMinutes: selectedMinutes
        }),
        `Started focus session ${sessionId} for ${selectedMinutes} min`
      )
    );
  }

  function giveUp(): void {
    if (!activeCountdown) {
      return;
    }
    // Calculate actual studied time
    const targetSec = activeCountdown.minutesTarget * 60;
    const elapsedSec = targetSec - activeCountdown.secondsLeft;
    const actualMins = Math.round(elapsedSec / 60);
    setDeviceState((current) =>
      withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("focus-finalize"),
          kind: "focus.finalize",
          sessionId: activeCountdown.sessionId,
          outcome: "failed",
          reason: "give_up",
          finishedAt: new Date().toISOString(),
          dayKey: dateKeyFromIso(new Date().toISOString()),
          actualMinutes: actualMins
        }),
        `Gave up on session ${activeCountdown.sessionId} (${actualMins}m studied)`
      )
    );
  }

  function addSubject(title: string): void {
    if (!title.trim()) return;
    const subjectId = `subj-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`;
    const chapterId = `ch-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`;
    // Add the subject
    setDeviceState((current) => {
      let next = withOperation(
        current,
        (base) => ({
          ...base,
          opId: randomId("subject-add"),
          kind: "subject.add" as const,
          subjectId,
          title: title.trim()
        }),
        `Added subject "${title.trim()}"`
      );
      // Also add a default chapter "General"
      next = withOperation(
        next,
        (base) => ({
          ...base,
          opId: randomId("chapter-add"),
          kind: "chapter.add" as const,
          chapterId,
          subjectId,
          title: "General"
        }),
        `Added default chapter for "${title.trim()}"`
      );
      return next;
    });
    setAddSubjectName("");
  }

  async function resetServer(): Promise<void> {
    await fetch(`${SERVER_BASE_URL}/debug/reset`, { method: "POST" });
    setDeviceState((current) =>
      appendLog(
        {
          ...current,
          knownServerVersion: 0,
          serverOperations: [],
          pendingOperations: [],
          lastSentBatch: [],
          automation: { outbox: [], mockNotifications: [] }
        },
        "Server reset requested"
      )
    );
  }

  const navItems: { key: AppView; icon: string; label: string }[] = [
    { key: "dashboard", icon: "🎛️", label: "Dashboard" },
    { key: "timer", icon: "⏱️", label: "Focus Timer" },
    { key: "syllabus", icon: "📚", label: "Syllabus" },
    { key: "rewards", icon: "⭐", label: "Rewards" },
  ];

  const styles = createStyles(colors);

  // ──────── Render helpers ────────

  function renderDashboard() {
    // Flatten all tasks across all subjects for dashboard tiles (limit 8)
    const allTasks: { task: any; subject: any; chapter: any; subjectIdx: number }[] = [];
    projection.syllabus.forEach((subject, sIdx) => {
      subject.chapters.forEach((chapter) => {
        chapter.tasks.forEach((task) => {
          allTasks.push({ task, subject, chapter, subjectIdx: sIdx });
        });
      });
    });
    const dashboardTasks = allTasks.slice(0, 8);

    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.welcomeText}>Welcome back, Alex!</Text>
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>
                ☁️ Ready to learn • Sync {canSync ? "successful" : "offline"}
              </Text>
            </View>
          </View>
          <View style={styles.headerStats}>
            <Pressable 
              style={[styles.headerStatBadge, { paddingHorizontal: 12 }]} 
              onPress={toggleTheme}
            >
              <Text style={{ fontSize: 20 }}>{mode === "light" ? "🌙" : "☀️"}</Text>
            </Pressable>
            <View style={styles.headerStatBadge}>
              <Text style={styles.headerStatEmoji}>🔥</Text>
              <View>
                <Text style={styles.headerStatLabel}>DAY STREAK</Text>
                <Text style={styles.headerStatValue}>{projection.focus.streakDays}</Text>
              </View>
            </View>
            <View style={styles.headerStatBadge}>
              <Text style={styles.headerStatEmoji}>🪙</Text>
              <View>
                <Text style={styles.headerStatLabel}>COINS</Text>
                <Text style={styles.headerStatValue}>{projection.focus.coins}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.columns}>
          {/* Main Focus Area */}
          <View style={[styles.card, styles.mainColumn]}>
            <View style={styles.timerContainer}>
              {!activeCountdown ? (
                <View style={styles.newSessionContainer}>
                  <Text style={styles.focusQuestion}>What are we focusing on?</Text>
                  <Text style={styles.bigTimerText}>
                    {selectedMinutes}:00
                  </Text>
                  <View style={styles.durationRow}>
                    {[15, 25, 45].map((minutes) => (
                      <Pressable
                        key={minutes}
                        style={[
                          styles.durationChip,
                          selectedMinutes === minutes && !showCustomInput && styles.durationChipActive
                        ]}
                        onPress={() => {
                          setSelectedMinutes(minutes);
                          setShowCustomInput(false);
                          setCustomError("");
                        }}
                      >
                        <Text
                          style={[
                          styles.durationText,
                          selectedMinutes === minutes && !showCustomInput && styles.durationTextActive
                          ]}
                        >
                          {minutes}m
                        </Text>
                      </Pressable>
                    ))}
                    
                    {showCustomInput ? (
                      <TextInput
                        style={[styles.durationChip, styles.customInput]}
                        value={customMinutesStr}
                        onChangeText={(text) => {
                          setCustomMinutesStr(text);
                          setCustomError("");
                          const parsed = parseInt(text, 10);
                          if (!isNaN(parsed) && parsed > 0) {
                            setSelectedMinutes(parsed);
                          }
                        }}
                        keyboardType="number-pad"
                        placeholder="Min"
                        placeholderTextColor={colors.textMuted}
                        autoFocus
                      />
                    ) : (
                      <Pressable
                        style={[
                          styles.durationChip,
                          ![15, 25, 45].includes(selectedMinutes) && styles.durationChipActive
                        ]}
                        onPress={() => {
                          setShowCustomInput(true);
                          setCustomError("");
                        }}
                      >
                        <Text
                          style={[
                            styles.durationText,
                            ![15, 25, 45].includes(selectedMinutes) && styles.durationTextActive
                          ]}
                        >
                          Custom
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {customError ? (
                    <Text style={styles.errorText}>{customError}</Text>
                  ) : null}
                  <Pressable style={styles.buttonPrimary} onPress={startFocusSession}>
                    <Text style={styles.buttonTextPrimary}>▷ Start Focus</Text>
                  </Pressable>
                </View>
              ) : (
                <FocusTimer 
                  secondsLeft={activeCountdown.secondsLeft}
                  minutesTarget={activeCountdown.minutesTarget}
                  sessionId={activeCountdown.sessionId}
                  onGiveUp={giveUp}
                />
              )}
            </View>
          </View>

          {/* Right Column Stats & Rewards */}
          <View style={styles.sideColumn}>
            <View style={styles.card}>
              <Text style={styles.smallCardTitle}>TOTAL TODAY</Text>
              <Text style={styles.totalTodayValue}>
                {Math.floor(projection.focus.todayFocusMinutes / 60)}h {projection.focus.todayFocusMinutes % 60}m
              </Text>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${Math.min(100, (projection.focus.todayFocusMinutes / 210) * 100)}%` }]} />
              </View>
              <Text style={styles.goalText}>Goal: 3h 30m</Text>
            </View>
            
            <View style={[styles.card, styles.rewardCard]}>
              <Text style={styles.smallCardTitle}>NEXT REWARD</Text>
              <View style={styles.rewardTitleRow}>
                <Text style={styles.rewardTitle}>Gaming Hour Unlock</Text>
                <Text style={styles.rewardStar}>⭐</Text>
              </View>
              <View style={styles.rewardProgressRow}>
                <Text style={styles.rewardProgressText}>{projection.focus.coins} / 500 Coins</Text>
                <Text>{projection.focus.coins >= 500 ? "🔓" : "🔒"}</Text>
              </View>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${Math.min(100, (projection.focus.coins / 500) * 100)}%`, backgroundColor: colors.accentAlt }]} />
              </View>
            </View>
          </View>
        </View>

        {/* Syllabus Preview */}
        <View style={styles.card}>
          <View style={styles.syllabusHeaderRow}>
            <Text style={styles.cardTitle}>Up Next</Text>
            <Pressable onPress={() => setCurrentView("syllabus")}>
              <Text style={styles.viewSyllabusText}>View Syllabus →</Text>
            </Pressable>
          </View>
          
          {dashboardTasks.map(({ task, subject, chapter, subjectIdx }) => {
            const badgeColor = getSubjectBadgeColor(subjectIdx);
            return (
              <View key={task.id} style={styles.taskRow}>
                <View style={styles.taskIconWrapper}>
                  <Text style={styles.taskIcon}>
                    {getSubjectIcon(subject.subjectId, subjectIdx)}
                  </Text>
                </View>
                <View style={styles.taskInfo}>
                  <View style={styles.taskSubjectBadgeRow}>
                    <View style={[styles.taskSubjectBadge, { backgroundColor: badgeColor.bg }]}>
                      <Text style={[styles.taskSubjectBadgeText, { color: badgeColor.text }]}>
                        {subject.title.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.taskChapterText}>Chapter {chapter.title}</Text>
                  </View>
                  <Text style={[styles.taskTitle, task.status === "done" && styles.taskTitleDone]}>{task.title}</Text>
                </View>
                <View style={styles.taskActionsSegmented}>
                  <Pressable
                    style={[
                      styles.segmentBtn,
                      styles.segmentBtnLeft,
                      task.status === "not_started" && styles.segmentBtnActive
                    ]}
                    onPress={() => setTaskStatus(task.id, "not_started")}
                  >
                    <Text style={[styles.segmentBtnText, task.status === "not_started" && styles.segmentBtnTextActive]}>To Do</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.segmentBtn,
                      task.status === "in_progress" && styles.segmentBtnActive
                    ]}
                    onPress={() => setTaskStatus(task.id, "in_progress")}
                  >
                    <Text style={[styles.segmentBtnText, task.status === "in_progress" && styles.segmentBtnTextActive]}>Doing</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.segmentBtn,
                      styles.segmentBtnRight,
                      task.status === "done" && styles.segmentBtnActive
                    ]}
                    onPress={() => setTaskStatus(task.id, "done")}
                  >
                    <Text style={[styles.segmentBtnText, task.status === "done" && styles.segmentBtnTextActive]}>Done</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
          {allTasks.length > 8 && (
            <Pressable style={styles.showMoreBtn} onPress={() => setCurrentView("syllabus")}>
              <Text style={styles.showMoreText}>+{allTasks.length - 8} more tasks → View Syllabus</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderFocusTimer() {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.headerRow}>
          <Text style={styles.pageTitle}>Focus Timer</Text>
          <View style={styles.headerStats}>
            <Pressable 
              style={[styles.headerStatBadge, { paddingHorizontal: 12 }]} 
              onPress={toggleTheme}
            >
              <Text style={{ fontSize: 20 }}>{mode === "light" ? "🌙" : "☀️"}</Text>
            </Pressable>
          </View>
        </View>
        <View style={[styles.card, { alignItems: "center" }]}>
          <View style={styles.timerContainer}>
            {!activeCountdown ? (
              <View style={styles.newSessionContainer}>
                <Text style={styles.focusQuestion}>Ready to study?</Text>
                <Text style={styles.bigTimerText}>
                  {selectedMinutes}:00
                </Text>
                <View style={styles.durationRow}>
                  {[15, 25, 45].map((minutes) => (
                    <Pressable
                      key={minutes}
                      style={[
                        styles.durationChip,
                        selectedMinutes === minutes && !showCustomInput && styles.durationChipActive
                      ]}
                      onPress={() => {
                        setSelectedMinutes(minutes);
                        setShowCustomInput(false);
                        setCustomError("");
                      }}
                    >
                      <Text
                        style={[
                          styles.durationText,
                          selectedMinutes === minutes && !showCustomInput && styles.durationTextActive
                        ]}
                      >
                        {minutes}m
                      </Text>
                    </Pressable>
                  ))}
                  {showCustomInput ? (
                    <TextInput
                      style={[styles.durationChip, styles.customInput]}
                      value={customMinutesStr}
                      onChangeText={(text) => {
                        setCustomMinutesStr(text);
                        setCustomError("");
                        const parsed = parseInt(text, 10);
                        if (!isNaN(parsed) && parsed > 0) {
                          setSelectedMinutes(parsed);
                        }
                      }}
                      keyboardType="number-pad"
                      placeholder="Min"
                      placeholderTextColor={colors.textMuted}
                      autoFocus
                    />
                  ) : (
                    <Pressable
                      style={[
                        styles.durationChip,
                        ![15, 25, 45].includes(selectedMinutes) && styles.durationChipActive
                      ]}
                      onPress={() => {
                        setShowCustomInput(true);
                        setCustomError("");
                      }}
                    >
                      <Text
                        style={[
                          styles.durationText,
                          ![15, 25, 45].includes(selectedMinutes) && styles.durationTextActive
                        ]}
                      >
                        Custom
                      </Text>
                    </Pressable>
                  )}
                </View>
                {customError ? (
                  <Text style={styles.errorText}>{customError}</Text>
                ) : null}
                <Pressable style={styles.buttonPrimary} onPress={startFocusSession}>
                  <Text style={styles.buttonTextPrimary}>▷ Start Focus</Text>
                </Pressable>
              </View>
            ) : (
              <FocusTimer 
                secondsLeft={activeCountdown.secondsLeft}
                minutesTarget={activeCountdown.minutesTarget}
                sessionId={activeCountdown.sessionId}
                onGiveUp={giveUp}
              />
            )}
          </View>
        </View>

        {/* Today stats */}
        <View style={styles.card}>
          <Text style={styles.smallCardTitle}>TOTAL TODAY</Text>
          <Text style={styles.totalTodayValue}>
            {Math.floor(projection.focus.todayFocusMinutes / 60)}h {projection.focus.todayFocusMinutes % 60}m
          </Text>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${Math.min(100, (projection.focus.todayFocusMinutes / 210) * 100)}%` }]} />
          </View>
          <Text style={styles.goalText}>Goal: 3h 30m</Text>
        </View>
      </ScrollView>
    );
  }

  function renderSyllabus() {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.headerRow}>
          <Text style={styles.pageTitle}>Syllabus</Text>
          <View style={styles.headerStats}>
            <Pressable 
              style={[styles.headerStatBadge, { paddingHorizontal: 12 }]} 
              onPress={toggleTheme}
            >
              <Text style={{ fontSize: 20 }}>{mode === "light" ? "🌙" : "☀️"}</Text>
            </Pressable>
          </View>
        </View>

        {/* Add Subject Form */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Add New Subject</Text>
          <View style={styles.addSubjectRow}>
            <TextInput
              style={styles.addSubjectInput}
              value={addSubjectName}
              onChangeText={setAddSubjectName}
              placeholder="Enter subject name (e.g. English, History)"
              placeholderTextColor={colors.textMuted}
            />
            <Pressable
              style={[styles.addSubjectBtn, !addSubjectName.trim() && styles.addSubjectBtnDisabled]}
              onPress={() => addSubject(addSubjectName)}
            >
              <Text style={styles.addSubjectBtnText}>+ Add</Text>
            </Pressable>
          </View>
        </View>

        {/* Full subjects listing */}
        {projection.syllabus.map((subject, sIdx) => (
          <View key={subject.subjectId} style={styles.card}>
            <View style={styles.syllabusSubjectHeader}>
              <Text style={styles.syllabusSubjectIcon}>{getSubjectIcon(subject.subjectId, sIdx)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{subject.title}</Text>
                <Text style={styles.syllabusSubjectMeta}>
                  {subject.doneTasks}/{subject.totalTasks} tasks done • {subject.progressPercent}%
                </Text>
              </View>
              <View style={styles.syllabusProgressCircle}>
                <Text style={styles.syllabusProgressText}>{subject.progressPercent}%</Text>
              </View>
            </View>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${subject.progressPercent}%` }]} />
            </View>

            {subject.chapters.map((chapter) => (
              <View key={chapter.chapterId} style={styles.chapterBlock}>
                <Text style={styles.chapterTitle}>📖 {chapter.title}</Text>
                {chapter.tasks.map((task) => {
                  const badgeColor = getSubjectBadgeColor(sIdx);
                  return (
                    <View key={task.id} style={styles.taskRow}>
                      <View style={styles.taskInfo}>
                        <Text style={[styles.taskTitle, task.status === "done" && styles.taskTitleDone]}>{task.title}</Text>
                      </View>
                      <View style={styles.taskActionsSegmented}>
                        <Pressable
                          style={[styles.segmentBtn, styles.segmentBtnLeft, task.status === "not_started" && styles.segmentBtnActive]}
                          onPress={() => setTaskStatus(task.id, "not_started")}
                        >
                          <Text style={[styles.segmentBtnText, task.status === "not_started" && styles.segmentBtnTextActive]}>To Do</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.segmentBtn, task.status === "in_progress" && styles.segmentBtnActive]}
                          onPress={() => setTaskStatus(task.id, "in_progress")}
                        >
                          <Text style={[styles.segmentBtnText, task.status === "in_progress" && styles.segmentBtnTextActive]}>Doing</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.segmentBtn, styles.segmentBtnRight, task.status === "done" && styles.segmentBtnActive]}
                          onPress={() => setTaskStatus(task.id, "done")}
                        >
                          <Text style={[styles.segmentBtnText, task.status === "done" && styles.segmentBtnTextActive]}>Done</Text>
                        </Pressable>
                      </View>
                      <Pressable
                        style={styles.deleteBtn}
                        onPress={() => deleteTask(task.id)}
                      >
                        <Text style={styles.deleteBtnText}>🗑️</Text>
                      </Pressable>
                    </View>
                  );
                })}
                {chapter.tasks.length === 0 && (
                  <Text style={styles.emptyChapterText}>No tasks yet in this chapter</Text>
                )}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    );
  }

  function renderRewards() {
    const rewardTiers = [
      { name: "Gaming Hour Unlock", cost: 500, icon: "🎮" },
      { name: "Movie Night Pass", cost: 1000, icon: "🎬" },
      { name: "Pizza Party", cost: 2000, icon: "🍕" },
      { name: "Gadget Fund +₹500", cost: 5000, icon: "📱" },
    ];
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.headerRow}>
          <Text style={styles.pageTitle}>Rewards</Text>
          <View style={styles.headerStats}>
            <Pressable 
              style={[styles.headerStatBadge, { paddingHorizontal: 12 }]} 
              onPress={toggleTheme}
            >
              <Text style={{ fontSize: 20 }}>{mode === "light" ? "🌙" : "☀️"}</Text>
            </Pressable>
          </View>
        </View>

        {/* Stats row */}
        <View style={styles.rewardsStatsRow}>
          <View style={[styles.card, styles.rewardsStatCard]}>
            <Text style={styles.rewardsStatEmoji}>🔥</Text>
            <Text style={styles.rewardsStatValue}>{projection.focus.streakDays}</Text>
            <Text style={styles.rewardsStatLabel}>Day Streak</Text>
          </View>
          <View style={[styles.card, styles.rewardsStatCard]}>
            <Text style={styles.rewardsStatEmoji}>🪙</Text>
            <Text style={styles.rewardsStatValue}>{projection.focus.coins}</Text>
            <Text style={styles.rewardsStatLabel}>Total Coins</Text>
          </View>
          <View style={[styles.card, styles.rewardsStatCard]}>
            <Text style={styles.rewardsStatEmoji}>✅</Text>
            <Text style={styles.rewardsStatValue}>{projection.focus.successCount}</Text>
            <Text style={styles.rewardsStatLabel}>Sessions Done</Text>
          </View>
          <View style={[styles.card, styles.rewardsStatCard]}>
            <Text style={styles.rewardsStatEmoji}>⏰</Text>
            <Text style={styles.rewardsStatValue}>{projection.focus.todayFocusMinutes}m</Text>
            <Text style={styles.rewardsStatLabel}>Today</Text>
          </View>
        </View>

        {/* Reward tiers */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Reward Shop</Text>
          {rewardTiers.map((reward) => {
            const progress = Math.min(100, (projection.focus.coins / reward.cost) * 100);
            const unlocked = projection.focus.coins >= reward.cost;
            return (
              <View key={reward.name} style={styles.rewardTierRow}>
                <Text style={styles.rewardTierIcon}>{reward.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rewardTierName}>{reward.name}</Text>
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${progress}%`, backgroundColor: unlocked ? colors.success : colors.accentAlt }]} />
                  </View>
                  <Text style={styles.rewardTierCost}>
                    {projection.focus.coins} / {reward.cost} coins
                  </Text>
                </View>
                <Text style={{ fontSize: 20 }}>{unlocked ? "🔓" : "🔒"}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  function renderSettings() {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.pageTitle}>Settings</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Appearance</Text>
          <Text style={styles.settingsLabel}>Theme Mode</Text>
          <View style={styles.themeDropdown}>
            <Pressable
              style={[styles.themeOption, mode === "light" && styles.themeOptionActive]}
              onPress={() => setThemeMode("light")}
            >
              <Text style={[styles.themeOptionText, mode === "light" && styles.themeOptionTextActive]}>
                ☀️ Light Mode
              </Text>
            </Pressable>
            <Pressable
              style={[styles.themeOption, mode === "dark" && styles.themeOptionActive]}
              onPress={() => setThemeMode("dark")}
            >
              <Text style={[styles.themeOptionText, mode === "dark" && styles.themeOptionTextActive]}>
                🌙 Dark Mode
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Account</Text>
          <View style={styles.settingsInfoRow}>
            <Text style={styles.settingsInfoLabel}>Student ID</Text>
            <Text style={styles.settingsInfoValue}>{STUDENT_ID}</Text>
          </View>
          <View style={styles.settingsInfoRow}>
            <Text style={styles.settingsInfoLabel}>Device</Text>
            <Text style={styles.settingsInfoValue}>{deviceState.deviceId}</Text>
          </View>
          <View style={styles.settingsInfoRow}>
            <Text style={styles.settingsInfoLabel}>Sync Status</Text>
            <Text style={[styles.settingsInfoValue, { color: canSync ? colors.success : colors.danger }]}>
              {canSync ? "Online" : "Offline"}
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderDevTools() {
    const outbox = deviceState.automation.outbox;
    const mockNotifs = deviceState.automation.mockNotifications;
    const deliveredCount = outbox.filter((e) => e.delivered).length;
    const pendingCount = outbox.length - deliveredCount;

    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.devContainer}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Device controls</Text>
            <Text style={styles.bodyText}>Device {deviceState.deviceId}</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.btn, canSync ? styles.btnSuccess : styles.btnWarning]}
                onPress={() => setDeviceState((c) => appendLog({ ...c, online: !c.online }, "Toggled network"))}
              >
                <Text style={styles.btnText}>{deviceState.online ? "Go offline" : "Go online"}</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={() => void syncWithServer()}>
                <Text style={styles.btnText}>Sync now</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={() => void resetServer()}>
                <Text style={styles.btnText}>Reset server</Text>
              </Pressable>
            </View>
            <View style={styles.row}>
              <Pressable
                style={[styles.btn, deviceState.lastSentBatch.length === 0 && { opacity: 0.4 }]}
                onPress={() => void replayLastBatch()}
              >
                <Text style={styles.btnText}>Replay last batch ({deviceState.lastSentBatch.length} ops)</Text>
              </Pressable>
            </View>
            <Text style={styles.metaText}>Pending ops: {deviceState.pendingOperations.length}</Text>
          </View>

          {/* Automation Visibility Panel */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>📡 Automation Panel</Text>
            <Text style={styles.bodyText}>
              This panel shows exactly-once automation state so a reviewer can verify dedupe and delivery behavior.
            </Text>

            {/* Summary badges */}
            <View style={styles.automationSummaryRow}>
              <View style={styles.automationBadge}>
                <Text style={styles.automationBadgeValue}>{outbox.length}</Text>
                <Text style={styles.automationBadgeLabel}>Outbox Events</Text>
              </View>
              <View style={[styles.automationBadge, { borderColor: colors.success }]}>
                <Text style={[styles.automationBadgeValue, { color: colors.success }]}>{deliveredCount}</Text>
                <Text style={styles.automationBadgeLabel}>Delivered</Text>
              </View>
              <View style={[styles.automationBadge, { borderColor: colors.warning }]}>
                <Text style={[styles.automationBadgeValue, { color: colors.warning }]}>{pendingCount}</Text>
                <Text style={styles.automationBadgeLabel}>Pending</Text>
              </View>
              <View style={[styles.automationBadge, { borderColor: colors.accentAlt }]}>
                <Text style={[styles.automationBadgeValue, { color: colors.accentAlt }]}>{mockNotifs.length}</Text>
                <Text style={styles.automationBadgeLabel}>Mock Notifs</Text>
              </View>
            </View>

            {/* Outbox events */}
            {outbox.length > 0 && (
              <View style={styles.automationSection}>
                <Text style={styles.automationSectionTitle}>Outbox Events</Text>
                {outbox.map((event, idx) => (
                  <View key={event.eventId ?? idx} style={styles.automationEventRow}>
                    <View style={[styles.automationStatusDot, { backgroundColor: event.delivered ? colors.success : colors.warning }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.automationEventId}>{event.eventId}</Text>
                      <Text style={styles.automationEventMeta}>
                        {event.delivered
                          ? `✅ Delivered${event.deliveredAt ? " at " + new Date(event.deliveredAt).toLocaleTimeString() : ""}`
                          : `⏳ Pending${event.lastError ? " — " + event.lastError : ""}`}
                      </Text>
                      <Text style={styles.automationEventMeta}>
                        Session: {event.sessionId} • Coins: {event.payload.coinsAwarded} • Streak: {event.payload.streakDays}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Mock notification deliveries */}
            {mockNotifs.length > 0 && (
              <View style={styles.automationSection}>
                <Text style={styles.automationSectionTitle}>Mock Notification Deliveries</Text>
                {mockNotifs.map((notif, idx) => (
                  <View key={idx} style={styles.automationEventRow}>
                    <View style={[styles.automationStatusDot, { backgroundColor: colors.accentAlt }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.automationEventId}>Received at {new Date(notif.receivedAt).toLocaleTimeString()}</Text>
                      <Text style={styles.automationEventMeta}>
                        {JSON.stringify(notif.payload, null, 0).slice(0, 120)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {outbox.length === 0 && mockNotifs.length === 0 && (
              <Text style={[styles.bodyText, { marginTop: 12, fontStyle: "italic" }]}>
                No automation events yet. Complete a focus session to trigger outbox and notification events.
              </Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Logs</Text>
            {deviceState.logs.slice(0, 10).map((line, idx) => (
              <Text key={idx} style={styles.logLine}>{line}</Text>
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderMainContent() {
    if (showDevTools) return renderDevTools();
    switch (currentView) {
      case "dashboard": return renderDashboard();
      case "timer": return renderFocusTimer();
      case "syllabus": return renderSyllabus();
      case "rewards": return renderRewards();
      case "settings": return renderSettings();
      default: return renderDashboard();
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.layout}>
        {/* Sidebar */}
        <View style={styles.sidebar}>
          <View style={styles.sidebarHeader}>
            <Text style={styles.sidebarLogo}>Alcovia</Text>
            <Text style={styles.sidebarSubtitle}>Student Portal</Text>
          </View>

          <View style={styles.sidebarNav}>
            {navItems.map((item) => (
              <Pressable
                key={item.key}
                style={[styles.navItem, currentView === item.key && !showDevTools && styles.navItemActive]}
                onPress={() => { setCurrentView(item.key); setShowDevTools(false); }}
              >
                <Text style={styles.navItemIcon}>{item.icon}</Text>
                <Text style={currentView === item.key && !showDevTools ? styles.navItemTextActive : styles.navItemText}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.sidebarBottom}>
            <Pressable style={styles.startStudyingBtn} onPress={() => { setCurrentView("timer"); setShowDevTools(false); }}>
              <Text style={styles.startStudyingBtnText}>Start Studying</Text>
            </Pressable>
            <Pressable 
              style={styles.devToggle} 
              onPress={() => setShowDevTools(!showDevTools)}
            >
              <Text style={styles.devToggleText}>
                {showDevTools ? "⚙️ Hide Dev Tools" : "⚙️ View Dev Tools"}
              </Text>
            </Pressable>
            
            <View style={styles.sidebarLinks}>
              <Pressable
                style={[styles.sidebarLink, currentView === "settings" && !showDevTools && styles.navItemActive]}
                onPress={() => { setCurrentView("settings"); setShowDevTools(false); }}
              >
                <Text style={styles.sidebarLinkIcon}>⚙️</Text>
                <Text style={styles.sidebarLinkText}>Settings</Text>
              </Pressable>
              <Pressable style={styles.sidebarLink}>
                <Text style={styles.sidebarLinkIcon}>❓</Text>
                <Text style={styles.sidebarLinkText}>Help</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* Main Content Area */}
        <View style={styles.mainContent}>
          {renderMainContent()}
        </View>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  layout: {
    flex: 1,
    flexDirection: "row",
  },
  sidebar: {
    width: 220,
    backgroundColor: colors.surfaceAlt,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingVertical: 24,
    paddingHorizontal: 16,
    justifyContent: "space-between",
  },
  sidebarHeader: {
    marginBottom: 28,
  },
  sidebarLogo: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.accent,
  },
  sidebarSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  sidebarNav: {
    flex: 1,
    gap: 10,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  navItemActive: {
    backgroundColor: `${colors.accent}15`,
  },
  navItemIcon: {
    fontSize: 16,
    marginRight: 10,
  },
  navItemText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  navItemTextActive: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.accent,
  },
  sidebarBottom: {
    gap: 12,
  },
  startStudyingBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  startStudyingBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },
  devToggle: {
    alignItems: "center",
    paddingVertical: 8,
  },
  devToggleText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  sidebarLinks: {
    gap: 12,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  sidebarLink: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  sidebarLinkIcon: {
    marginRight: 10,
    fontSize: 14,
  },
  sidebarLinkText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  mainContent: {
    flex: 1,
    backgroundColor: colors.background,
  },
  page: {
    padding: 18,
    gap: 14,
    width: "100%",
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.textPrimary,
    marginBottom: 6,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  welcomeText: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  statusBadge: {
    backgroundColor: `${colors.success}15`,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  statusBadgeText: {
    color: colors.success,
    fontWeight: "600",
    fontSize: 11,
  },
  headerStats: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  headerStatBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
  },
  headerStatEmoji: {
    fontSize: 16,
    marginRight: 6,
  },
  headerStatLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 2,
  },
  headerStatValue: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  columns: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
  },
  mainColumn: {
    flex: 2.5,
    minWidth: 360,
  },
  sideColumn: {
    flex: 1.5,
    minWidth: 280,
    gap: 12,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  focusQuestion: {
    fontSize: 16,
    color: colors.textSecondary,
    fontWeight: "500",
    textAlign: "center",
  },
  timerContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 20,
    minHeight: 280,
  },
  newSessionContainer: {
    alignItems: "center",
    gap: 16,
  },
  bigTimerText: {
    fontSize: 84,
    fontWeight: "800",
    color: colors.textPrimary,
    marginVertical: 8,
  },
  durationRow: {
    flexDirection: "row",
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    padding: 5,
    borderRadius: 999,
  },
  durationChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  customInput: {
    color: colors.textPrimary,
    fontWeight: "700",
    fontSize: 14,
    minWidth: 60,
    textAlign: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  durationChipActive: {
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  durationText: {
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 12,
  },
  durationTextActive: {
    color: colors.accent,
    fontWeight: "800",
  },
  errorText: {
    color: colors.danger,
    fontWeight: "600",
    fontSize: 12,
    textAlign: "center",
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 999,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    marginTop: 6,
  },
  buttonTextPrimary: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  smallCardTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
    letterSpacing: 1,
    marginBottom: 8,
  },
  totalTodayValue: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.accent,
    marginBottom: 12,
  },
  goalText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "600",
    textAlign: "right",
  },
  rewardCard: {
    backgroundColor: `${colors.accentAlt}10`,
    borderColor: `${colors.accentAlt}30`,
  },
  rewardTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  rewardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  rewardStar: {
    fontSize: 24,
  },
  rewardProgressRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  rewardProgressText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginBottom: 8,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  syllabusHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  viewSyllabusText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 14,
  },
  subjectBlock: {
    marginBottom: 8,
  },
  chapterBlock: {
    marginBottom: 8,
    marginTop: 16,
  },
  chapterTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  taskIconWrapper: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  taskIcon: {
    fontSize: 16,
  },
  taskInfo: {
    flex: 1,
    paddingRight: 12,
  },
  taskSubjectBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  taskSubjectBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  taskSubjectBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  taskChapterText: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  taskTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  taskTitleDone: {
    color: colors.textMuted,
    textDecorationLine: "line-through",
  },
  taskActionsSegmented: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 7,
    padding: 4,
  },
  segmentBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  segmentBtnLeft: {},
  segmentBtnRight: {},
  segmentBtnActive: {
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentBtnText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
  },
  segmentBtnTextActive: {
    color: colors.accent,
  },
  showMoreBtn: {
    alignItems: "center",
    paddingVertical: 16,
    marginTop: 8,
  },
  showMoreText: {
    color: colors.accent,
    fontWeight: "700",
    fontSize: 14,
  },
  // Syllabus specific
  syllabusSubjectHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 12,
  },
  syllabusSubjectIcon: {
    fontSize: 28,
  },
  syllabusSubjectMeta: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
    marginTop: 4,
  },
  syllabusProgressCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: `${colors.accent}15`,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  syllabusProgressText: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.accent,
  },
  emptyChapterText: {
    color: colors.textMuted,
    fontStyle: "italic",
    padding: 12,
    textAlign: "center",
  },
  // Add subject
  addSubjectRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
    alignItems: "center",
  },
  addSubjectInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    fontWeight: "600",
    fontSize: 13,
  },
  addSubjectBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
  },
  addSubjectBtnDisabled: {
    opacity: 0.5,
  },
  addSubjectBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 15,
  },
  // Rewards page
  rewardsStatsRow: {
    flexDirection: "row",
    gap: 16,
    flexWrap: "wrap",
  },
  rewardsStatCard: {
    flex: 1,
    minWidth: 140,
    alignItems: "center",
    paddingVertical: 18,
  },
  rewardsStatEmoji: {
    fontSize: 26,
    marginBottom: 6,
  },
  rewardsStatValue: {
    fontSize: 26,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  rewardsStatLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    marginTop: 4,
  },
  rewardTierRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rewardTierIcon: {
    fontSize: 26,
  },
  rewardTierName: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 6,
  },
  rewardTierCost: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: "600",
    marginTop: 4,
  },
  // Settings page
  settingsLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textSecondary,
    marginTop: 20,
    marginBottom: 12,
  },
  themeDropdown: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    padding: 6,
    borderRadius: 12,
  },
  themeOption: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  themeOptionActive: {
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  themeOptionText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  themeOptionTextActive: {
    color: colors.accent,
    fontWeight: "800",
  },
  settingsInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  settingsInfoLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  settingsInfoValue: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  bodyText: {
    color: colors.textPrimary,
    fontSize: 14,
  },
  devContainer: {
    gap: 16,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
    marginTop: 12,
  },
  btn: {
    backgroundColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnSuccess: {
    backgroundColor: colors.success,
  },
  btnWarning: {
    backgroundColor: colors.danger,
  },
  btnText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 12,
  },
  logLine: {
    color: colors.accent,
    fontFamily: "Courier",
    fontSize: 12,
    marginTop: 4,
  },
  // Delete button for tasks
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
    borderRadius: 8,
    backgroundColor: `${colors.danger}15`,
  },
  deleteBtnText: {
    fontSize: 16,
  },
  // Automation panel styles
  automationSummaryRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
    flexWrap: "wrap",
  },
  automationBadge: {
    flex: 1,
    minWidth: 100,
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  automationBadgeValue: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  automationBadgeLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  automationSection: {
    marginTop: 20,
  },
  automationSectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  automationEventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  automationStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  automationEventId: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
    fontFamily: "Courier",
  },
  automationEventMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
