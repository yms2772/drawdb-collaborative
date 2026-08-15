import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { nanoid } from "nanoid";
import { CONNECTION_STATE, MESSAGE_TYPES } from "../collaboration/protocol";

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];

// Table IDs are numbers on imported diagrams and strings on new ones. The lock
// bookkeeping below uses Maps, where 1 and "1" are different keys, so every ID
// is normalized on the way in.
const lockKey = (tableId) => String(tableId);

function getIdentity() {
  const stored = sessionStorage.getItem("drawdb-collaboration-identity");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      sessionStorage.removeItem("drawdb-collaboration-identity");
    }
  }
  const suffix = Math.floor(Math.random() * 900 + 100);
  const identity = {
    clientId: nanoid(),
    displayName: `Guest ${suffix}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  sessionStorage.setItem(
    "drawdb-collaboration-identity",
    JSON.stringify(identity),
  );
  return identity;
}

export const CollabContext = createContext(null);

export default function CollabContextProvider({ children }) {
  const identityRef = useRef(getIdentity());
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const sessionRef = useRef(null);
  const pendingRef = useRef(new Map());
  const versionRef = useRef(0);
  const isApplyingRemoteRef = useRef(false);
  const cursorSentAtRef = useRef(0);
  const previewThrottleRef = useRef(new Map());
  const pendingLocksRef = useRef(new Map());
  const pendingLocksByTableRef = useRef(new Map());
  const heldLocksRef = useRef(new Map());
  const retainedLocksRef = useRef(new Map());
  const [connectionState, setConnectionState] = useState(
    CONNECTION_STATE.DISCONNECTED,
  );
  const [participants, setParticipants] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [tableLocks, setTableLocks] = useState({});

  const handleMessage = useCallback((event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === MESSAGE_TYPES.JOINED) {
      versionRef.current = message.version;
      setConnectionState(CONNECTION_STATE.CONNECTED);
      reconnectAttemptsRef.current = 0;
      return;
    }
    if (
      message.type === MESSAGE_TYPES.SNAPSHOT ||
      message.type === MESSAGE_TYPES.RESYNC_REQUIRED
    ) {
      versionRef.current = message.version;
      sessionRef.current?.onSnapshot?.(message);
      if (message.type === MESSAGE_TYPES.RESYNC_REQUIRED) {
        for (const pending of pendingRef.current.values())
          pending.reject(message);
        pendingRef.current.clear();
      }
      return;
    }
    if (message.type === MESSAGE_TYPES.OPERATION_APPLIED) {
      versionRef.current = message.version;
      const pending = pendingRef.current.get(message.operationId);
      if (pending) {
        pending.resolve(message);
        pendingRef.current.delete(message.operationId);
      } else if (
        message.clientId !== identityRef.current.clientId &&
        message.operation?.payload
      ) {
        sessionRef.current?.onSnapshot?.({
          ...message.operation.payload,
          version: message.version,
        });
      }
      return;
    }
    if (message.type === MESSAGE_TYPES.ERROR) {
      // Every server rejection used to be parsed and dropped, so a denied lock
      // or a rejected operation looked identical to success.
      console.warn("collaboration error:", message.message);
      sessionRef.current?.onError?.(message.message);
      return;
    }
    if (message.type === MESSAGE_TYPES.PRESENCE) {
      const participants = message.participants || [];
      setParticipants(participants);
      // Cursors were only ever added, never removed, so the map grew for the
      // lifetime of the session.
      const present = new Set(participants.map((item) => item.clientId));
      setRemoteCursors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([clientId]) => present.has(clientId)),
        ),
      );
      return;
    }
    if (message.type === MESSAGE_TYPES.TABLE_LOCK_STATE) {
      const nextLocks = Object.fromEntries(
        (message.locks || []).map((lock) => [lock.tableId, lock]),
      );
      setTableLocks(nextLocks);
      for (const [tableId, held] of heldLocksRef.current) {
        const current = nextLocks[tableId];
        if (
          !current ||
          current.clientId !== identityRef.current.clientId ||
          current.token !== held.token
        ) {
          heldLocksRef.current.delete(tableId);
        }
      }
      return;
    }
    if (
      message.type === MESSAGE_TYPES.TABLE_LOCK_GRANTED ||
      message.type === MESSAGE_TYPES.TABLE_LOCK_DENIED
    ) {
      const pending = pendingLocksRef.current.get(message.requestId);
      if (!pending) return;
      pendingLocksRef.current.delete(message.requestId);
      pendingLocksByTableRef.current.delete(pending.tableId);
      if (message.type === MESSAGE_TYPES.TABLE_LOCK_GRANTED) {
        heldLocksRef.current.set(pending.tableId, message.lock);
        pending.resolve(true);
      } else {
        pending.resolve(false);
      }
      return;
    }
    if (
      message.type === MESSAGE_TYPES.OPERATION_PREVIEW &&
      message.clientId !== identityRef.current.clientId
    ) {
      sessionRef.current?.onDelta?.(message.operation);
      return;
    }
    if (message.type === MESSAGE_TYPES.CURSOR) {
      setRemoteCursors((current) => ({
        ...current,
        [message.clientId]: {
          x: message.x,
          y: message.y,
          selected: message.selected,
        },
      }));
    }
  }, []);

  const openSocket = useCallback(
    (session) => {
      if (!session || socketRef.current?.readyState === WebSocket.OPEN) return;
      setConnectionState(CONNECTION_STATE.CONNECTING);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${scheme}//${window.location.host}/ws/diagrams/${encodeURIComponent(session.diagramId)}`,
      );
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: MESSAGE_TYPES.JOIN,
            diagramId: session.diagramId,
            participant: identityRef.current,
            lastVersion: versionRef.current,
          }),
        );
      };
      socket.onmessage = handleMessage;
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        // Leases do not survive the connection. Without this the client keeps
        // believing it holds locks the server has already reassigned, and
        // acquireTableLock short-circuits on those stale entries forever.
        heldLocksRef.current.clear();
        pendingLocksByTableRef.current.clear();
        for (const pending of pendingLocksRef.current.values()) {
          pending.resolve(false);
        }
        pendingLocksRef.current.clear();
        setTableLocks({});
        setConnectionState(CONNECTION_STATE.CONNECTING);
        const delay = Math.min(
          1000 * 2 ** reconnectAttemptsRef.current,
          15_000,
        );
        reconnectAttemptsRef.current += 1;
        reconnectRef.current = window.setTimeout(
          () => openSocket(sessionRef.current),
          delay,
        );
      };
      socket.onerror = () => socket.close();
    },
    [handleMessage],
  );

  const connect = useCallback(
    ({ diagramId, version, onSnapshot, onDelta, onError }) => {
      if (sessionRef.current?.diagramId === diagramId) {
        sessionRef.current.onSnapshot = onSnapshot;
        sessionRef.current.onDelta = onDelta;
        sessionRef.current.onError = onError;
        versionRef.current = version;
        return;
      }
      window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      sessionRef.current = { diagramId, onSnapshot, onDelta, onError };
      versionRef.current = version;
      setRemoteCursors({});
      setTableLocks({});
      openSocket(sessionRef.current);
    },
    [openSocket],
  );

  const disconnect = useCallback(() => {
    sessionRef.current = null;
    window.clearTimeout(reconnectRef.current);
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    setConnectionState(CONNECTION_STATE.DISCONNECTED);
    setParticipants([]);
    setRemoteCursors({});
    setTableLocks({});
    for (const preview of previewThrottleRef.current.values()) {
      window.clearTimeout(preview.timer);
    }
    previewThrottleRef.current.clear();
    for (const pending of pendingLocksRef.current.values()) {
      pending.resolve(false);
    }
    pendingLocksRef.current.clear();
    pendingLocksByTableRef.current.clear();
    heldLocksRef.current.clear();
    retainedLocksRef.current.clear();
  }, []);

  const sendSnapshot = useCallback((name, document) => {
    const socket = socketRef.current;
    const session = sessionRef.current;
    if (!session || socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Collaboration connection is unavailable"),
      );
    }
    const operationId = nanoid();
    return new Promise((resolve, reject) => {
      pendingRef.current.set(operationId, { resolve, reject });
      socket.send(
        JSON.stringify({
          type: MESSAGE_TYPES.OPERATION,
          diagramId: session.diagramId,
          clientId: identityRef.current.clientId,
          operationId,
          baseVersion: versionRef.current,
          operation: { type: "snapshot.replace", payload: { name, document } },
        }),
      );
      window.setTimeout(() => {
        if (!pendingRef.current.has(operationId)) return;
        pendingRef.current.delete(operationId);
        reject(new Error("Save acknowledgement timed out"));
      }, 10_000);
    });
  }, []);

  const emitAwareness = useCallback((awareness) => {
    const now = Date.now();
    if (now - cursorSentAtRef.current < 50) return;
    const socket = socketRef.current;
    const session = sessionRef.current;
    if (!session || socket?.readyState !== WebSocket.OPEN) return;
    if (!Number.isFinite(awareness.x) || !Number.isFinite(awareness.y)) return;
    cursorSentAtRef.current = now;
    socket.send(
      JSON.stringify({
        type: MESSAGE_TYPES.CURSOR,
        diagramId: session.diagramId,
        x: awareness.x,
        y: awareness.y,
        selected: awareness.selected ?? null,
      }),
    );
  }, []);

  const emitDelta = useCallback((delta) => {
    if (
      delta?.target !== "table" ||
      delta.action !== "update" ||
      delta.data?.length !== 2
    ) {
      return;
    }
    const [id, values] = delta.data;
    if (!Number.isFinite(values?.x) || !Number.isFinite(values?.y)) return;

    const sendPreview = (payload) => {
      const socket = socketRef.current;
      const session = sessionRef.current;
      if (!session || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: MESSAGE_TYPES.OPERATION_PREVIEW,
          diagramId: session.diagramId,
          operation: { type: "table.move", payload },
        }),
      );
    };

    const now = Date.now();
    const current = previewThrottleRef.current.get(id) ?? {
      lastSent: 0,
      timer: null,
      payload: null,
    };
    current.payload = { id, x: values.x, y: values.y };
    const remaining = 50 - (now - current.lastSent);
    if (remaining <= 0) {
      window.clearTimeout(current.timer);
      current.timer = null;
      current.lastSent = now;
      sendPreview(current.payload);
    } else if (current.timer === null) {
      current.timer = window.setTimeout(() => {
        current.timer = null;
        current.lastSent = Date.now();
        sendPreview(current.payload);
      }, remaining);
    }
    previewThrottleRef.current.set(id, current);
  }, []);

  const acquireTableLock = useCallback((tableId) => {
    const key = lockKey(tableId);
    if (heldLocksRef.current.has(key)) return Promise.resolve(true);
    const existingRequest = pendingLocksByTableRef.current.get(key);
    if (existingRequest) return existingRequest;

    const socket = socketRef.current;
    const session = sessionRef.current;
    if (!session || socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    const requestId = nanoid();
    const request = new Promise((resolve) => {
      pendingLocksRef.current.set(requestId, { tableId: key, resolve });
      socket.send(
        JSON.stringify({
          type: MESSAGE_TYPES.TABLE_LOCK_ACQUIRE,
          diagramId: session.diagramId,
          tableId,
          requestId,
        }),
      );
      window.setTimeout(() => {
        const pending = pendingLocksRef.current.get(requestId);
        if (!pending) return;
        pendingLocksRef.current.delete(requestId);
        pendingLocksByTableRef.current.delete(key);
        pending.resolve(false);
      }, 5_000);
    });
    pendingLocksByTableRef.current.set(key, request);
    return request;
  }, []);

  const acquireTableLocks = useCallback(
    async (tableIds) => {
      const acquired = [];
      for (const tableId of [...new Set(tableIds)]) {
        if (await acquireTableLock(tableId)) {
          acquired.push(lockKey(tableId));
          continue;
        }
        const socket = socketRef.current;
        const session = sessionRef.current;
        for (const acquiredTableId of acquired) {
          const lock = heldLocksRef.current.get(acquiredTableId);
          if (!lock) continue;
          socket?.send(
            JSON.stringify({
              type: MESSAGE_TYPES.TABLE_LOCK_RELEASE,
              diagramId: session?.diagramId,
              tableId: acquiredTableId,
              token: lock.token,
            }),
          );
          heldLocksRef.current.delete(acquiredTableId);
        }
        return false;
      }
      return true;
    },
    [acquireTableLock],
  );

  const releaseTableLocks = useCallback((tableIds) => {
    const socket = socketRef.current;
    const session = sessionRef.current;
    if (!session || socket?.readyState !== WebSocket.OPEN) return;
    for (const tableId of [...new Set(tableIds)]) {
      const key = lockKey(tableId);
      if ((retainedLocksRef.current.get(key) ?? 0) > 0) continue;
      const lock = heldLocksRef.current.get(key);
      if (!lock) continue;
      socket.send(
        JSON.stringify({
          type: MESSAGE_TYPES.TABLE_LOCK_RELEASE,
          diagramId: session.diagramId,
          tableId,
          token: lock.token,
        }),
      );
      heldLocksRef.current.delete(key);
    }
  }, []);

  const retainTableLock = useCallback((tableId) => {
    const key = lockKey(tableId);
    retainedLocksRef.current.set(
      key,
      (retainedLocksRef.current.get(key) ?? 0) + 1,
    );
  }, []);

  const releaseTableLockRetention = useCallback((tableId) => {
    const key = lockKey(tableId);
    const count = retainedLocksRef.current.get(key) ?? 0;
    if (count <= 1) retainedLocksRef.current.delete(key);
    else retainedLocksRef.current.set(key, count - 1);
  }, []);

  const isTableLockedByOther = useCallback(
    (tableId) => {
      const lock = tableLocks[tableId];
      return Boolean(lock && lock.clientId !== identityRef.current.clientId);
    },
    [tableLocks],
  );

  const hasTableLock = useCallback(
    (tableId) => tableLocks[tableId]?.clientId === identityRef.current.clientId,
    [tableLocks],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      const session = sessionRef.current;
      if (!session || socket?.readyState !== WebSocket.OPEN) return;
      for (const [tableId, lock] of heldLocksRef.current) {
        socket.send(
          JSON.stringify({
            type: MESSAGE_TYPES.TABLE_LOCK_RENEW,
            diagramId: session.diagramId,
            tableId,
            token: lock.token,
          }),
        );
      }
    }, 4_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const value = useMemo(
    () => ({
      connect,
      disconnect,
      sendSnapshot,
      connectionState,
      participants,
      remoteCursors,
      tableLocks,
      identity: identityRef.current,
      versionRef,
      emitDelta,
      emitAwareness,
      acquireTableLock,
      acquireTableLocks,
      releaseTableLocks,
      retainTableLock,
      releaseTableLockRetention,
      isTableLockedByOther,
      hasTableLock,
      isApplyingRemoteRef,
    }),
    [
      connect,
      acquireTableLock,
      acquireTableLocks,
      connectionState,
      disconnect,
      emitDelta,
      emitAwareness,
      hasTableLock,
      isTableLockedByOther,
      participants,
      remoteCursors,
      releaseTableLockRetention,
      releaseTableLocks,
      retainTableLock,
      sendSnapshot,
      tableLocks,
    ],
  );
  return (
    <CollabContext.Provider value={value}>{children}</CollabContext.Provider>
  );
}
