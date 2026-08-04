-- Seed: feste Test-Sessions mit STABILEN UUIDs + vorgefertigte Nutzer.
-- Zweck: nach einer frischen DB (docker compose down -v) einmal einspielen → die
-- Test-Links bleiben IMMER gleich (Session-IDs sind hier fix statt zufällig).
-- Idempotent: beliebig oft ausführbar (ON CONFLICT), überschreibt nur die Rollen.
--
-- GETRENNT PRO TOOL, damit sich M10- und M11-Daten (Verlauf, Kommentare, Chat,
-- Reviews, Draft = rein session_id-basiert) NICHT vermischen:
--   ID beginnt mit 10… = M10 (Playground, ?user=) · 11… = M11 (Modeling, ?devUser=)
--   Wiederhol-Ziffer = Session-Nr (1 Rollen-Test · 2 Team A · 3 Team B)
-- Jede Komposition gibt es als M10- UND M11-Zwilling mit IDENTISCHEN Nutzern/Rollen.
-- Namen sind case-sensitive (?devUser=Alice ≠ alice) — genau so öffnen.

-- ── Sessions anlegen (created_by = jeweiliger owner) ───────────────────────
INSERT INTO sessions (id, name, created_by) VALUES
  ('10111111-1111-1111-1111-111111111111', 'M10 · Rollen-Test', 'alice'),
  ('11111111-1111-1111-1111-111111111111', 'M11 · Rollen-Test', 'alice'),
  ('10222222-2222-2222-2222-222222222222', 'M10 · Team A',      'erin'),
  ('11222222-2222-2222-2222-222222222222', 'M11 · Team A',      'erin'),
  ('10333333-3333-3333-3333-333333333333', 'M10 · Team B',      'niaj'),
  ('11333333-3333-3333-3333-333333333333', 'M11 · Team B',      'niaj')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- ── Session 1 — Rollen-Test (4 Nutzer): alice owner, bob member, carol comm, dave spec
INSERT INTO session_members (session_id, user_id, role) VALUES
  ('10111111-1111-1111-1111-111111111111', 'alice', 'owner'),
  ('10111111-1111-1111-1111-111111111111', 'bob',   'member'),
  ('10111111-1111-1111-1111-111111111111', 'carol', 'commentator'),
  ('10111111-1111-1111-1111-111111111111', 'dave',  'spectator'),
  ('11111111-1111-1111-1111-111111111111', 'alice', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bob',   'member'),
  ('11111111-1111-1111-1111-111111111111', 'carol', 'commentator'),
  ('11111111-1111-1111-1111-111111111111', 'dave',  'spectator')
ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- ── Session 2 — Team A (7 Nutzer): erin owner + 4 member + judy spec + mallory comm
INSERT INTO session_members (session_id, user_id, role) VALUES
  ('10222222-2222-2222-2222-222222222222', 'erin',    'owner'),
  ('10222222-2222-2222-2222-222222222222', 'frank',    'member'),
  ('10222222-2222-2222-2222-222222222222', 'grace',   'member'),
  ('10222222-2222-2222-2222-222222222222', 'heidi',  'member'),
  ('10222222-2222-2222-2222-222222222222', 'ivan', 'member'),
  ('10222222-2222-2222-2222-222222222222', 'judy',  'spectator'),
  ('10222222-2222-2222-2222-222222222222', 'mallory',    'commentator'),
  ('11222222-2222-2222-2222-222222222222', 'erin',    'owner'),
  ('11222222-2222-2222-2222-222222222222', 'frank',    'member'),
  ('11222222-2222-2222-2222-222222222222', 'grace',   'member'),
  ('11222222-2222-2222-2222-222222222222', 'heidi',  'member'),
  ('11222222-2222-2222-2222-222222222222', 'ivan', 'member'),
  ('11222222-2222-2222-2222-222222222222', 'judy',  'spectator'),
  ('11222222-2222-2222-2222-222222222222', 'mallory',    'commentator')
ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- ── Session 3 — Team B (9 Nutzer): niaj owner + erin/5 member + olivia + judy spec + mallory comm
INSERT INTO session_members (session_id, user_id, role) VALUES
  ('10333333-3333-3333-3333-333333333333', 'niaj',       'owner'),
  ('10333333-3333-3333-3333-333333333333', 'erin',       'member'),
  ('10333333-3333-3333-3333-333333333333', 'frank',       'member'),
  ('10333333-3333-3333-3333-333333333333', 'grace',      'member'),
  ('10333333-3333-3333-3333-333333333333', 'heidi',     'member'),
  ('10333333-3333-3333-3333-333333333333', 'ivan',    'member'),
  ('10333333-3333-3333-3333-333333333333', 'olivia', 'member'),
  ('10333333-3333-3333-3333-333333333333', 'judy',     'spectator'),
  ('10333333-3333-3333-3333-333333333333', 'mallory',       'commentator'),
  ('11333333-3333-3333-3333-333333333333', 'niaj',       'owner'),
  ('11333333-3333-3333-3333-333333333333', 'erin',       'member'),
  ('11333333-3333-3333-3333-333333333333', 'frank',       'member'),
  ('11333333-3333-3333-3333-333333333333', 'grace',      'member'),
  ('11333333-3333-3333-3333-333333333333', 'heidi',     'member'),
  ('11333333-3333-3333-3333-333333333333', 'ivan',    'member'),
  ('11333333-3333-3333-3333-333333333333', 'olivia', 'member'),
  ('11333333-3333-3333-3333-333333333333', 'judy',     'spectator'),
  ('11333333-3333-3333-3333-333333333333', 'mallory',       'commentator')
ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role;
