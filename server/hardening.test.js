import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createApplication } from "./index.js";
import { isValidOperationPreview } from "./protocol.js";
import { createTableLockManager } from "./tableLocks.js";

// Regression tests for the hardening pass. Each one reproduces a way an
// unauthenticated client could crash the server, bypass a check, or corrupt
// lock state.

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function startApplication(t, diagrams = []) {
  const application = createApplication({ databasePath: ":memory:" });
  for (const diagram of diagrams) application.store.create(diagram);
  await new Promise((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => {
    application.websocket.close();
    application.server.close();
    application.database.close();
  });
  const { port } = application.server.address();
  return { application, port, origin: `http://127.0.0.1:${port}` };
}

async function join(socket, diagramId, clientId) {
  const joined = waitForMessage(socket, (message) => message.type === "joined");
  socket.send(
    JSON.stringify({
      type: "join",
      diagramId,
      lastVersion: 1,
      participant: { clientId, displayName: clientId, color: "#000" },
    }),
  );
  return joined;
}

test("a non-string operation name is rejected instead of crashing the process", async (t) => {
  const { port } = await startApplication(t, [
    { id: "crash-name", name: "One", document: { tables: [] } },
  ]);
  const socket = await openSocket(
    `ws://127.0.0.1:${port}/ws/diagrams/crash-name`,
  );
  t.after(() => socket.close());
  await join(socket, "crash-name", "client-a");

  const rejected = waitForMessage(
    socket,
    (message) => message.type === "error",
  );
  socket.send(
    JSON.stringify({
      type: "operation",
      diagramId: "crash-name",
      clientId: "client-a",
      operationId: "op-1",
      baseVersion: 1,
      operation: {
        type: "snapshot.replace",
        // An object here used to reach better-sqlite3, which throws on a type
        // it cannot bind, taking down every room on the server.
        payload: { name: {}, document: { tables: [] } },
      },
    }),
  );
  assert.equal((await rejected).message, "Invalid operation");

  // The connection — and the process — must still be usable.
  const pong = waitForMessage(socket, (message) => message.type === "pong");
  socket.send(JSON.stringify({ type: "ping", diagramId: "crash-name" }));
  await pong;
});

test("an operation against a deleted diagram is rejected instead of crashing", async (t) => {
  const { application, port } = await startApplication(t, [
    { id: "deleted-op", name: "One", document: { tables: [] } },
  ]);
  const socket = await openSocket(
    `ws://127.0.0.1:${port}/ws/diagrams/deleted-op`,
  );
  t.after(() => socket.close());
  await join(socket, "deleted-op", "client-a");

  application.store.delete("deleted-op");

  const rejected = waitForMessage(
    socket,
    (message) => message.type === "error",
  );
  socket.send(
    JSON.stringify({
      type: "operation",
      diagramId: "deleted-op",
      clientId: "client-a",
      operationId: "op-1",
      baseVersion: 1,
      operation: {
        type: "snapshot.replace",
        payload: { name: "One", document: { tables: [] } },
      },
    }),
  );
  assert.equal((await rejected).message, "Diagram not found");
});

test("joining a diagram deleted after the upgrade is rejected instead of crashing", async (t) => {
  const { application, port } = await startApplication(t, [
    { id: "deleted-join", name: "One", document: { tables: [] } },
  ]);
  const socket = await openSocket(
    `ws://127.0.0.1:${port}/ws/diagrams/deleted-join`,
  );
  t.after(() => socket.close());

  application.store.delete("deleted-join");

  const rejected = waitForMessage(
    socket,
    (message) => message.type === "error",
  );
  socket.send(
    JSON.stringify({
      type: "join",
      diagramId: "deleted-join",
      lastVersion: 1,
      participant: { clientId: "a", displayName: "a", color: "#000" },
    }),
  );
  assert.equal((await rejected).message, "Diagram not found");
});

test("a cross-origin WebSocket upgrade is refused", async (t) => {
  const { port } = await startApplication(t, [
    { id: "origin-check", name: "One", document: { tables: [] } },
  ]);
  const url = `ws://127.0.0.1:${port}/ws/diagrams/origin-check`;

  await assert.rejects(
    openSocket(url, { origin: "https://attacker.example" }),
    /403/,
  );
  // A same-origin browser client is still allowed.
  const allowed = await openSocket(url, { origin: `http://127.0.0.1:${port}` });
  t.after(() => allowed.close());
});

test("the request body cannot override the diagram ID in the path", async (t) => {
  const { application, origin } = await startApplication(t, [
    { id: "victim", name: "Victim", document: { tables: [] } },
    { id: "attacker", name: "Attacker", document: { tables: [] } },
  ]);

  const response = await fetch(`${origin}/api/diagrams/attacker`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "victim",
      name: "Overwritten",
      document: { tables: [{ id: 1 }] },
      baseVersion: 1,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(application.store.get("victim").name, "Victim");
  assert.equal(application.store.get("attacker").name, "Overwritten");
});

test("a null diagram ID is rejected rather than inserting an unreachable row", async (t) => {
  const { application, origin } = await startApplication(t);

  const response = await fetch(`${origin}/api/diagrams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: null,
      name: "Null id",
      document: { tables: [] },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(application.store.list().length, 0);
});

test("a preview cannot claim a lock on one table while moving another", () => {
  // The lock check reads tableId; the broadcast moves id. They must agree.
  assert.equal(
    isValidOperationPreview({
      type: "table.move",
      payload: { id: "table-b", tableId: "table-a", x: 1, y: 2 },
    }),
    false,
  );
  assert.equal(
    isValidOperationPreview({
      type: "table.move",
      payload: { id: "table-a", tableId: "table-a", x: 1, y: 2 },
    }),
    true,
  );
});

test("numeric and string table IDs address the same lock", () => {
  const locks = createTableLockManager();
  const first = locks.acquire("d", 0, { clientId: "a", displayName: "a" });
  assert.equal(first.granted, true);

  // Before normalization, 0 and "0" were distinct Map keys, so both clients
  // held an "exclusive" lock on the same table.
  const second = locks.acquire("d", "0", { clientId: "b", displayName: "b" });
  assert.equal(second.granted, false);
  assert.equal(second.lock.clientId, "a");

  assert.equal(locks.owns("d", "0", "a"), true);
  assert.equal(locks.owns("d", 0, "a"), true);
  assert.equal(locks.list("d").length, 1);
});

test("a failed lock renewal tells the client the lease is gone", async (t) => {
  const { port } = await startApplication(t, [
    { id: "renew-test", name: "One", document: { tables: [] } },
  ]);
  const socket = await openSocket(
    `ws://127.0.0.1:${port}/ws/diagrams/renew-test`,
  );
  t.after(() => socket.close());
  await join(socket, "renew-test", "client-a");

  const state = waitForMessage(
    socket,
    (message) => message.type === "table_lock_state",
  );
  socket.send(
    JSON.stringify({
      type: "table_lock_renew",
      diagramId: "renew-test",
      tableId: "table-1",
      token: 999,
    }),
  );
  assert.deepEqual((await state).locks, []);
});

test("the sender is acknowledged without having its own document echoed back", async (t) => {
  const { port } = await startApplication(t, [
    { id: "echo-test", name: "One", document: { tables: [] } },
  ]);
  const url = `ws://127.0.0.1:${port}/ws/diagrams/echo-test`;
  const sender = await openSocket(url);
  const peer = await openSocket(url);
  t.after(() => {
    sender.close();
    peer.close();
  });
  await join(sender, "echo-test", "client-a");
  await join(peer, "echo-test", "client-b");

  const senderAck = waitForMessage(
    sender,
    (message) => message.type === "operation_applied",
  );
  const peerUpdate = waitForMessage(
    peer,
    (message) => message.type === "operation_applied",
  );
  sender.send(
    JSON.stringify({
      type: "operation",
      diagramId: "echo-test",
      clientId: "client-a",
      operationId: "op-1",
      baseVersion: 1,
      operation: {
        type: "snapshot.replace",
        payload: { name: "Two", document: { tables: [{ id: 1 }] } },
      },
    }),
  );

  const ack = await senderAck;
  assert.equal(ack.version, 2);
  assert.equal(ack.operation, undefined);

  const update = await peerUpdate;
  assert.equal(update.version, 2);
  assert.deepEqual(update.operation.payload.document, { tables: [{ id: 1 }] });
});
