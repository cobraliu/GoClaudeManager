// Package store owns the SQLite database connection and all persistence.
//
// Design notes (see docs/Go后端重构方案.md §4.2):
//   - WAL journal mode so readers never block on the single writer.
//   - database/sql connection pool for concurrent reads; a process-wide write
//     mutex serializes read-modify-write sequences (mirrors the Python store's
//     global Lock and SQLite's single-writer rule).
//   - Schema + auto-migrations are byte-identical to app/services/session_store.py,
//     so an existing data.db opens unchanged and a fresh one ends up identical.
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/loki/goclaudemanager/internal/model"
	_ "modernc.org/sqlite" // pure-Go SQLite driver (no CGO)
)

// schema mirrors session_store._SCHEMA (base tables + indexes).
const schema = `
CREATE TABLE IF NOT EXISTS configs (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    command     TEXT NOT NULL,
    run_at      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL,
    sent_at     TEXT,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON scheduled_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_run ON scheduled_tasks(status, run_at);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    env TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'creating',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    attached_clients INTEGER NOT NULL DEFAULT 0,
    last_output_offset INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT,
    ws_token TEXT,
    tmux_session_name TEXT NOT NULL,
    resume_session_id TEXT,
    agent_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
-- GetAllAgentSessionIDs filters by agent_session_id IS NOT NULL on read-heavy
-- conversation paths (resolveChatSID, subagents, external-session browsing);
-- without this index that is a full table scan on every such request.
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_session_id);
CREATE TABLE IF NOT EXISTS session_views (
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_viewed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS prompt_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    sent_at    REAL NOT NULL,
    pane       TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompt_history_session ON prompt_history(session_id, sent_at DESC);
CREATE TABLE IF NOT EXISTS prompt_history_backfill (
    session_id   TEXT PRIMARY KEY,
    completed_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
    hash             TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    owner_id         TEXT NOT NULL,
    share_type       TEXT NOT NULL,
    cutoff_ts        REAL,
    cutoff_msg_uuid  TEXT,
    cutoff_msg_text  TEXT,
    created_at       REAL NOT NULL,
    expires_at       REAL NOT NULL,
    default_theme    TEXT NOT NULL DEFAULT 'light'
);
CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
CREATE TABLE IF NOT EXISTS users (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL DEFAULT '',
    salt           TEXT NOT NULL DEFAULT '',
    role           TEXT NOT NULL DEFAULT 'user',
    is_admin       INTEGER NOT NULL DEFAULT 0,
    google_email   TEXT
);
`

// migrations are the additive ALTERs from session_store.__init__. Each is run
// independently; "duplicate column" errors are expected on an already-migrated
// DB and ignored, exactly like the Python try/except OperationalError pattern.
var migrations = []string{
	`ALTER TABLE sessions RENAME COLUMN claude_session_id TO agent_session_id`,
	`ALTER TABLE sessions ADD COLUMN agent_session_id TEXT`,
	`ALTER TABLE sessions ADD COLUMN claude_proc_pid INTEGER`,
	`ALTER TABLE sessions ADD COLUMN last_activity_at TEXT`,
	`ALTER TABLE sessions ADD COLUMN git_auto_commit INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE sessions ADD COLUMN git_commit_msg_count INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE sessions ADD COLUMN git_repo_url TEXT`,
	`ALTER TABLE sessions ADD COLUMN last_turn_at TEXT`,
	`ALTER TABLE sessions ADD COLUMN tool TEXT NOT NULL DEFAULT 'claude'`,
	`ALTER TABLE sessions ADD COLUMN codex_transport TEXT NOT NULL DEFAULT 'tui'`,
	`ALTER TABLE sessions ADD COLUMN codex_appserver_pid INTEGER`,
	`ALTER TABLE sessions ADD COLUMN codex_appserver_port INTEGER`,
	`ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'tmux'`,
	`ALTER TABLE scheduled_tasks ADD COLUMN loop_seconds INTEGER`,
	`ALTER TABLE shares ADD COLUMN default_theme TEXT NOT NULL DEFAULT 'light'`,
	`ALTER TABLE shares ADD COLUMN file_access TEXT`,
}

// Store wraps the *sql.DB handle to data.db plus a write mutex.
type Store struct {
	DB   *sql.DB
	Path string
	// wmu serializes read-modify-write sequences. Plain reads don't take it
	// (WAL allows concurrent readers).
	wmu sync.Mutex

	// lost holds the in-memory "send failed" registry, keyed by session id.
	// It is deliberately not persisted: lost messages are ephemeral attention
	// items that are safe to drop on restart. See lost_messages.go.
	lostMu sync.Mutex
	lost   map[string][]model.LostMessage
	lostN  uint64
}

// Open resolves the data.db path (mirroring config._db_file), opens it with WAL
// + sane pragmas, applies the schema and migrations, and returns the Store.
func Open() (*Store, error) {
	dbPath, err := resolveDBPath()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dsn := "file:" + dbPath +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=synchronous(NORMAL)"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	s := &Store{DB: db, Path: dbPath}
	if err := s.bootstrap(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) bootstrap() error {
	if _, err := s.DB.Exec(schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	for _, m := range migrations {
		if _, err := s.DB.Exec(m); err != nil {
			// Expected for already-applied migrations: duplicate column / no
			// such column (rename target absent). Mirror Python's swallow.
			if isMigrationNoop(err) {
				continue
			}
			return fmt.Errorf("migration %q: %w", m, err)
		}
	}
	return nil
}

func isMigrationNoop(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column") ||
		strings.Contains(msg, "no such column") ||
		strings.Contains(msg, "no such table")
}

// Close releases the database handle.
func (s *Store) Close() error {
	if s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

// resolveDBPath mirrors Python config._db_file():
//   - $CLAUDEMANAGER_DATA_DIR set → <dir>/data.db
//   - else dev layout → ./data/data.db relative to the working directory
func resolveDBPath() (string, error) {
	if dir := os.Getenv("CLAUDEMANAGER_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "data.db"), nil
	}
	return filepath.Join("data", "data.db"), nil
}
