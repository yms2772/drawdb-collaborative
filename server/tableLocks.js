import { toEntityKey } from "./protocol.js";

const DEFAULT_LEASE_MS = 12_000;

export function createTableLockManager({
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now(),
} = {}) {
  const locksByDiagram = new Map();
  let fencingToken = 0;

  const locksFor = (diagramId) => {
    if (!locksByDiagram.has(diagramId)) {
      locksByDiagram.set(diagramId, new Map());
    }
    return locksByDiagram.get(diagramId);
  };

  const removeExpired = (diagramId) => {
    const locks = locksByDiagram.get(diagramId);
    if (!locks) return false;
    let changed = false;
    const currentTime = now();
    for (const [tableId, lock] of locks) {
      if (lock.expiresAt <= currentTime) {
        locks.delete(tableId);
        changed = true;
      }
    }
    if (locks.size === 0) locksByDiagram.delete(diagramId);
    return changed;
  };

  const list = (diagramId) => {
    removeExpired(diagramId);
    return [...(locksByDiagram.get(diagramId)?.values() ?? [])];
  };

  return {
    leaseMs,
    list,
    acquire(diagramId, tableId, participant) {
      removeExpired(diagramId);
      const key = toEntityKey(tableId);
      const locks = locksFor(diagramId);
      const existing = locks.get(key);
      if (existing && existing.clientId !== participant.clientId) {
        return { granted: false, lock: existing };
      }
      const lock = {
        tableId: key,
        clientId: participant.clientId,
        displayName: participant.displayName,
        color: participant.color,
        token: existing?.token ?? ++fencingToken,
        expiresAt: now() + leaseMs,
      };
      locks.set(key, lock);
      return { granted: true, lock };
    },
    renew(diagramId, tableId, clientId, token) {
      removeExpired(diagramId);
      const lock = locksByDiagram.get(diagramId)?.get(toEntityKey(tableId));
      if (!lock || lock.clientId !== clientId || lock.token !== token) {
        return false;
      }
      lock.expiresAt = now() + leaseMs;
      return true;
    },
    release(diagramId, tableId, clientId, token) {
      const key = toEntityKey(tableId);
      const locks = locksByDiagram.get(diagramId);
      const lock = locks?.get(key);
      if (!lock || lock.clientId !== clientId || lock.token !== token) {
        return false;
      }
      locks.delete(key);
      if (locks.size === 0) locksByDiagram.delete(diagramId);
      return true;
    },
    releaseClient(diagramId, clientId) {
      const locks = locksByDiagram.get(diagramId);
      if (!locks) return false;
      let changed = false;
      for (const [tableId, lock] of locks) {
        if (lock.clientId === clientId) {
          locks.delete(tableId);
          changed = true;
        }
      }
      if (locks.size === 0) locksByDiagram.delete(diagramId);
      return changed;
    },
    owns(diagramId, tableId, clientId) {
      removeExpired(diagramId);
      return (
        locksByDiagram.get(diagramId)?.get(toEntityKey(tableId))?.clientId ===
        clientId
      );
    },
    sweep() {
      const changedDiagrams = [];
      for (const diagramId of locksByDiagram.keys()) {
        if (removeExpired(diagramId)) changedDiagrams.push(diagramId);
      }
      return changedDiagrams;
    },
  };
}
