package api

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/loki/goclaudemanager/internal/model"
)

// This file adds transcript-download endpoints for the conversation view:
//
//	GET /{id}/conversation/download   — the single <sid>.jsonl transcript
//	GET /{id}/conversation/bundle     — a zip of <sid>.jsonl + the sibling
//	                                    <sid>/ dir + the project memory/ dir
//
// Both are owner-scoped (resolveOwned). The bundle skips any root that does not
// exist on disk, so a session with no sibling/memory dir still downloads just
// the transcript.

// resolveTranscriptRoots locates a session's transcript plus the optional
// sibling "<sid>/" directory (subagents / tool-results) and the project
// "memory/" directory. Any root absent on disk comes back as "". ok is false
// when no transcript resolves at all (no turn yet / file gone).
func resolveTranscriptRoots(d Deps, s *model.Session) (jsonlPath, siblingDir, memoryDir, chatSID string, ok bool) {
	chatSID = resolveChatSID(d, s)
	if chatSID == "" {
		return "", "", "", "", false
	}
	jsonlPath = resolveJSONLPath(s.Tool, chatSID, s.Cwd)
	if jsonlPath == "" {
		return "", "", "", "", false
	}
	if sib := filepath.Join(filepath.Dir(jsonlPath), chatSID); sib != "" {
		if fi, err := os.Stat(sib); err == nil && fi.IsDir() {
			siblingDir = sib
		}
	}
	memoryDir = memoryResolveDir(s.Cwd) // already "" when the dir is missing
	return jsonlPath, siblingDir, memoryDir, chatSID, true
}

// attachmentDisposition sets a UTF-8 attachment filename (RFC 5987), mirroring
// the encoding used by serveFileContent (files.go).
func attachmentDisposition(w http.ResponseWriter, name string) {
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
}

// GET /{id}/conversation/download — stream the raw <sid>.jsonl as an attachment.
func conversationDownload(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	jsonlPath, _, _, chatSID, ok := resolveTranscriptRoots(d, s)
	if !ok {
		writeErr(w, http.StatusNotFound, "no "+s.Tool+" session")
		return
	}
	f, err := os.Open(jsonlPath)
	if err != nil {
		writeErr(w, http.StatusNotFound, "jsonl file not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	name := chatSID + ".jsonl"
	w.Header().Set("Content-Type", "application/x-ndjson")
	attachmentDisposition(w, name)
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// GET /{id}/conversation/bundle — stream a zip of the transcript plus its
// sibling <sid>/ dir and the project memory/ dir (each skipped when absent).
func conversationBundle(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	jsonlPath, siblingDir, memoryDir, chatSID, ok := resolveTranscriptRoots(d, s)
	if !ok {
		writeErr(w, http.StatusNotFound, "no "+s.Tool+" session")
		return
	}

	// Build the file list and enforce the size cap before writing any bytes, so
	// an oversize bundle returns a clean 413 instead of a truncated stream.
	type zipItem struct{ full, rel string }
	var items []zipItem
	var total int64
	addFile := func(full, rel string) {
		fi, err := os.Stat(full)
		if err != nil || !fi.Mode().IsRegular() {
			return
		}
		total += fi.Size()
		items = append(items, zipItem{full, rel})
	}
	addDir := func(dir, prefix string) {
		if dir == "" {
			return
		}
		_ = filepath.WalkDir(dir, func(p string, de os.DirEntry, err error) error {
			if err != nil || de.IsDir() {
				return nil
			}
			rel, rerr := filepath.Rel(dir, p)
			if rerr != nil {
				return nil
			}
			addFile(p, filepath.ToSlash(filepath.Join(prefix, rel)))
			return nil
		})
	}

	addFile(jsonlPath, chatSID+".jsonl")
	addDir(siblingDir, chatSID)
	addDir(memoryDir, "memory")

	if total > filesDownloadMax {
		writeErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("bundle too large (%dMB > %dMB)", total/1024/1024, filesDownloadMax/1024/1024))
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	attachmentDisposition(w, chatSID+"-bundle.zip")
	zw := zip.NewWriter(w)
	for _, it := range items {
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: it.rel, Method: zip.Deflate})
		if err != nil {
			continue
		}
		f, oerr := os.Open(it.full)
		if oerr != nil {
			continue
		}
		_, _ = io.Copy(fw, f)
		f.Close()
	}
	_ = zw.Close()
}
