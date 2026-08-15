import { useState, useEffect, useCallback, useRef, createContext } from "react";
import { v4 as uuidv4 } from "uuid";
import ControlPanel from "./EditorHeader/ControlPanel";
import { Slot } from "../context/ExtensionsContext";
import Canvas from "./EditorCanvas/Canvas";
import CollaborationCursors from "./CollaborationCursors";
import { CanvasContextProvider } from "../context/CanvasContext";
import SidePanel from "./EditorSidePanel/SidePanel";
import { DB, State } from "../data/constants";
import { db } from "../data/db";
import { diagramApi } from "../api/diagrams";
import {
  useLayout,
  useSettings,
  useTransform,
  useDiagram,
  useUndoRedo,
  useAreas,
  useNotes,
  useTypes,
  useSaveState,
  useEnums,
  useNavigateWithParams,
  useCollab,
} from "../hooks";
import FloatingControls from "./FloatingControls";
import { Button, Modal, Tag } from "@douyinfe/semi-ui";
import { IconAlertTriangle } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import { databases } from "../data/databases";
import { isRtl } from "../i18n/utils/rtl";
import { useMatch, useParams } from "react-router-dom";

export const IdContext = createContext({
  gistId: "",
  setGistId: () => {},
  version: "",
  setVersion: () => {},
});

const SIDEPANEL_MIN_WIDTH = 374;

export default function WorkSpace({ forcedDiagramId } = {}) {
  const [gistId, setGistId] = useState("");
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("Untitled Diagram");
  const [resize, setResize] = useState(false);
  const [toolbarContainer, setToolbarContainer] = useState(null);
  const [width, setWidth] = useState(SIDEPANEL_MIN_WIDTH);
  const [lastSaved, setLastSaved] = useState("");
  const [showSelectDbModal, setShowSelectDbModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [selectedDb, setSelectedDb] = useState("");

  const pendingNewIdRef = useRef(null);
  const loadedIdRef = useRef(null);
  const saveTimerRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const { layout, setLayout } = useLayout();
  const { settings } = useSettings();
  const { types, setTypes } = useTypes();
  const { areas, setAreas } = useAreas();
  const { notes, setNotes } = useNotes();
  const { saveState, setSaveState } = useSaveState();
  // Read by the collaboration callbacks, which must not join `load`'s
  // dependency list — that would tear down and rebuild the socket on every
  // save-state transition.
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const { transform, setTransform } = useTransform();
  const { enums, setEnums } = useEnums();
  const {
    tables,
    relationships,
    setTables,
    setRelationships,
    database,
    setDatabase,
  } = useDiagram();
  const { undoStack, redoStack, setUndoStack, setRedoStack } = useUndoRedo();
  const {
    connect,
    disconnect,
    sendSnapshot,
    connectionState,
    participants,
    versionRef,
  } = useCollab();
  const { t, i18n } = useTranslation();
  const { id: routeDiagramId } = useParams();
  const loadedDiagramId = forcedDiagramId ?? routeDiagramId;
  const editorDiagramMatch = useMatch("/editor/diagrams/:id");
  const directDiagramMatch = useMatch("/diagrams/:id");
  const isDiagram = forcedDiagramId
    ? true
    : Boolean(editorDiagramMatch || directDiagramMatch);
  const isTemplate = useMatch("/editor/templates/:id");

  const navigate = useNavigateWithParams();
  const handleResize = (e) => {
    if (!resize) return;
    const w = isRtl(i18n.language) ? window.innerWidth - e.clientX : e.clientX;
    if (w > SIDEPANEL_MIN_WIDTH) setWidth(w);
  };

  const buildDocument = useCallback(
    () => ({
      database,
      tables,
      references: relationships,
      notes,
      areas,
      pan: transform.pan,
      zoom: transform.zoom,
      ...(databases[database].hasEnums && { enums }),
      ...(databases[database].hasTypes && { types }),
    }),
    [database, tables, relationships, notes, areas, transform, enums, types],
  );

  const applyDiagramState = useCallback(
    (serverDiagram, { remote = false } = {}) => {
      const diagram = serverDiagram.document ?? serverDiagram;
      applyingRemoteRef.current = true;
      versionRef.current = serverDiagram.version ?? versionRef.current;
      setDatabase(diagram.database || DB.GENERIC);
      setTitle(serverDiagram.name ?? diagram.name ?? "Untitled diagram");
      setTables(diagram.tables ?? []);
      setRelationships(diagram.references ?? diagram.relationships ?? []);
      setAreas(diagram.areas ?? diagram.subjectAreas ?? []);
      setNotes(diagram.notes ?? []);
      if (!remote) {
        setTransform({
          pan: diagram.pan ?? { x: 0, y: 0 },
          zoom: diagram.zoom ?? 1,
        });
      }
      setTypes(diagram.types ?? []);
      setEnums(diagram.enums ?? []);
      if (!remote) {
        setUndoStack([]);
        setRedoStack([]);
      }
    },
    [
      setAreas,
      setDatabase,
      setEnums,
      setNotes,
      setRedoStack,
      setRelationships,
      setTables,
      setTransform,
      setTypes,
      setUndoStack,
      versionRef,
    ],
  );

  const save = useCallback(async () => {
    const isNew = isTemplate || !loadedDiagramId || loadedDiagramId === "blank";
    const targetId = isNew
      ? (pendingNewIdRef.current ??= uuidv4())
      : loadedDiagramId;
    try {
      if (isNew) {
        const created = await diagramApi.create({
          id: targetId,
          name: title,
          document: buildDocument(),
        });
        versionRef.current = created.version;
        pendingNewIdRef.current = null;
        navigate(`/diagrams/${targetId}`, { replace: true });
      } else if (connectionState === "connected") {
        await sendSnapshot(title, buildDocument());
      } else {
        const updated = await diagramApi.update(targetId, {
          name: title,
          document: buildDocument(),
          baseVersion: versionRef.current,
        });
        versionRef.current = updated.version;
      }
      setSaveState(State.SAVED);
      setLastSaved(new Date().toLocaleString());
    } catch (error) {
      if (error.diagram) applyDiagramState(error.diagram, { remote: true });
      console.warn("server autosave failed:", error);
      setSaveState(State.ERROR);
    }
  }, [
    buildDocument,
    title,
    setSaveState,
    isTemplate,
    loadedDiagramId,
    navigate,
    connectionState,
    sendSnapshot,
    versionRef,
    applyDiagramState,
  ]);

  const load = useCallback(async () => {
    const previousLoadedId = loadedIdRef.current;
    loadedIdRef.current = loadedDiagramId ?? null;

    const resetEditorState = () => {
      disconnect();
      setTables([]);
      setRelationships([]);
      setAreas([]);
      setNotes([]);
      setTypes([]);
      setEnums([]);
      setUndoStack([]);
      setRedoStack([]);
      setTransform({ zoom: 1, pan: { x: 0, y: 0 } });
      setTitle("Untitled diagram");
      setGistId("");
      setLayout((prev) => ({ ...prev, readOnly: false }));
    };

    const loadDiagram = async (id) => {
      try {
        const diagram = await diagramApi.get(id);
        setLayout((prev) => ({ ...prev, readOnly: false }));
        applyDiagramState(diagram);
        connect({
          diagramId: id,
          version: diagram.version,
          onSnapshot: (snapshot) => {
            // A snapshot that lands while a local save is pending must not
            // report success: doing so cancelled the debounced save and
            // displayed "Saved" over edits that were just overwritten.
            const hadPendingSave = saveStateRef.current === State.SAVING;
            applyDiagramState(snapshot, { remote: true });
            if (hadPendingSave) return;
            setSaveState(State.SAVED);
            setLastSaved(new Date().toLocaleString());
          },
          onDelta: (operation) => {
            if (operation?.type !== "table.move") return;
            const { id: tableId, x, y } = operation.payload ?? {};
            // The send path validates these; the receive path did not.
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            setTables((current) =>
              current.map((table) =>
                table.id === tableId ? { ...table, x, y } : table,
              ),
            );
          },
          onError: (reason) => {
            console.warn("collaboration rejected a message:", reason);
          },
        });
      } catch (error) {
        console.warn("diagram load failed:", error);
        setSaveState(State.FAILED_TO_LOAD);
      }
    };

    const loadTemplate = async (id) => {
      const template = await db.templates
        .where("templateId")
        .equals(id)
        .first();
      if (!template) {
        if (previousLoadedId !== loadedIdRef.current) resetEditorState();
        if (selectedDb === "") setShowSelectDbModal(true);
        return;
      }
      disconnect();
      setDatabase(template.database || DB.GENERIC);
      setTitle(template.title);
      setTables(template.tables);
      setRelationships(template.relationships);
      setAreas(template.subjectAreas);
      setNotes(template.notes);
      setTransform({ zoom: 1, pan: { x: 0, y: 0 } });
      setUndoStack([]);
      setRedoStack([]);
      setTypes(template.types ?? []);
      setEnums(template.enums ?? []);
    };

    if (!loadedDiagramId) {
      if (previousLoadedId != null) resetEditorState();
      if (selectedDb === "") setShowSelectDbModal(true);
      return;
    }

    if (isDiagram && loadedDiagramId) {
      await loadDiagram(loadedDiagramId);
      return;
    }

    if (isTemplate && loadedDiagramId) {
      await loadTemplate(loadedDiagramId);
      return;
    }
  }, [
    applyDiagramState,
    connect,
    disconnect,
    setTransform,
    setRedoStack,
    setUndoStack,
    setRelationships,
    setTables,
    setAreas,
    setNotes,
    setTypes,
    setDatabase,
    setEnums,
    selectedDb,
    setSaveState,
    setLayout,
    isDiagram,
    isTemplate,
    loadedDiagramId,
  ]);

  const returnToCurrentDiagram = async () => {
    await load();
    setLayout((prev) => ({ ...prev, readOnly: false }));
    setVersion(null);
  };

  useEffect(() => {
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }
    if (
      tables?.length === 0 &&
      areas?.length === 0 &&
      notes?.length === 0 &&
      types?.length === 0
    )
      return;

    if (settings.autosave) {
      setSaveState(State.SAVING);
    }
  }, [
    undoStack,
    redoStack,
    settings.autosave,
    tables?.length,
    areas?.length,
    notes?.length,
    types?.length,
    relationships?.length,
    transform.zoom,
    title,
    gistId,
    setSaveState,
  ]);

  useEffect(() => {
    // A remote snapshot may only change values that are intentionally absent
    // from the autosave dependency list. Do not let its suppression flag leak
    // into the user's next local edit in that case.
    applyingRemoteRef.current = false;
  });

  useEffect(() => {
    if (layout.readOnly) return;
    if (saveState !== State.SAVING) return;
    if (applyingRemoteRef.current) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(save, 600);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [saveState, layout, save]);

  useEffect(() => {
    document.title = "Editor | drawDB";

    load();
  }, [load]);

  return (
    <div className="h-full flex flex-col overflow-hidden theme">
      <IdContext.Provider value={{ gistId, setGistId, version, setVersion }}>
        <ControlPanel
          title={title}
          setTitle={setTitle}
          lastSaved={lastSaved}
          toolbarContainer={toolbarContainer}
        />
      </IdContext.Provider>
      <div
        className="flex h-full overflow-y-auto"
        onPointerUp={(e) => e.isPrimary && setResize(false)}
        onPointerLeave={(e) => e.isPrimary && setResize(false)}
        onPointerMove={(e) => {
          if (!e.isPrimary) return;
          handleResize(e);
        }}
        onPointerDown={(e) => {
          // Required for onPointerLeave to trigger when a touch pointer leaves
          // https://stackoverflow.com/a/70976017/1137077
          e.target.releasePointerCapture(e.pointerId);
        }}
        style={isRtl(i18n.language) ? { direction: "rtl" } : {}}
      >
        {layout.sidebar && (
          <SidePanel resize={resize} setResize={setResize} width={width} />
        )}
        <div className="relative flex-1 min-w-0 h-full overflow-hidden">
          <CanvasContextProvider className="h-full w-full">
            <Canvas saveState={saveState} setSaveState={setSaveState} />
            <CollaborationCursors />
          </CanvasContextProvider>
          <Slot name="canvas-overlay" />
          {isDiagram && loadedDiagramId && (
            <div className="pointer-events-none absolute right-3 top-3 z-40 flex items-center gap-2 rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 text-xs text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-100">
              <span
                className={`h-2 w-2 rounded-full ${
                  connectionState === "connected"
                    ? "bg-emerald-500"
                    : connectionState === "connecting"
                      ? "bg-amber-500"
                      : "bg-red-500"
                }`}
              />
              <span>
                {t(`collaboration_${connectionState}`, connectionState)}
              </span>
              {participants.length > 0 && (
                <span className="text-zinc-600 dark:text-zinc-300">
                  {t("collaboration_participants", {
                    count: participants.length,
                  })}
                </span>
              )}
            </div>
          )}
          {layout.toolbar && (
            <div
              ref={setToolbarContainer}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20"
            />
          )}
          {version && (
            <div className="absolute right-8 top-2 space-x-2">
              <Button
                icon={<i className="fa-solid fa-rotate-right mt-0.5"></i>}
                onClick={() => setShowRestoreModal(true)}
              >
                {t("restore_version")}
              </Button>
              <Button
                type="tertiary"
                onClick={returnToCurrentDiagram}
                icon={<i className="bi bi-arrow-return-right mt-1"></i>}
              >
                {t("return_to_current")}
              </Button>
            </div>
          )}
          {!(layout.sidebar || layout.toolbar || layout.header) && (
            <div className="fixed right-5 bottom-4">
              <FloatingControls />
            </div>
          )}
        </div>
        <Slot name="right-panel" />
      </div>
      <Modal
        centered
        size="medium"
        closable={false}
        hasCancel={false}
        title={t("pick_db")}
        okText={t("confirm")}
        visible={showSelectDbModal}
        onOk={() => {
          if (selectedDb === "") return;
          setDatabase(selectedDb);
          setShowSelectDbModal(false);
        }}
        okButtonProps={{ disabled: selectedDb === "" }}
      >
        <div className="grid grid-cols-3 gap-4 place-content-center">
          {Object.values(databases).map((x) => (
            <div
              key={x.name}
              onClick={() => setSelectedDb(x.label)}
              className={`space-y-3 p-3 rounded-md border-2 select-none ${
                settings.mode === "dark"
                  ? "bg-zinc-700 hover:bg-zinc-600"
                  : "bg-zinc-100 hover:bg-zinc-200"
              } ${selectedDb === x.label ? "border-zinc-400" : "border-transparent"}`}
            >
              <div className="flex items-center justify-between">
                <div className="font-semibold">{x.name}</div>
                {x.beta && (
                  <Tag size="small" color="light-blue">
                    Beta
                  </Tag>
                )}
              </div>
              {x.image && (
                <img
                  src={x.image}
                  className="h-8"
                  style={{
                    filter:
                      "opacity(0.4) drop-shadow(0 0 0 white) drop-shadow(0 0 0 white)",
                  }}
                />
              )}
              <div className="text-xs">{x.description}</div>
            </div>
          ))}
        </div>
      </Modal>
      <Modal
        visible={showRestoreModal}
        centered
        closable
        onCancel={() => setShowRestoreModal(false)}
        title={
          <span className="flex items-center gap-2">
            <IconAlertTriangle className="text-amber-400" size="extra-large" />{" "}
            {t("restore_version")}
          </span>
        }
        okText={t("continue")}
        cancelText={t("cancel")}
        onOk={() => {
          setLayout((prev) => ({ ...prev, readOnly: false }));
          setShowRestoreModal(false);
          setVersion(null);
        }}
      >
        {t("restore_warning")}
      </Modal>
    </div>
  );
}
