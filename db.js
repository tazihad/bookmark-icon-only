/**
 * Bookmark Icon Only - Resilient Multi-Tier Database Engine
 *
 * Tier 1: In-Memory L1 Cache (Map) for 0ms synchronous context menu lookups
 * Tier 2: Durable Document Store (browser.storage.local) - 10MB quota, immune to cookie wipes
 * Tier 3: Distributed Sync Adapter (browser.storage.sync) - sharded per-item keys (bm_*)
 */

class BookmarkDatabase {
  constructor() {
    this.cache = new Map(); // L1 In-memory cache: id -> BookmarkRecord
    this.isInitialized = false;
    this.SCHEMA_VERSION = 3;
    this.PREFIX = "bm_";
    this.CHUNK_PREFIX = "c_";

    // Quotas and limits for browser.storage.sync
    this.CHUNK_MAX_BYTES = 6000;  // Safe threshold well below 8,192 bytes per-item limit
    this.TOTAL_MAX_BYTES = 95000; // Safe threshold well below 102,400 bytes total quota

    // In-memory sync chunk index
    this.bookmarkChunkMap = new Map(); // bookmarkId -> chunkId (e.g. "c_0")
    this.syncChunks = new Map();        // chunkId -> { [id]: { t, u, d } }
    this._hasStorageListener = false;

    // Suppression sets for self-generated updates and local sync loops
    this.internalTitleUpdates = new Set();
    this.localSyncWrites = new Set();

    // Known Firefox special root folder GUIDs that must never be modified
    this.ROOT_FOLDER_IDS = new Set([
      "root________",
      "menu________",
      "toolbar_____",
      "unfiled_____",
      "mobile______"
    ]);
  }

  /**
   * Check if a bookmark ID is a root folder or separator
   */
  isProtected(bookmarkId, bookmarkNode) {
    if (!bookmarkId) return true;
    if (this.ROOT_FOLDER_IDS.has(bookmarkId)) return true;
    if (bookmarkNode && (bookmarkNode.type === "separator" || (!bookmarkNode.url && bookmarkNode.id === bookmarkNode.parentId))) {
      return true;
    }
    return false;
  }

  /**
   * Initialize the database, migrate legacy records, hydrate L1 cache, and start auto-healing
   */
  async init() {
    if (this.isInitialized) return;

    try {
      // 1. Hydrate L1 cache from L2 storage.local (primary source of truth)
      const allLocal = await browser.storage.local.get(null);
      for (const [key, value] of Object.entries(allLocal || {})) {
        if (key.startsWith(this.PREFIX) && value && (value.originalTitle !== undefined || value.title !== undefined)) {
          const id = key.slice(this.PREFIX.length);
          const normalized = this._normalizeRecord(id, value);
          this.cache.set(id, normalized);
        }
      }

      // 2. Hydrate from L3 storage.sync (chunks & legacy migration)
      try {
        const allSync = await browser.storage.sync.get(null);

        // Load existing chunks
        const backfills = {};
        for (const [key, value] of Object.entries(allSync || {})) {
          if (key.startsWith(this.CHUNK_PREFIX) && value && typeof value === "object") {
            this.syncChunks.set(key, value);
            for (const [id, compact] of Object.entries(value)) {
              if (id && compact && compact.t) {
                this.bookmarkChunkMap.set(id, key);
                if (!this.cache.has(id)) {
                  const normalized = {
                    id: id,
                    originalTitle: compact.t,
                    url: compact.u || "",
                    parentId: "",
                    isIconOnly: true,
                    dateHidden: compact.d || Date.now(),
                    lastVerified: Date.now(),
                    version: this.SCHEMA_VERSION,
                    syncStatus: "synced"
                  };
                  this.cache.set(id, normalized);
                  backfills[this.PREFIX + id] = normalized;
                }
              }
            }
          }
        }

        if (Object.keys(backfills).length > 0) {
          await browser.storage.local.set(backfills);
        }

        // 3. Migrate legacy records (v1 originalTitles and v2 bm_* sync keys)
        await this._migrateLegacy(allLocal, allSync);

        // 4. Ensure all locally cached bookmarks are tracked in sync chunks
        await this._reconcileLocalToSync();
      } catch (syncErr) {
        console.warn("[BookmarkDB] Sync storage hydration warning:", syncErr);
      }

      // 5. Listen for real-time cross-device sync updates
      if (browser.storage && browser.storage.onChanged && !this._hasStorageListener) {
        this._hasStorageListener = true;
        browser.storage.onChanged.addListener(async (changes, areaName) => {
          if (areaName === "sync") {
            await this._handleSyncChanges(changes);
          }
        });
      }

      this.isInitialized = true;
      console.log(`[BookmarkDB] Initialized successfully. L1 Cache: ${this.cache.size} records across ${this.syncChunks.size} sync chunks.`);

      // 6. Run background auto-healer to clean up external renames without purging unhydrated records
      this.autoHeal({ purgeOrphans: false }).catch((err) => console.warn("[BookmarkDB] Auto-heal error:", err));
    } catch (err) {
      console.error("[BookmarkDB] Failed to initialize database:", err);
      this.isInitialized = true; // prevent infinite loops
    }
  }

  /**
   * Synchronous O(1) check: Is this bookmark currently icon-only?
   */
  isIconOnly(bookmarkId) {
    if (!bookmarkId) return false;
    return this.cache.has(bookmarkId);
  }

  /**
   * Synchronous O(1) get: Get cached record
   */
  get(bookmarkId) {
    if (!bookmarkId) return null;
    return this.cache.get(bookmarkId) || null;
  }

  /**
   * Get all active icon-only records as an array
   */
  getAll() {
    return Array.from(this.cache.values());
  }

  /**
   * Total number of icon-only bookmarks
   */
  get count() {
    return this.cache.size;
  }

  /**
   * Two-phase atomic transaction: Hide bookmark title
   */
  async hideTitle(bookmarkId) {
    if (!bookmarkId) throw new Error("Missing bookmarkId");

    const bookmarks = await browser.bookmarks.get(bookmarkId);
    if (!bookmarks || bookmarks.length === 0) {
      throw new Error(`Bookmark with ID ${bookmarkId} not found`);
    }
    const bm = bookmarks[0];

    if (this.isProtected(bookmarkId, bm)) {
      throw new Error(`Cannot hide title of protected bookmark/root folder: ${bookmarkId}`);
    }

    // Determine the title to store. If the title is already empty, check if we have a cached title or fallback
    let originalTitle = bm.title;
    if (!originalTitle && this.cache.has(bookmarkId)) {
      originalTitle = this.cache.get(bookmarkId).originalTitle;
    }
    if (!originalTitle) {
      originalTitle = this._extractFallbackTitle(bm.url);
    }

    const key = this.PREFIX + bookmarkId;
    const record = {
      id: bookmarkId,
      originalTitle: originalTitle,
      url: bm.url || "",
      parentId: bm.parentId,
      isIconOnly: true,
      dateHidden: Date.now(),
      lastVerified: Date.now(),
      version: this.SCHEMA_VERSION,
      syncStatus: "pending"
    };

    // Phase 1 (Persist to L1 and L2):
    this.cache.set(bookmarkId, record);
    await browser.storage.local.set({ [key]: record });

    // Phase 2 (Apply to Firefox Bookmarks):
    this.internalTitleUpdates.add(bookmarkId);
    try {
      await browser.bookmarks.update(bookmarkId, { title: "" });
    } catch (err) {
      // Rollback on failure!
      this.cache.delete(bookmarkId);
      await browser.storage.local.remove(key);
      throw new Error(`Failed to update Firefox bookmark title. Database rolled back: ${err.message}`);
    } finally {
      setTimeout(() => {
        this.internalTitleUpdates.delete(bookmarkId);
      }, 100);
    }

    // Phase 3 (Pack and mirror to L3 Chunked Sync):
    await this._saveToSyncChunk(bookmarkId, record);

    console.log(`[BookmarkDB] Hidden title for "${originalTitle}" (${bookmarkId})`);
    return record;
  }

  /**
   * Two-phase atomic transaction: Restore bookmark title
   */
  async restoreTitle(bookmarkId) {
    if (!bookmarkId) throw new Error("Missing bookmarkId");

    const record = this.get(bookmarkId);
    const bookmarks = await browser.bookmarks.get(bookmarkId).catch(() => null);
    const bm = (bookmarks && bookmarks.length > 0) ? bookmarks[0] : null;

    // Determine target title with multi-layer fallback
    let targetTitle = record ? record.originalTitle : "";
    if (!targetTitle && bm && bm.url) {
      targetTitle = this._extractFallbackTitle(bm.url);
    }
    if (!targetTitle) {
      targetTitle = "Bookmark";
    }

    this.internalTitleUpdates.add(bookmarkId);
    try {
      // Phase 1: Apply to Firefox Bookmarks (if bookmark still exists)
      if (bm) {
        try {
          await browser.bookmarks.update(bookmarkId, { title: targetTitle });
        } catch (err) {
          console.warn(`[BookmarkDB] Failed to update bookmark in Firefox: ${err.message}`);
        }
      }

      // Phase 2: Remove from L1 and L2
      const key = this.PREFIX + bookmarkId;
      this.cache.delete(bookmarkId);
      await browser.storage.local.remove(key);

      // Phase 3: Remove from L3 Sync Chunk
      await this._removeFromSyncChunk(bookmarkId);

      console.log(`[BookmarkDB] Restored title "${targetTitle}" for (${bookmarkId})`);
      return targetTitle;
    } finally {
      setTimeout(() => {
        this.internalTitleUpdates.delete(bookmarkId);
      }, 100);
    }
  }

  /**
   * Restore all icon-only bookmarks in bulk (Safety & Emergency recovery)
   */
  async restoreAll() {
    const results = { restored: 0, failed: 0, titles: [] };
    const ids = Array.from(this.cache.keys());

    for (const id of ids) {
      try {
        const title = await this.restoreTitle(id);
        results.restored++;
        results.titles.push({ id, title });
      } catch (err) {
        console.error(`[BookmarkDB] Failed to restore ${id}:`, err);
        results.failed++;
      }
    }

    console.log(`[BookmarkDB] restoreAll completed: ${results.restored} restored, ${results.failed} failed.`);
    return results;
  }

  /**
   * Remove database record only without modifying the Firefox bookmark
   * Used when a bookmark was already deleted in Firefox (bookmarks.onRemoved)
   */
  async removeRecordOnly(bookmarkId) {
    if (!bookmarkId) return;
    const key = this.PREFIX + bookmarkId;
    this.cache.delete(bookmarkId);
    await browser.storage.local.remove(key);
    await this._removeFromSyncChunk(bookmarkId);
  }

  /**
   * Update original title record when user renames bookmark externally
   */
  async updateTitleOnly(bookmarkId, newTitle) {
    if (!bookmarkId || !newTitle) return;
    const record = this.cache.get(bookmarkId);
    if (!record) return;

    record.originalTitle = newTitle;
    record.lastVerified = Date.now();
    const key = this.PREFIX + bookmarkId;
    await browser.storage.local.set({ [key]: record });
    await this._saveToSyncChunk(bookmarkId, record);
  }

  /**
   * Auto-healing engine: reconciles database with user renames and deletions in Firefox
   */
  async autoHeal(options = {}) {
    const { purgeOrphans = true } = options;
    if (this.cache.size === 0) return;

    const entries = Array.from(this.cache.entries());
    for (const [id, record] of entries) {
      try {
        const found = await browser.bookmarks.get(id);
        if (!found || found.length === 0) {
          if (purgeOrphans) {
            // Orphan bookmark deleted externally in Firefox
            console.log(`[BookmarkDB AutoHeal] Orphan detected and purged: ${id}`);
            await this.removeRecordOnly(id);
          }
        } else if (found[0].title !== "") {
          // User edited title externally in Firefox Bookmark Library
          console.log(`[BookmarkDB AutoHeal] External rename detected for: ${id} ("${found[0].title}")`);
          record.originalTitle = found[0].title;
          record.lastVerified = Date.now();
          await browser.storage.local.set({ [this.PREFIX + id]: record });
          await this._saveToSyncChunk(id, record);
        }
      } catch (err) {
        // Ignore bookmark lookup errors during startup
      }
    }
  }

  /**
   * Export database as clean JSON
   */
  exportJSON() {
    return JSON.stringify({
      version: this.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      bookmarks: Array.from(this.cache.values())
    }, null, 2);
  }

  /**
   * Import database from JSON snapshot
   */
  async importJSON(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data.bookmarks || !Array.isArray(data.bookmarks)) {
      throw new Error("Invalid bookmark backup format");
    }

    let imported = 0;
    for (const item of data.bookmarks) {
      if (item.id && item.originalTitle) {
        const key = this.PREFIX + item.id;
        const record = this._normalizeRecord(item.id, item);
        this.cache.set(item.id, record);
        await browser.storage.local.set({ [key]: record });
        this._saveToSyncChunk(item.id, record);
        imported++;
      }
    }
    return imported;
  }

  // ==========================================
  // Chunk-Packed Sync Engine (Tier 3)
  // ==========================================

  /**
   * Pack and replicate a bookmark record into a storage.sync chunk.
   * Compresses records and keeps chunks safely under 8KB and 100KB limits.
   */
  async _saveToSyncChunk(bookmarkId, record) {
    const compact = {
      t: record.originalTitle,
      u: record.url || "",
      d: record.dateHidden || Date.now()
    };

    let targetChunkId = this.bookmarkChunkMap.get(bookmarkId);
    let chunkData = null;

    if (targetChunkId && this.syncChunks.has(targetChunkId)) {
      chunkData = this.syncChunks.get(targetChunkId);
      chunkData[bookmarkId] = compact;
    } else {
      // Find an existing chunk that has room
      const compactJsonLen = JSON.stringify(compact).length + bookmarkId.length + 6;
      for (const [chunkId, data] of this.syncChunks.entries()) {
        const currentLen = JSON.stringify(data).length;
        if (currentLen + compactJsonLen < this.CHUNK_MAX_BYTES) {
          targetChunkId = chunkId;
          chunkData = data;
          break;
        }
      }

      // If no existing chunk has room, allocate a new chunk
      if (!targetChunkId) {
        // Calculate total sync storage usage across all chunks
        let totalBytes = 0;
        for (const data of this.syncChunks.values()) {
          totalBytes += JSON.stringify(data).length;
        }
        if (totalBytes + compactJsonLen > this.TOTAL_MAX_BYTES) {
          console.warn("[BookmarkDB] storage.sync total quota approaching 100KB. Retained in local storage.");
          record.syncStatus = "failed";
          return;
        }

        // Find the lowest unused chunk key: c_0, c_1, ...
        let idx = 0;
        while (this.syncChunks.has(this.CHUNK_PREFIX + idx)) {
          idx++;
        }
        targetChunkId = this.CHUNK_PREFIX + idx;
        chunkData = {};
        this.syncChunks.set(targetChunkId, chunkData);
      }

      chunkData[bookmarkId] = compact;
      this.bookmarkChunkMap.set(bookmarkId, targetChunkId);
    }

    try {
      this.localSyncWrites.add(targetChunkId);
      await browser.storage.sync.set({ [targetChunkId]: chunkData });
      record.syncStatus = "synced";
    } catch (syncErr) {
      this.localSyncWrites.delete(targetChunkId);
      console.warn(`[BookmarkDB] storage.sync chunk replication failed. Retained in local:`, syncErr);
      record.syncStatus = "failed";
    }
  }

  /**
   * Remove a bookmark from its storage.sync chunk.
   * Prunes empty chunks automatically.
   */
  async _removeFromSyncChunk(bookmarkId) {
    const chunkId = this.bookmarkChunkMap.get(bookmarkId);
    if (!chunkId || !this.syncChunks.has(chunkId)) {
      return;
    }

    const chunkData = this.syncChunks.get(chunkId);
    delete chunkData[bookmarkId];
    this.bookmarkChunkMap.delete(bookmarkId);

    try {
      this.localSyncWrites.add(chunkId);
      if (Object.keys(chunkData).length === 0) {
        this.syncChunks.delete(chunkId);
        await browser.storage.sync.remove(chunkId);
      } else {
        await browser.storage.sync.set({ [chunkId]: chunkData });
      }
    } catch (syncErr) {
      this.localSyncWrites.delete(chunkId);
      console.warn(`[BookmarkDB] storage.sync chunk update warning:`, syncErr);
    }
  }

  /**
   * Ensure all bookmarks in L1 cache are mirrored into sync chunks
   */
  async _reconcileLocalToSync() {
    const unchunked = [];
    for (const [id, record] of this.cache.entries()) {
      if (!this.bookmarkChunkMap.has(id)) {
        unchunked.push({ id, record });
      }
    }
    for (const item of unchunked) {
      await this._saveToSyncChunk(item.id, item.record);
    }
  }

  /**
   * Handle incoming real-time sync changes from other devices via browser.storage.onChanged
   * Supports both v3 chunks (c_*) and legacy 1.0.1 clients (originalTitles & iconOnlyBookmarks).
   */
  async _handleSyncChanges(changes) {
    const localUpdates = {};

    // 1. Check if changes came from a legacy 1.0.1 client on another device
    if (changes.originalTitles || changes.iconOnlyBookmarks) {
      const newTitles = (changes.originalTitles && changes.originalTitles.newValue) || {};
      const newList = (changes.iconOnlyBookmarks && changes.iconOnlyBookmarks.newValue) || [];
      const legacyIds = new Set([...Object.keys(newTitles), ...newList]);

      for (const id of legacyIds) {
        if (id && !this.cache.has(id)) {
          const title = newTitles[id] || "Bookmark";
          const record = {
            id: id,
            originalTitle: title,
            url: "",
            parentId: "",
            isIconOnly: true,
            dateHidden: Date.now(),
            lastVerified: Date.now(),
            version: this.SCHEMA_VERSION,
            syncStatus: "synced"
          };
          this.cache.set(id, record);
          localUpdates[this.PREFIX + id] = record;
          await this._saveToSyncChunk(id, record);

          // Automatically hide title on local device if bookmark exists
          if (browser.bookmarks && browser.bookmarks.get) {
            this.internalTitleUpdates.add(id);
            browser.bookmarks.get(id).then(bms => {
              if (bms && bms[0] && bms[0].title !== "") {
                browser.bookmarks.update(id, { title: "" }).catch(() => {});
              }
            }).catch(() => {}).finally(() => {
              setTimeout(() => this.internalTitleUpdates.delete(id), 100);
            });
          }
        }
      }
    }

    // 2. Process v3 chunk changes
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(this.CHUNK_PREFIX)) continue;

      if (this.localSyncWrites.has(key)) {
        this.localSyncWrites.delete(key);
        continue;
      }

      const oldChunk = change.oldValue || {};
      const newChunk = change.newValue || {};

      if (!change.newValue) {
        // Entire chunk removed remotely
        this.syncChunks.delete(key);
        for (const id of Object.keys(oldChunk)) {
          if (this.bookmarkChunkMap.get(id) === key) {
            this.bookmarkChunkMap.delete(id);
          }
        }
      } else {
        // Chunk updated or added remotely
        this.syncChunks.set(key, newChunk);
        for (const [id, compact] of Object.entries(newChunk)) {
          this.bookmarkChunkMap.set(id, key);
          if (!this.cache.has(id) && compact && compact.t) {
            const record = {
              id: id,
              originalTitle: compact.t,
              url: compact.u || "",
              parentId: "",
              isIconOnly: true,
              dateHidden: compact.d || Date.now(),
              lastVerified: Date.now(),
              version: this.SCHEMA_VERSION,
              syncStatus: "synced"
            };
            this.cache.set(id, record);
            localUpdates[this.PREFIX + id] = record;

            // Automatically hide title on local device if bookmark exists
            if (browser.bookmarks && browser.bookmarks.get) {
              this.internalTitleUpdates.add(id);
              browser.bookmarks.get(id).then(bms => {
                if (bms && bms[0] && bms[0].title !== "") {
                  browser.bookmarks.update(id, { title: "" }).catch(() => {});
                }
              }).catch(() => {}).finally(() => {
                setTimeout(() => this.internalTitleUpdates.delete(id), 100);
              });
            }
          }
        }
      }
    }

    if (Object.keys(localUpdates).length > 0) {
      await browser.storage.local.set(localUpdates);
    }
  }

  /**
   * Normalize records across schema versions
   */
  _normalizeRecord(id, raw) {
    return {
      id: id,
      originalTitle: raw.originalTitle || raw.title || (raw.t || ""),
      url: raw.url || (raw.u || ""),
      parentId: raw.parentId || "",
      isIconOnly: true,
      dateHidden: raw.dateHidden || raw.updatedAt || (raw.d || Date.now()),
      lastVerified: Date.now(),
      version: this.SCHEMA_VERSION,
      syncStatus: raw.syncStatus || "pending"
    };
  }

  /**
   * Migrate legacy storage formats:
   * 1. v1 / 1.0.0 & 1.0.1: originalTitles dictionary & iconOnlyBookmarks array
   * 2. v2: individual bm_* items in storage.sync -> migrate to chunked c_*
   */
  async _migrateLegacy(allLocal, allSync) {
    const legacyTitles = {
      ...(allSync.originalTitles || {}),
      ...(allLocal.originalTitles || {})
    };

    const legacyIds = new Set([
      ...Object.keys(allSync.originalTitles || {}),
      ...Object.keys(allLocal.originalTitles || {}),
      ...(Array.isArray(allSync.iconOnlyBookmarks) ? allSync.iconOnlyBookmarks : []),
      ...(Array.isArray(allLocal.iconOnlyBookmarks) ? allLocal.iconOnlyBookmarks : [])
    ]);

    const hasV1 = legacyIds.size > 0;

    // Collect individual v2 bm_* keys from storage.sync to pack into chunks
    const v2SyncKeys = [];
    const v2SyncRecords = {};
    for (const [k, v] of Object.entries(allSync || {})) {
      if (k.startsWith(this.PREFIX) && v && (v.originalTitle !== undefined || v.title !== undefined)) {
        v2SyncKeys.push(k);
        v2SyncRecords[k.slice(this.PREFIX.length)] = v;
      }
    }
    const hasV2Sync = v2SyncKeys.length > 0;

    if (!hasV1 && !hasV2Sync) return;

    console.log(`[BookmarkDB] Running legacy migration to v3 (found ${legacyIds.size} 1.0.1 legacy records, ${v2SyncKeys.length} v2 sync keys)...`);

    // Migrate 1.0.1 / 1.0.0 legacy bookmarks
    if (hasV1) {
      const localUpdates = {};
      for (const id of legacyIds) {
        if (!id || this.ROOT_FOLDER_IDS.has(id)) continue;

        let title = legacyTitles[id];
        let url = "";

        // If title is missing or empty, look up bookmark from browser to get URL and fallback title
        if (!title || typeof title !== "string") {
          try {
            if (browser.bookmarks && browser.bookmarks.get) {
              const bms = await browser.bookmarks.get(id);
              if (bms && bms[0]) {
                url = bms[0].url || "";
                title = bms[0].title || this._extractFallbackTitle(url);
              }
            }
          } catch (e) {}
        }
        if (!title) {
          title = "Bookmark";
        }

        const key = this.PREFIX + id;
        const rec = {
          id: id,
          originalTitle: title,
          url: url,
          parentId: "",
          isIconOnly: true,
          dateHidden: Date.now(),
          lastVerified: Date.now(),
          version: this.SCHEMA_VERSION,
          syncStatus: "synced"
        };
        localUpdates[key] = rec;
        this.cache.set(id, rec);
        await this._saveToSyncChunk(id, rec);
      }

      if (Object.keys(localUpdates).length > 0) {
        await browser.storage.local.set(localUpdates);
      }

      // Prune deprecated v1 keys from storage.sync and storage.local
      await browser.storage.sync.remove(["originalTitles", "iconOnlyBookmarks"]);
      await browser.storage.local.remove(["originalTitles", "iconOnlyBookmarks"]);
    }

    // Migrate v2 sync keys to chunks
    if (hasV2Sync) {
      for (const [id, record] of Object.entries(v2SyncRecords)) {
        await this._saveToSyncChunk(id, record);
      }
      await browser.storage.sync.remove(v2SyncKeys);
    }

    console.log("[BookmarkDB] Legacy migration finished successfully.");
  }

  /**
   * Extract friendly fallback title from URL
   */
  _extractFallbackTitle(url) {
    if (!url) return "Bookmark";
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname.replace(/^\/|\/$/g, "");
      if (path && path.length < 30) {
        return `${host}/${path}`;
      }
      return host || "Bookmark";
    } catch {
      return "Bookmark";
    }
  }
}

// Global export for WebExtensions background & popup scripts
if (typeof window !== "undefined") {
  window.BookmarkDatabase = BookmarkDatabase;
}
if (typeof globalThis !== "undefined") {
  globalThis.BookmarkDatabase = BookmarkDatabase;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = BookmarkDatabase;
}
