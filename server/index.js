import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createDiagramStore, openDatabase } from "./database.js";
import { DIAGRAM_ID_PATTERN, isPlainObject } from "./protocol.js";
import { attachCollaborationServer } from "./websocket.js";

/* global process */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_DOCUMENT_BYTES = "2mb";

export function createApplication({ databasePath, staticPath } = {}) {
  const database = openDatabase(databasePath);
  const store = createDiagramStore(database);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: MAX_DOCUMENT_BYTES }));

  const validId = (req, res, next) => {
    if (!DIAGRAM_ID_PATTERN.test(req.params.id || "")) {
      res.status(400).json({ error: "Invalid diagram ID" });
      return;
    }
    next();
  };
  const validPayload = (body) =>
    isPlainObject(body) &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    body.name.length <= 200 &&
    isPlainObject(body.document);

  app.get("/api/diagrams", (_req, res) => res.json({ diagrams: store.list() }));
  app.post("/api/diagrams", (req, res, next) => {
    try {
      if (!validPayload(req.body)) {
        res
          .status(400)
          .json({ error: "A valid name and document are required" });
        return;
      }
      const requestedId = req.body.id;
      const id = requestedId ?? crypto.randomUUID();
      if (!DIAGRAM_ID_PATTERN.test(id)) {
        res.status(400).json({ error: "Invalid diagram ID" });
        return;
      }
      if (store.get(id)) {
        res.status(409).json({ error: "Diagram already exists" });
        return;
      }
      res.status(201).json(store.create({ id, ...req.body }));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/diagrams/:id", validId, (req, res) => {
    const diagram = store.get(req.params.id);
    if (!diagram) res.status(404).json({ error: "Diagram not found" });
    else res.json(diagram);
  });
  app.put("/api/diagrams/:id", validId, (req, res) => {
    if (!validPayload(req.body) || !Number.isInteger(req.body.baseVersion)) {
      res
        .status(400)
        .json({
          error: "A valid name, document, and baseVersion are required",
        });
      return;
    }
    const result = store.updateSnapshot({ id: req.params.id, ...req.body });
    if (result.status === "not_found")
      res.status(404).json({ error: "Diagram not found" });
    else if (result.status === "conflict") {
      res
        .status(409)
        .json({ error: "Version conflict", diagram: result.diagram });
    } else res.json(result.diagram);
  });
  app.delete("/api/diagrams/:id", validId, (req, res) => {
    if (!store.delete(req.params.id))
      res.status(404).json({ error: "Diagram not found" });
    else res.status(204).end();
  });

  const assets = staticPath || path.resolve(__dirname, "../dist");
  if (fs.existsSync(assets)) {
    app.use(express.static(assets));
    app.get("*splat", (_req, res) =>
      res.sendFile(path.join(assets, "index.html")),
    );
  }
  app.use((error, _req, res, next) => {
    void next;
    console.error("Request failed:", error.message);
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const server = http.createServer(app);
  const websocket = attachCollaborationServer(server, store);
  return { app, server, websocket, database, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The API and WebSocket are unauthenticated, so a stray listener is a
  // full read/write/delete surface. Keep the process alive on unexpected
  // errors rather than letting one bad frame take every room down.
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const host = process.env.BIND_HOST || "127.0.0.1";
  const { server } = createApplication();
  server.listen(port, host, () => {
    console.log(`drawDB listening on http://${host}:${port}`);
  });
}
