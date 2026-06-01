package api

import (
	"sync"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
)

// shareCache is an in-memory cache of currently-valid conversation shares.
//
// The public share viewer hits this cache on every paginated request, so it
// stays hot and avoids a DB round-trip per page. The durable copy lives in the
// `shares` table; this cache is warmed at startup (Load), kept in sync by the
// authed create/delete endpoints (Put/Remove) plus the periodic cleanup loop
// (PurgeExpired). A lookup of an expired entry is evicted lazily on read.
//
// Mirrors app/services/share_cache.py ShareCache.
type shareCache struct {
	mu sync.Mutex
	d  map[string]*model.ShareRecord
}

func newShareCache() *shareCache {
	return &shareCache{d: map[string]*model.ShareRecord{}}
}

// Load replaces the cache contents with records (typically warmed from
// Store.ListActiveShares at startup).
func (c *shareCache) Load(records []*model.ShareRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.d = make(map[string]*model.ShareRecord, len(records))
	for _, r := range records {
		c.d[r.Hash] = r
	}
}

// Put inserts or updates a share.
func (c *shareCache) Put(r *model.ShareRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.d[r.Hash] = r
}

// Remove evicts a share by hash.
func (c *shareCache) Remove(hash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.d, hash)
}

// Get returns the share if present and not expired, evicting it lazily
// otherwise (matching the Python lazy-eviction-on-read behavior).
func (c *shareCache) Get(hash string) *model.ShareRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	rec := c.d[hash]
	if rec == nil {
		return nil
	}
	if rec.ExpiresAt <= nowUnix() {
		delete(c.d, hash)
		return nil
	}
	return rec
}

// PurgeExpired removes shares at or past now and returns their hashes.
func (c *shareCache) PurgeExpired(now float64) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var expired []string
	for h, r := range c.d {
		if r.ExpiresAt <= now {
			expired = append(expired, h)
		}
	}
	for _, h := range expired {
		delete(c.d, h)
	}
	return expired
}

func nowUnix() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// sharesState bundles the per-process share cache. A single instance is shared
// by the session-scoped CRUD routes (registerShareRoutes) and the public
// viewer (PublicShareRouter) so create/delete stay in sync with reads.
//
// Because the lead wires registerShareRoutes and PublicShareRouter as separate
// Deps-driven calls, the cache is created lazily and memoized per *store.Store
// pointer so both sides observe the same instance.
var (
	sharesOnce  sync.Once
	sharesCache *shareCache
)

// sharedShareCache returns the process-wide share cache, warming it from the
// store's active shares on first use and starting the expiry sweep.
func sharedShareCache(d Deps) *shareCache {
	sharesOnce.Do(func() {
		sharesCache = newShareCache()
		if d.Store != nil {
			if recs, err := d.Store.ListActiveShares(nowUnix()); err == nil {
				sharesCache.Load(recs)
			}
			startShareSweeper(d, sharesCache)
		}
	})
	return sharesCache
}

// startShareSweeper periodically deletes expired shares from the DB and evicts
// them from the cache (mirrors the Python cleanup loop). It runs for the life
// of the process.
func startShareSweeper(d Deps, c *shareCache) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			now := nowUnix()
			if _, err := d.Store.DeleteExpiredShares(now); err != nil {
				continue
			}
			c.PurgeExpired(now)
		}
	}()
}
