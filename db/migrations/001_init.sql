-- ============================================================================
-- 001_init.sql — konsolidiertes End-Schema (ersetzt Migrationen 001–031).
-- Enthält den finalen Stand OHNE session_participants (entfernt: Yjs-Awareness-Duplikat).
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS sessions (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                          VARCHAR(255) NOT NULL,
    created_by                    VARCHAR(255) NOT NULL,
    created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    comments_hidden_for_reviewers BOOLEAN      NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content_snapshot BYTEA,
    version          INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_session_id_unique UNIQUE (session_id)
);

CREATE TABLE IF NOT EXISTS history (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id      VARCHAR(255) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version_number INTEGER NOT NULL DEFAULT 0,
    content        TEXT    NOT NULL DEFAULT '',
    name           TEXT,
    scope          VARCHAR(16) NOT NULL DEFAULT 'session',
    kind           VARCHAR(16) NOT NULL DEFAULT 'manual',
    model_json     JSONB,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT history_scope_chk CHECK (scope IN ('session', 'personal')),
    CONSTRAINT history_kind_chk  CHECK (kind  IN ('manual', 'auto'))
);

CREATE TABLE IF NOT EXISTS reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status       VARCHAR(50) NOT NULL DEFAULT 'offen'
                 CHECK (status IN ('offen', 'in_review', 'abgeschlossen')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requester_id VARCHAR(255) NOT NULL,
    version_id   UUID REFERENCES history(id) ON DELETE SET NULL,
    audience     VARCHAR(10) NOT NULL DEFAULT 'all'
                 CHECK (audience IN ('all', 'selected'))
);

CREATE TABLE IF NOT EXISTS review_assignees (
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id   VARCHAR(255) NOT NULL,
    PRIMARY KEY (review_id, user_id)
);

CREATE TABLE IF NOT EXISTS review_feedback (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id  UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    author_id  VARCHAR(255) NOT NULL,
    feedback   TEXT NOT NULL,
    verdict    VARCHAR(20) CHECK (verdict IS NULL OR verdict IN ('approved', 'changes_requested', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (review_id, author_id)
);

CREATE TABLE IF NOT EXISTS session_drafts (
    session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id       VARCHAR(255) NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    model_json    JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    base_snapshot JSONB,
    PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id   VARCHAR(255) NOT NULL,
    content     TEXT NOT NULL,
    position    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parent_id   UUID REFERENCES comments(id) ON DELETE CASCADE,
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(255),
    review_id   UUID REFERENCES reviews(id) ON DELETE SET NULL,
    node_id     VARCHAR(255)
);

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

CREATE TABLE IF NOT EXISTS session_views (
    user_id      VARCHAR(255) NOT NULL,
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_members (
    session_id UUID         NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id    VARCHAR(255) NOT NULL,
    role       VARCHAR(20)  NOT NULL DEFAULT 'member',
    added_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id),
    CONSTRAINT session_members_role_chk
        CHECK (role IN ('owner', 'member', 'commentator', 'spectator'))
);

CREATE TABLE IF NOT EXISTS change_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    who_user_id  VARCHAR(255) NOT NULL,
    who_name     VARCHAR(255),
    what         VARCHAR(16)  NOT NULL,
    where_index  INTEGER,
    where_length INTEGER,
    severity     VARCHAR(16),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    why_kind     VARCHAR(16),
    why_ref      UUID,
    target       VARCHAR(8) NOT NULL DEFAULT 'text',
    where_element VARCHAR(255),
    where_edge    VARCHAR(255),
    where_field   VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id    VARCHAR(255) NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ── Indizes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_history_session_id        ON history(session_id);
CREATE INDEX IF NOT EXISTS idx_history_version           ON history(session_id, version_number);
CREATE INDEX IF NOT EXISTS idx_history_bucket            ON history(session_id, scope, author_id, kind);
CREATE INDEX IF NOT EXISTS idx_review_feedback_review    ON review_feedback(review_id);
CREATE INDEX IF NOT EXISTS idx_review_assignees_user     ON review_assignees(user_id);
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
