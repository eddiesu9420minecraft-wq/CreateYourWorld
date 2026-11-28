-- CYW Feedback Center: initial schema (D1 / SQLite).
-- Tokens (sessions and service tokens) are stored only as SHA-256 hex digests.
-- All times are Unix seconds.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  github_id         INTEGER UNIQUE,
  login             TEXT NOT NULL,
  login_lc          TEXT NOT NULL UNIQUE,
  avatar_url        TEXT,
  github_created_at INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,               -- SHA-256 hex of the bearer token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE service_tokens (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('agent', 'cyws')),
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256 hex of the bearer token
  created_by TEXT NOT NULL,                   -- users.id of the maintainer
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE roles (
  login_lc   TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user', 'developer', 'maintainer')),
  granted_by TEXT,
  granted_at INTEGER NOT NULL
);

CREATE TABLE bans (
  login_lc   TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  banned_by  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE feedback (
  id            TEXT PRIMARY KEY,
  number        INTEGER NOT NULL UNIQUE,
  product       TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'performance', 'compatibility', 'general')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  body_hash     TEXT NOT NULL,                -- SHA-256 of the normalised body (duplicate detection)
  environment   TEXT,                         -- JSON, only when consent.environment = true
  consent       TEXT NOT NULL,                -- JSON
  author_id     TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'triaged', 'in_progress', 'fixed', 'released', 'closed')),
  resolution    TEXT CHECK (resolution IS NULL OR resolution IN ('completed', 'duplicate', 'wont_fix', 'invalid', 'spam')),
  votes         INTEGER NOT NULL DEFAULT 0,
  comments      INTEGER NOT NULL DEFAULT 0,
  assignee_id   TEXT REFERENCES users(id),
  labels        TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  duplicate_of  TEXT,
  fixed_in      TEXT,
  github_repo   TEXT,
  github_number INTEGER,
  github_url    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_feedback_product ON feedback(product);
CREATE INDEX idx_feedback_status ON feedback(status);
CREATE INDEX idx_feedback_author ON feedback(author_id, created_at);
CREATE INDEX idx_feedback_votes ON feedback(votes DESC, created_at DESC);
CREATE INDEX idx_feedback_created ON feedback(created_at DESC);
CREATE INDEX idx_feedback_updated ON feedback(updated_at DESC);
CREATE INDEX idx_feedback_dup ON feedback(author_id, body_hash, created_at);
CREATE UNIQUE INDEX idx_feedback_github ON feedback(github_repo, github_number) WHERE github_number IS NOT NULL;

CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  feedback_id       TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author_id         TEXT REFERENCES users(id),  -- NULL for comments that came from GitHub
  body              TEXT NOT NULL,
  official          INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'cyw' CHECK (source IN ('cyw', 'github')),
  github_author     TEXT,
  github_comment_id INTEGER,
  hidden            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_comments_feedback ON comments(feedback_id, created_at);
CREATE UNIQUE INDEX idx_comments_github ON comments(github_comment_id) WHERE github_comment_id IS NOT NULL;

CREATE TABLE votes (
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, user_id)
);
CREATE INDEX idx_votes_user ON votes(user_id);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  uploader_id  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachments_feedback ON attachments(feedback_id);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('status', 'assign', 'github_linked', 'release', 'task')),
  actor_id    TEXT REFERENCES users(id),     -- NULL for GitHub / service actions
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_feedback ON events(feedback_id, created_at);

CREATE TABLE subscriptions (
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, user_id)
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('reply', 'status', 'released')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  feedback_id     TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  product         TEXT NOT NULL,
  repo            TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'wont_do')),
  assignee_id     TEXT REFERENCES users(id),
  agent_allowed   INTEGER NOT NULL DEFAULT 0,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'cyws')),
  created_by_id   TEXT NOT NULL,              -- users.id or service_tokens.id
  created_by_name TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_feedback ON tasks(feedback_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);

CREATE TABLE task_analysis (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'cyws')),
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_task_analysis_task ON task_analysis(task_id, created_at);

CREATE TABLE task_prs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  repo          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  added_by_kind TEXT NOT NULL CHECK (added_by_kind IN ('user', 'agent', 'cyws')),
  added_by_name TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (task_id, url)
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,              -- <bucket>:<window seconds>:<principal key>
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

CREATE TABLE webhook_deliveries (
  id          TEXT PRIMARY KEY,               -- X-GitHub-Delivery
  event       TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
