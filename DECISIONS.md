# Architectural and Design Decisions

This document outlines the core architectural patterns and design decisions implemented in the Alcovia Offline-First Study App.

## 1. Offline-First Architecture and Lamport Clocks
* **Durable Local State:** The frontend operates on namespaced local state stored in `localStorage` (`phone` vs `laptop`).
* **Operation Log:** Rather than updating states immediately in a mutable database structure, every user action creates a durable operation containing an `opId`, `deviceId`, a Lamport-style `counter`, and the `baseVersion` (the server version the client last saw).
* **Derived Projections:** Both client and server calculate the current state (subjects, tasks, streak, coins, focus minutes) by processing the sequence of operations. This makes local execution fast and client-server synchronization deterministic.

## 2. Synchronization and Conflict Resolution
We deliberately avoid wall-clock Last-Write-Wins (LWW) since student clocks can be out of sync.
* **Higher Shared Base Version:** Operations created from a more recent server state (`baseVersion`) override older ones.
* **Concurrent Edits (Completion Bias):** If two concurrent edits are made, the status with the most progress wins (`done > in_progress > not_started`). This ensures students do not lose completed tasks.
* **Tombstoning (Delete Wins):** If a task is concurrently edited on one device and deleted on another, the delete operation always wins. This prevents "ghost" tasks from reappearing.

## 3. Idempotent Automation and Exactly-Once Delivery
* **Unique Session Deduping:** Rewards and streaking counts are projected based on unique `sessionId` values. Retries or replayed batches cannot award duplicate coins or double-increment streaks.
* **Stable Event ID:** Webhook events are emitted with a stable identifier: `focus-success:<sessionId>`.
* **Workflow Deduplication:** The `n8n` workflow acts as an idempotent delivery mechanism, tracking seen event IDs to ensure each successful focus session triggers exactly one mock notification delivery.

## Tradeoff

I chose a simple deterministic merge strategy rather than implementing
a full CRDT.

Benefits:
- Easier reasoning
- Smaller implementation
- Easier debugging

Drawback:
- Some user intent may be lost in complex concurrent edits.
