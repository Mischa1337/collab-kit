-- ============================================================================
-- schema.sql — KONSOLIDIERTE REFERENZ des End-Schemas
-- ============================================================================
-- NUR ZUM LESEN / ONBOARDING. Diese Datei wird NICHT ausgeführt:
-- der Migrations-Runner (db/migrate.ts) liest ausschließlich db/migrations/.
-- Seit der Konsolidierung ist db/migrations/001_init.sql die (einzige) ausführbare
-- Quelle der Wahrheit; diese Datei ist ihr menschenlesbarer, kommentierter Zwilling.
-- Stand: End-Schema OHNE session_participants (Yjs-Awareness-Duplikat, entfernt).
--
-- Reihenfolge ist FK-korrekt (Ziel-Tabellen zuerst): sessions → documents →
-- history → reviews → comments → übrige session-bezogene Tabellen.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Wurzel: Projekt/Session. Alle anderen Tabellen hängen per ON DELETE CASCADE daran.
CREATE TABLE IF NOT EXISTS sessions (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                          VARCHAR(255) NOT NULL,
    created_by                    VARCHAR(255) NOT NULL,
    created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    comments_hidden_for_reviewers BOOLEAN      NOT NULL DEFAULT false   -- 020
);

-- 1:1 zu sessions: der persistierte Yjs-Dokument-Snapshot.
CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content_snapshot BYTEA,
    version          INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_session_id_unique UNIQUE (session_id)          -- 004 (liefert den Index)
);

-- Versionsverlauf (M7). snapshot-Spalte aus 001 wurde in 006 entfernt.
CREATE TABLE IF NOT EXISTS history (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id      VARCHAR(255) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version_number INTEGER NOT NULL DEFAULT 0,                          -- 003
    content        TEXT    NOT NULL DEFAULT '',                         -- 003
    name           TEXT,                                                -- 022: benannter Stand (NULL bei Auto-Slots)
    scope          VARCHAR(16) NOT NULL DEFAULT 'session',              -- 022: 'session' | 'personal'
    kind           VARCHAR(16) NOT NULL DEFAULT 'manual',               -- 022: 'manual' | 'auto'
    model_json     JSONB,                                               -- 024: {nodes,edges} (M11); NULL = reine Textversion
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),                  -- 031
    CONSTRAINT history_scope_chk CHECK (scope IN ('session', 'personal')),
    CONSTRAINT history_kind_chk  CHECK (kind  IN ('manual', 'auto'))
);

-- Peer-Review (vor comments, da comments.review_id darauf zeigt).
-- Spalten-Reihenfolge spiegelt die Migrationshistorie (requester_id/version_id nachträglich angehängt).
CREATE TABLE IF NOT EXISTS reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status       VARCHAR(50) NOT NULL DEFAULT 'offen'
                 CHECK (status IN ('offen', 'in_review', 'abgeschlossen')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requester_id VARCHAR(255) NOT NULL,                                 -- 002 add → 007 NOT NULL
    version_id   UUID REFERENCES history(id) ON DELETE SET NULL,        -- 008
    audience     VARCHAR(10) NOT NULL DEFAULT 'all'                     -- 027: 'all' | 'selected'
                 CHECK (audience IN ('all', 'selected'))
    -- 027: reviewer_id + feedback ENTFERNT → Reviewer/Feedback stehen in review_feedback (Multi-Reviewer).
);

-- 027: gezielt angefragte Reviewer (nur bei audience='selected').
CREATE TABLE IF NOT EXISTS review_assignees (
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id   VARCHAR(255) NOT NULL,
    PRIMARY KEY (review_id, user_id)
);

-- 027: je Reviewer ein eigenes Feedback (Multi-Reviewer).
CREATE TABLE IF NOT EXISTS review_feedback (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id  UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    author_id  VARCHAR(255) NOT NULL,
    feedback   TEXT NOT NULL,
    verdict    VARCHAR(20) CHECK (verdict IS NULL OR verdict IN ('approved', 'changes_requested', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (review_id, author_id)
);

-- 026: privates Arbeitsmodell (Entwurf) je (Session, Nutzer).
CREATE TABLE IF NOT EXISTS session_drafts (
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id    VARCHAR(255) NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    model_json    JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    base_snapshot JSONB,                                                 -- 030: geteilter Stand, auf dem der Entwurf aufbaut (Publish-Gate)
    PRIMARY KEY (session_id, user_id)
);

-- Kommentare/Threads (M8/M18/M23).
CREATE TABLE IF NOT EXISTS comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id   VARCHAR(255) NOT NULL,
    content     TEXT NOT NULL,
    position    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parent_id   UUID REFERENCES comments(id) ON DELETE CASCADE,         -- 010 (Antworten, eine Ebene)
    resolved_at TIMESTAMPTZ,                                            -- 010
    resolved_by VARCHAR(255),                                           -- 010
    review_id   UUID REFERENCES reviews(id) ON DELETE SET NULL,         -- 013
    node_id     VARCHAR(255)                                             -- 029: an einen Modell-Knoten geheftet (M11)
);

-- M17: dauerhafte Benachrichtigungen ("Briefkasten").
CREATE TABLE IF NOT EXISTS notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    VARCHAR(255) NOT NULL,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    type       VARCHAR(50) NOT NULL,
    ref_id     UUID,
    data       JSONB,          -- optionale Zusatzinfos je Typ (z.B. { actor, versionName } bei 'load')
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- M17-Extra: "seit deinem letzten Besuch".
CREATE TABLE IF NOT EXISTS session_views (
    user_id      VARCHAR(255) NOT NULL,
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, session_id)
);

-- N1: Mitgliedschaft + Rolle (CHECK aus 017).
CREATE TABLE IF NOT EXISTS session_members (
    session_id UUID         NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id    VARCHAR(255) NOT NULL,
    role       VARCHAR(20)  NOT NULL DEFAULT 'member',
    added_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id),
    CONSTRAINT session_members_role_chk
        CHECK (role IN ('owner', 'member', 'commentator', 'spectator')) -- 017 → 025 (umbenannt)
);

-- Punkt 3: nachlesbarer Schicht-2-Change-Feed (+ why aus 018).
CREATE TABLE IF NOT EXISTS change_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    who_user_id  VARCHAR(255) NOT NULL,
    who_name     VARCHAR(255),
    what         VARCHAR(16)  NOT NULL,                                 -- Text: insert|delete|format · Modell: node.*/edge.*/field.changed
    where_index  INTEGER,                                               -- 023: nullable (NULL bei Modell-Events)
    where_length INTEGER,                                               -- 023: nullable
    severity     VARCHAR(16),                                           -- NULL = Feed; info|warning = Konflikt
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    why_kind     VARCHAR(16),                                           -- 018: 'comment' | 'review'
    why_ref      UUID,                                                  -- 018
    target       VARCHAR(8) NOT NULL DEFAULT 'text',                    -- 023: 'text' | 'model'
    where_element VARCHAR(255),                                         -- 023: elementId (Knoten)
    where_edge    VARCHAR(255),                                         -- 023: edgeId (Kante)
    where_field   VARCHAR(255)                                          -- 023: geändertes Feld
);

-- C5: Session-Chat-Verlauf.
CREATE TABLE IF NOT EXISTS chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id    VARCHAR(255) NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- H7: Aufgaben-/Zuständigkeits-Ebene.
CREATE TABLE IF NOT EXISTS session_tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    description      TEXT,
    assignee_user_id VARCHAR(255),
    status           VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'in_progress', 'done')),
    created_by       VARCHAR(255) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indizes (End-Stand nach Bereinigung in 009) ─────────────────────────────
-- documents: kein eigener session_id-Index — der UNIQUE-Constraint liefert ihn.
CREATE INDEX IF NOT EXISTS idx_history_session_id        ON history(session_id);
CREATE INDEX IF NOT EXISTS idx_history_version           ON history(session_id, version_number);
CREATE INDEX IF NOT EXISTS idx_history_bucket            ON history(session_id, scope, author_id, kind);  -- 022
CREATE INDEX IF NOT EXISTS idx_review_feedback_review    ON review_feedback(review_id);                    -- 027
CREATE INDEX IF NOT EXISTS idx_review_assignees_user     ON review_assignees(user_id);                     -- 028
CREATE INDEX IF NOT EXISTS idx_reviews_session_id        ON reviews(session_id);
CREATE INDEX IF NOT EXISTS idx_reviews_version_id        ON reviews(version_id);
CREATE INDEX IF NOT EXISTS idx_comments_session_id       ON comments(session_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent           ON comments(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_review           ON comments(review_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_session_members_user      ON session_members(user_id);
CREATE INDEX IF NOT EXISTS idx_change_log_session_time   ON change_log(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_session_time         ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_tasks_session     ON session_tasks(session_id);
