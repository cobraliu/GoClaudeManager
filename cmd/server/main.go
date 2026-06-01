// Command server is the GoClaudeManager backend entry point.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/loki/goclaudemanager/internal/app"
	"github.com/loki/goclaudemanager/internal/obs"
)

func main() {
	obs.Setup()

	a, err := app.New()
	if err != nil {
		slog.Error("startup failed", "err", err)
		os.Exit(1)
	}
	defer a.Close()

	srv := a.Server()

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Launch background loops (status snapshot, etc.).
	a.Start(ctx)

	go func() {
		slog.Info("listening", "addr", srv.Addr, "root_path", a.Env.RootPath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
}
