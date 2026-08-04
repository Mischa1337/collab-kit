// Geteilte Modell-Typen an der Service-Grenze (M11). Bewusst LOCKER (unknown[]) —
// die strenge Form/Validierung liegt in services/collaboration/model.types.ts.
// Frühere Doppeldefinition in drafts.service.ts und history.service.ts → hier zusammengeführt.
export interface PlainModelJson {
  nodes?: unknown[];
  edges?: unknown[];
}
