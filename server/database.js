import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/* global process */

const DEFAULT_DATABASE_PATH = path.resolve("data/drawdb.sqlite");

export function openDatabase(databasePath = process.env.DATABASE_PATH) {
  const configuredPath = databasePath || DEFAULT_DATABASE_PATH;
  const resolvedPath =
    configuredPath === ":memory:"
      ? configuredPath
      : path.resolve(configuredPath);
  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagrams (
      -- SQLite permits NULL in a TEXT PRIMARY KEY unless NOT NULL is declared,
      -- which would let a null id insert unreachable rows without deduping.
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      document TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applied_operations (
      diagram_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (diagram_id, operation_id),
      FOREIGN KEY (diagram_id) REFERENCES diagrams(id) ON DELETE CASCADE
    );
  `);
  return db;
}

export function createDiagramStore(db) {
  const selectOne = db.prepare(
    "SELECT id, name, document, version, created_at, updated_at FROM diagrams WHERE id = ?",
  );
  const parse = (row) =>
    row ? { ...row, document: JSON.parse(row.document) } : null;

  const updateSnapshot = db.transaction(
    ({ id, name, document, baseVersion, operationId }) => {
      const current = selectOne.get(id);
      if (!current) return { status: "not_found" };
      const duplicate = operationId
        ? db
            .prepare(
              "SELECT version FROM applied_operations WHERE diagram_id = ? AND operation_id = ?",
            )
            .get(id, operationId)
        : null;
      if (duplicate) {
        return { status: "duplicate", diagram: parse(selectOne.get(id)) };
      }
      if (current.version !== baseVersion) {
        return { status: "conflict", diagram: parse(current) };
      }

      const now = new Date().toISOString();
      const version = current.version + 1;
      db.prepare(
        "UPDATE diagrams SET name = ?, document = ?, version = ?, updated_at = ? WHERE id = ?",
      ).run(name ?? current.name, JSON.stringify(document), version, now, id);
      if (operationId) {
        db.prepare(
          "INSERT INTO applied_operations (diagram_id, operation_id, version, created_at) VALUES (?, ?, ?, ?)",
        ).run(id, operationId, version, now);
      }
      return { status: "updated", diagram: parse(selectOne.get(id)) };
    },
  );

  const selectExists = db.prepare("SELECT 1 FROM diagrams WHERE id = ?");

  return {
    // Existence check that avoids reading and JSON.parse-ing the whole
    // document, which the WebSocket upgrade path does on every connection.
    exists(id) {
      return selectExists.get(id) !== undefined;
    },
    list() {
      return db
        .prepare(
          "SELECT id, name, version, created_at, updated_at FROM diagrams ORDER BY updated_at DESC",
        )
        .all();
    },
    get(id) {
      return parse(selectOne.get(id));
    },
    create({ id, name, document }) {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO diagrams (id, name, document, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).run(id, name, JSON.stringify(document), now, now);
      return parse(selectOne.get(id));
    },
    updateSnapshot,
    delete(id) {
      return (
        db.prepare("DELETE FROM diagrams WHERE id = ?").run(id).changes > 0
      );
    },
  };
}
