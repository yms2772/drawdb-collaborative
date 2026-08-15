export { MESSAGE_TYPES } from "../src/collaboration/protocol.js";

export const DIAGRAM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidEntityId(value) {
  return (
    (typeof value === "string" && CLIENT_ID_PATTERN.test(value)) ||
    (Number.isSafeInteger(value) && value >= 0)
  );
}

// Entity IDs arrive as either strings or numbers depending on how the diagram
// was created. Lock bookkeeping is keyed by Map, where 0 and "0" are distinct
// keys, so every ID crosses into the lock manager as a string.
export function toEntityKey(value) {
  return String(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidParticipant(participant) {
  return (
    isPlainObject(participant) &&
    CLIENT_ID_PATTERN.test(participant.clientId || "") &&
    typeof participant.displayName === "string" &&
    participant.displayName.length > 0 &&
    participant.displayName.length <= 64 &&
    typeof participant.color === "string" &&
    participant.color.length <= 32
  );
}

export function isValidOperationPreview(operation) {
  if (!isPlainObject(operation) || operation.type !== "table.move")
    return false;
  const { payload } = operation;
  if (
    !isPlainObject(payload) ||
    !isValidEntityId(payload.id) ||
    !Number.isFinite(payload.x) ||
    !Number.isFinite(payload.y)
  ) {
    return false;
  }
  // tableId is what the lock check reads, so it must be validated too and must
  // name the same table the payload moves.
  if (payload.tableId === undefined) return true;
  return (
    isValidEntityId(payload.tableId) &&
    toEntityKey(payload.tableId) === toEntityKey(payload.id)
  );
}
