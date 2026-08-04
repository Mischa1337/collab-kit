// Session-Rollen — eine Quelle der Wahrheit für die interne Codebasis.
// owner       = alles (editieren + Peer Review + verwalten)
// member      = editieren + kommentieren + Peer Review
// commentator = kommentieren + geteilten Stand mit Kommentaren sehen (KEIN Edit, KEINE Peer-Review)
// spectator   = read-only (Text + Modell), OHNE Kommentare
//
// HINWEIS: Der gleichnamige Typ in contracts/be-contract.ts ist BEWUSST eine eigene,
// importfreie Kopie (das FE kopiert die Datei 1:1) — nicht mit diesem Typ koppeln.
export type SessionRole = 'owner' | 'member' | 'commentator' | 'spectator';
