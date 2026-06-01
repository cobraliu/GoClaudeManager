// Package obs provides observability helpers (structured logging).
package obs

import (
	"log/slog"
	"os"
	"strings"
)

// Setup installs a process-wide structured logger. Level is controlled by the
// LOG_LEVEL env var (debug|info|warn|error); defaults to info.
func Setup() *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	logger := slog.New(h)
	slog.SetDefault(logger)
	return logger
}
