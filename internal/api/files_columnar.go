package api

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/apache/arrow-go/v18/arrow/memory"
	"github.com/apache/arrow-go/v18/parquet/file"
	"github.com/apache/arrow-go/v18/parquet/pqarrow"
)

// Columnar (parquet / arrow-IPC) table preview. Mirrors the sqlite viewer:
// returns {columns, rows, total} for a window of rows, rendered as a table by
// the frontend ColumnarViewer. Both formats are decoded through Apache Arrow —
// parquet via pqarrow, arrow files via the IPC reader — and every cell is
// stringified with arrow.Array.ValueStr so the response shape is uniform.

const (
	// filesColumnarRowLimit caps rows returned per request (matches the sqlite
	// viewer's page ceiling).
	filesColumnarRowLimit = 500
	// filesColumnarMaxBytes rejects files too large to decode for a preview.
	// Parquet/arrow are columnar and a preview only needs the first rows, but
	// decoding still buffers row groups/batches, so we refuse outright above
	// this to protect memory.
	filesColumnarMaxBytes = 256 << 20 // 256 MiB
)

var (
	filesParquetExts = map[string]struct{}{".parquet": {}, ".pq": {}}
	filesArrowExts   = map[string]struct{}{".arrow": {}, ".feather": {}, ".ipc": {}}
)

// filesColumnarKind reports "parquet", "arrow", or "" for a filename.
func filesColumnarKind(name string) string {
	ext := filesExtLower(name)
	if _, ok := filesParquetExts[ext]; ok {
		return "parquet"
	}
	if _, ok := filesArrowExts[ext]; ok {
		return "arrow"
	}
	return ""
}

func fsColumnarQuery(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 1
	}
	if limit > filesColumnarRowLimit {
		limit = filesColumnarRowLimit
	}
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}

	target, ok := filesResolve(w, s.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	kind := filesColumnarKind(filepath.Base(target))
	if kind == "" {
		writeErr(w, http.StatusUnsupportedMediaType, "not a parquet or arrow file")
		return
	}
	if info.Size() > filesColumnarMaxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large to preview (limit 256 MiB)")
		return
	}

	var (
		cols  []string
		rows  [][]any
		total int
	)
	switch kind {
	case "parquet":
		cols, rows, total, err = readParquetWindow(target, offset, limit)
	case "arrow":
		cols, rows, total, err = readArrowWindow(target, offset, limit)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot read "+kind+": "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"columns": nonNilSlice(cols),
		"rows":    rows,
		"total":   total,
		"format":  kind,
		"path":    filesRelTo(s.Cwd, target),
	})
}

// readParquetWindow decodes columns + the [offset, offset+limit) row window of a
// parquet file. total comes free from file metadata, so the scan stops early
// once the window is filled.
func readParquetWindow(target string, offset, limit int) (cols []string, rows [][]any, total int, err error) {
	pf, err := file.OpenParquetFile(target, false)
	if err != nil {
		return nil, nil, 0, err
	}
	defer pf.Close()
	total = int(pf.NumRows())

	fr, err := pqarrow.NewFileReader(pf, pqarrow.ArrowReadProperties{BatchSize: 1024}, memory.DefaultAllocator)
	if err != nil {
		return nil, nil, 0, err
	}
	sch, err := fr.Schema()
	if err != nil {
		return nil, nil, 0, err
	}
	cols = schemaFieldNames(sch)

	rr, err := fr.GetRecordReader(context.Background(), nil, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	defer rr.Release()

	rows, _, err = paginateRecords(func() (arrow.Record, error) { return rr.Read() }, offset, limit, total)
	return cols, rows, total, err
}

// readArrowWindow decodes an Arrow IPC (file format, a.k.a. Feather v2) file. The
// total row count isn't in a cheap header, so the records are scanned fully (the
// size cap bounds this); only the requested window is materialised into values.
func readArrowWindow(target string, offset, limit int) (cols []string, rows [][]any, total int, err error) {
	f, err := os.Open(target)
	if err != nil {
		return nil, nil, 0, err
	}
	defer f.Close()

	rdr, err := ipc.NewFileReader(f, ipc.WithAllocator(memory.DefaultAllocator))
	if err != nil {
		return nil, nil, 0, err
	}
	defer rdr.Close()
	cols = schemaFieldNames(rdr.Schema())

	n := rdr.NumRecords()
	i := 0
	next := func() (arrow.Record, error) {
		if i >= n {
			return nil, io.EOF
		}
		rec, e := rdr.RecordAt(i)
		i++
		return rec, e
	}
	// total is accumulated by the full scan (knownTotal < 0).
	rows, total, err = paginateRecords(next, offset, limit, -1)
	return cols, rows, total, err
}

// paginateRecords walks a stream of Arrow record batches and materialises the
// rows that fall in [offset, offset+limit) into stringified values. When
// knownTotal >= 0 it is returned as the total and the walk stops once the window
// is filled; otherwise every batch is consumed to count rows. The caller's
// `next` returns io.EOF (or a nil record) at end of stream.
func paginateRecords(next func() (arrow.Record, error), offset, limit, knownTotal int) ([][]any, int, error) {
	rows := make([][]any, 0, limit)
	cur := 0
	for {
		if knownTotal >= 0 && cur >= offset+limit {
			break // window filled and total already known; stop early
		}
		rec, err := next()
		if err == io.EOF || rec == nil {
			break
		}
		if err != nil {
			return nil, 0, err
		}
		n := int(rec.NumRows())
		lo := offset
		if cur > lo {
			lo = cur
		}
		hi := offset + limit
		if cur+n < hi {
			hi = cur + n
		}
		for gr := lo; gr < hi; gr++ {
			rows = append(rows, recordRowValues(rec, gr-cur))
		}
		cur += n
		rec.Release()
	}
	total := knownTotal
	if total < 0 {
		total = cur
	}
	return rows, total, nil
}

// recordRowValues stringifies one row of an Arrow record. NULLs become JSON null;
// every other value uses the column's ValueStr so all types share one path.
func recordRowValues(rec arrow.Record, row int) []any {
	ncol := int(rec.NumCols())
	out := make([]any, ncol)
	for c := 0; c < ncol; c++ {
		col := rec.Column(c)
		if col.IsNull(row) {
			out[c] = nil
		} else {
			out[c] = col.ValueStr(row)
		}
	}
	return out
}

func schemaFieldNames(sch *arrow.Schema) []string {
	fields := sch.Fields()
	names := make([]string, len(fields))
	for i, f := range fields {
		names[i] = f.Name
	}
	return names
}
