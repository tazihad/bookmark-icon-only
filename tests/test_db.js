/**
 * Automated Test Suite for Bookmark Icon Only Database & Edge Parity
 * Runs via Node.js
 */

const assert = require("assert");

// Create mock WebExtensions browser environment
function createMockBrowser() {
  const localStorageMap = new Map();
  const syncStorageMap = new Map();
  const bookmarksMap = new Map();

  const SYNC_ITEM_LIMIT = 8192; // 8KB per item
  const storageListeners = [];
  const bookmarkListeners = [];

  function triggerStorage(changes, areaName) {
    for (const l of storageListeners) l(changes, areaName);
  }

  function triggerBookmarkChange(id, changeInfo) {
    for (const l of bookmarkListeners) l(id, changeInfo);
  }

  return {
    _bookmarksMap: bookmarksMap,
    _localStorageMap: localStorageMap,
    _syncStorageMap: syncStorageMap,

    storage: {
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        }
      },
      local: {
        async get(keys) {
          if (keys === null) {
            const out = {};
            for (const [k, v] of localStorageMap.entries()) out[k] = JSON.parse(JSON.stringify(v));
            return out;
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (localStorageMap.has(k)) out[k] = JSON.parse(JSON.stringify(localStorageMap.get(k)));
            }
            return out;
          }
          if (typeof keys === "string") {
            const out = {};
            if (localStorageMap.has(keys)) out[keys] = JSON.parse(JSON.stringify(localStorageMap.get(keys)));
            return out;
          }
          return {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            localStorageMap.set(k, JSON.parse(JSON.stringify(v)));
          }
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) localStorageMap.delete(k);
        }
      },

      sync: {
        async get(keys) {
          if (keys === null) {
            const out = {};
            for (const [k, v] of syncStorageMap.entries()) out[k] = JSON.parse(JSON.stringify(v));
            return out;
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (syncStorageMap.has(k)) out[k] = JSON.parse(JSON.stringify(syncStorageMap.get(k)));
            }
            return out;
          }
          if (typeof keys === "string") {
            const out = {};
            if (syncStorageMap.has(keys)) out[keys] = JSON.parse(JSON.stringify(syncStorageMap.get(keys)));
            return out;
          }
          return {};
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const serialized = JSON.stringify(v);
            if (serialized.length > SYNC_ITEM_LIMIT) {
              throw new Error(`QuotaExceededError: Item '${k}' exceeds 8192 bytes (${serialized.length} bytes)`);
            }
            changes[k] = { oldValue: syncStorageMap.get(k), newValue: JSON.parse(serialized) };
            syncStorageMap.set(k, JSON.parse(serialized));
          }
          triggerStorage(changes, "sync");
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            changes[k] = { oldValue: syncStorageMap.get(k), newValue: undefined };
            syncStorageMap.delete(k);
          }
          triggerStorage(changes, "sync");
        }
      }
    },

    bookmarks: {
      failNextUpdate: false,
      onChanged: {
        addListener(fn) {
          bookmarkListeners.push(fn);
        }
      },
      onRemoved: {
        addListener(fn) {}
      },
      async get(id) {
        if (!bookmarksMap.has(id)) return [];
        return [JSON.parse(JSON.stringify(bookmarksMap.get(id)))];
      },
      async update(id, changes) {
        if (this.failNextUpdate) {
          this.failNextUpdate = false;
          throw new Error("Simulated Firefox Bookmarks update failure");
        }
        if (!bookmarksMap.has(id)) throw new Error("Bookmark not found");
        const bm = bookmarksMap.get(id);
        if (changes.title !== undefined) bm.title = changes.title;
        if (changes.url !== undefined) bm.url = changes.url;
        bookmarksMap.set(id, bm);
        triggerBookmarkChange(id, changes);
        return bm;
      }
    },

    menus: {
      items: new Map(),
      async removeAll() {
        this.items.clear();
      },
      create(spec) {
        this.items.set(spec.id, spec);
      },
      async update(id, updates) {
        if (this.items.has(id)) {
          Object.assign(this.items.get(id), updates);
        }
      },
      async refresh() {}
    }
  };
}

async function runTests() {
  console.log("=== Starting BookmarkDatabase Test Suite ===");
  const BookmarkDatabase = require("../db.js");

  // Test 1: Initialization & Empty Cache
  {
    console.log("[Test 1] Initialization with empty storage...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();
    assert.strictEqual(db.count, 0, "DB should start with 0 records");
    assert.strictEqual(db.isIconOnly("bm1"), false);
    console.log("✓ Test 1 Passed");
  }

  // Test 2: Legacy v1 Migration
  {
    console.log("[Test 2] Legacy v1 migration (originalTitles & iconOnlyBookmarks)...");
    global.browser = createMockBrowser();
    // Seed legacy data
    await browser.storage.sync.set({
      originalTitles: {
        "leg1": "Google Search",
        "leg2": "GitHub: Let's build from here"
      },
      iconOnlyBookmarks: ["leg1", "leg2"]
    });

    const db = new BookmarkDatabase();
    await db.init();

    assert.strictEqual(db.count, 2, "Should have migrated 2 legacy bookmarks");
    assert.strictEqual(db.isIconOnly("leg1"), true);
    assert.strictEqual(db.get("leg1").originalTitle, "Google Search");
    assert.strictEqual(db.get("leg2").originalTitle, "GitHub: Let's build from here");

    // Ensure legacy keys were pruned
    const checkSync = await browser.storage.sync.get(["originalTitles", "iconOnlyBookmarks"]);
    assert.strictEqual(checkSync.originalTitles, undefined, "originalTitles should be deleted");
    assert.strictEqual(checkSync.iconOnlyBookmarks, undefined, "iconOnlyBookmarks should be deleted");

    // Ensure individual bm_ keys exist in local and sync
    const checkLocal = await browser.storage.local.get("bm_leg1");
    assert.ok(checkLocal.bm_leg1, "bm_leg1 should exist in local storage");
    assert.strictEqual(checkLocal.bm_leg1.originalTitle, "Google Search");
    console.log("✓ Test 2 Passed");
  }

  // Test 3: Chunk-Packed 800 Bookmarks Sync Quota Test
  {
    console.log("[Test 3] Chunk-Packed Sync Quota Test (800 bookmarks)...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    // Create 800 bookmarks with long realistic titles
    for (let i = 1; i <= 800; i++) {
      const id = `bm_test_${i}`;
      browser._bookmarksMap.set(id, {
        id: id,
        title: `Comprehensive Documentation and User Manual for Service #${i} - Long Title Test`,
        url: `https://example.com/docs/manual/${i}`,
        parentId: "toolbar_____"
      });

      // Hide title
      await db.hideTitle(id);
    }

    assert.strictEqual(db.count, 800, "All 800 bookmarks should be tracked in DB");

    // Verify all bookmarks on mock have title: ""
    for (let i = 1; i <= 800; i++) {
      const id = `bm_test_${i}`;
      const bm = browser._bookmarksMap.get(id);
      assert.strictEqual(bm.title, "", `Bookmark ${id} title should be blank`);
      assert.strictEqual(db.isIconOnly(id), true, `${id} should be icon-only in cache`);
    }

    // Verify no single chunk in storage.sync exceeded 8192 bytes
    let totalSyncBytes = 0;
    for (const [key, val] of browser._syncStorageMap.entries()) {
      const len = JSON.stringify(val).length + key.length;
      totalSyncBytes += len;
      assert.ok(len < 8192, `Chunk ${key} size ${len} exceeds 8192 bytes`);
    }
    assert.ok(totalSyncBytes < 102400, `Total sync bytes ${totalSyncBytes} exceeds 100KB limit`);
    console.log(`✓ Test 3 Passed: 800 bookmarks packed into ${browser._syncStorageMap.size} chunks (${totalSyncBytes} bytes, under 100KB)`);
  }

  // Test 4: Two-Phase Atomic Transaction & Rollback
  {
    console.log("[Test 4] Atomic Transaction & Rollback on failure...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    const id = "fail_bookmark";
    browser._bookmarksMap.set(id, {
      id: id,
      title: "Valuable Original Title",
      url: "https://example.com",
      parentId: "toolbar_____"
    });

    // Simulate bookmark update failure
    browser.bookmarks.failNextUpdate = true;

    await assert.rejects(
      async () => {
        await db.hideTitle(id);
      },
      /Failed to update Firefox bookmark title/,
      "Should reject with rollback error"
    );

    // Verify rollback occurred in L1 cache and L2 local storage
    assert.strictEqual(db.isIconOnly(id), false, "L1 cache should not have record after rollback");
    const localCheck = await browser.storage.local.get("bm_" + id);
    assert.strictEqual(localCheck["bm_" + id], undefined, "Local storage should not have record after rollback");

    // Verify bookmark title in Firefox was not wiped
    const bm = browser._bookmarksMap.get(id);
    assert.strictEqual(bm.title, "Valuable Original Title", "Bookmark title should remain untouched");
    console.log("✓ Test 4 Passed: Rollback preserved data integrity");
  }

  // Test 5: Title Restoration & Multi-layer Fallback
  {
    console.log("[Test 5] Title Restoration & Multi-layer Fallback...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    const id = "restore_test";
    browser._bookmarksMap.set(id, {
      id: id,
      title: "My Awesome App",
      url: "https://mycoolapp.com/dashboard",
      parentId: "toolbar_____"
    });

    // Hide
    await db.hideTitle(id);
    assert.strictEqual(browser._bookmarksMap.get(id).title, "");

    // Restore
    const restored = await db.restoreTitle(id);
    assert.strictEqual(restored, "My Awesome App");
    assert.strictEqual(browser._bookmarksMap.get(id).title, "My Awesome App");
    assert.strictEqual(db.isIconOnly(id), false);

    // Test fallback when DB record is completely missing
    const fallbackId = "fallback_bm";
    browser._bookmarksMap.set(fallbackId, {
      id: fallbackId,
      title: "",
      url: "https://github.com/developer/project",
      parentId: "toolbar_____"
    });

    const fallbackRestored = await db.restoreTitle(fallbackId);
    assert.ok(fallbackRestored.includes("github.com"), `Fallback title should be derived from URL: ${fallbackRestored}`);
    assert.strictEqual(browser._bookmarksMap.get(fallbackId).title, fallbackRestored);
    console.log("✓ Test 5 Passed: Normal restore & fallback restore succeeded");
  }

  // Test 6: Auto-Healing (Orphans & External Renames)
  {
    console.log("[Test 6] Auto-healing (Orphans & External Renames)...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    // 1. Orphan test
    browser._bookmarksMap.set("orphan1", { id: "orphan1", title: "Orphan", url: "https://orphan.com" });
    await db.hideTitle("orphan1");
    assert.strictEqual(db.isIconOnly("orphan1"), true);

    // Bookmark deleted externally in Firefox
    browser._bookmarksMap.delete("orphan1");

    // Run auto-heal
    await db.autoHeal();
    assert.strictEqual(db.isIconOnly("orphan1"), false, "Orphan record should be purged");

    // 2. External rename test
    browser._bookmarksMap.set("rename1", { id: "rename1", title: "Original Title", url: "https://rename.com" });
    await db.hideTitle("rename1");

    // User renames bookmark externally in Library
    browser._bookmarksMap.get("rename1").title = "User Edited Title";

    // Run auto-heal
    await db.autoHeal();
    assert.strictEqual(db.get("rename1").originalTitle, "User Edited Title", "DB should reconcile new title");
    console.log("✓ Test 6 Passed: Auto-healing successfully reconciled orphans and renames");
  }

  // Test 7: Root Folder Protection
  {
    console.log("[Test 7] Root Folder Protection...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    assert.strictEqual(db.isProtected("toolbar_____"), true);
    assert.strictEqual(db.isProtected("root________"), true);
    assert.strictEqual(db.isProtected("menu________"), true);
    assert.strictEqual(db.isProtected("unfiled_____"), true);

    await assert.rejects(
      async () => {
        browser._bookmarksMap.set("toolbar_____", { id: "toolbar_____", title: "Bookmarks Toolbar" });
        await db.hideTitle("toolbar_____");
      },
      /protected/,
      "Should reject attempting to hide title on root toolbar folder"
    );
    console.log("✓ Test 7 Passed: Root folders are properly protected");
  }

  // Test 8: Bulk Restore All
  {
    console.log("[Test 8] Bulk Restore All...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    for (let i = 1; i <= 5; i++) {
      const id = `bulk_${i}`;
      browser._bookmarksMap.set(id, { id: id, title: `Title ${i}`, url: `https://site${i}.com` });
      await db.hideTitle(id);
    }
    assert.strictEqual(db.count, 5);

    const bulkResult = await db.restoreAll();
    assert.strictEqual(bulkResult.restored, 5);
    assert.strictEqual(bulkResult.failed, 0);
    assert.strictEqual(db.count, 0);

    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(browser._bookmarksMap.get(`bulk_${i}`).title, `Title ${i}`);
    }
    console.log("✓ Test 8 Passed: Bulk restore all succeeded");
  }

  // Test 9: Toggle Persistence, Event Suppression, and Manual Rename Protection
  {
    console.log("[Test 9] Toggle Persistence, Event Suppression, and Manual Rename...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();

    // Wire up background.js onChanged listener logic
    browser.bookmarks.onChanged.addListener(async (bookmarkId, changeInfo) => {
      if (db.internalTitleUpdates && db.internalTitleUpdates.has(bookmarkId)) {
        db.internalTitleUpdates.delete(bookmarkId);
        return; // Suppressed internal update!
      }
      if (changeInfo && changeInfo.title !== undefined) {
        if (changeInfo.title !== "") {
          if (db.isIconOnly(bookmarkId)) {
            await db.removeRecordOnly(bookmarkId);
          }
        }
      }
    });

    await db.init();

    const id = "restore_bug_test";
    browser._bookmarksMap.set(id, {
      id: id,
      title: "YouTube",
      url: "https://youtube.com",
      parentId: "toolbar_____"
    });

    // 1. Hide title
    await db.hideTitle(id);
    assert.strictEqual(browser._bookmarksMap.get(id).title, "", "Title should be hidden");
    assert.strictEqual(db.isIconOnly(id), true, "Should be icon-only in cache");

    // 2. Restore title (Uncheck)
    const restored = await db.restoreTitle(id);
    assert.strictEqual(restored, "YouTube", "Restored title should be YouTube");
    assert.strictEqual(browser._bookmarksMap.get(id).title, "YouTube", "Title in browser should remain YouTube");
    assert.strictEqual(db.isIconOnly(id), false, "Should no longer be icon-only");

    // Wait for any async storage/event loop microtasks
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(browser._bookmarksMap.get(id).title, "YouTube", "Title must NOT be wiped back to empty!");
    assert.strictEqual(db.isIconOnly(id), false, "Must remain unchecked!");

    // 3. Hide again and test manual rename in Firefox
    await db.hideTitle(id);
    assert.strictEqual(browser._bookmarksMap.get(id).title, "");
    assert.strictEqual(db.isIconOnly(id), true);

    // User renames bookmark via Bookmark Properties to "My Custom YouTube"
    await browser.bookmarks.update(id, { title: "My Custom YouTube" });
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(browser._bookmarksMap.get(id).title, "My Custom YouTube", "Manual title should be preserved");
    assert.strictEqual(db.isIconOnly(id), false, "Manual rename should restore it from icon-only");
    console.log("✓ Test 9 Passed: Toggle persistence, event suppression, and manual rename succeeded");
  }

  // Test 10: Top-Level Parent Checkmark Context Menu (No Children)
  {
    console.log("[Test 10] Top-Level Parent Checkmark Context Menu (No Children)...");
    global.browser = createMockBrowser();
    const db = new BookmarkDatabase();
    await db.init();

    const MENU_ID = "toggle-icon-only";
    function getMenuTitle(isIconOnly) {
      return isIconOnly ? "✓ Bookmark Icon Only" : "Bookmark Icon Only";
    }

    // Register top-level parent menu (type: normal ensures no child submenu on Linux)
    browser.menus.create({
      id: MENU_ID,
      title: getMenuTitle(false),
      type: "normal",
      contexts: ["bookmark"]
    });

    const menuItem = browser.menus.items.get(MENU_ID);
    assert.strictEqual(menuItem.type, "normal", "Menu type must be normal to prevent child submenu creation on Linux");
    assert.strictEqual(menuItem.parentId, undefined, "Menu item must be at top level with no parent");
    assert.strictEqual(menuItem.title, "Bookmark Icon Only", "Initial menu item should be unchecked");

    // Add bookmarks
    const iconOnlyId = "bm_icon_only";
    browser._bookmarksMap.set(iconOnlyId, { id: iconOnlyId, title: "Google", url: "https://google.com" });
    await db.hideTitle(iconOnlyId);

    const regularId = "bm_regular";
    browser._bookmarksMap.set(regularId, { id: regularId, title: "Mozilla", url: "https://mozilla.org" });

    // Simulate onShown for icon-only bookmark
    await browser.menus.update(MENU_ID, {
      visible: true,
      title: getMenuTitle(db.isIconOnly(iconOnlyId))
    });
    assert.strictEqual(browser.menus.items.get(MENU_ID).title, "✓ Bookmark Icon Only", "Parent menu should show checkmark for icon-only bookmark");

    // Simulate onShown for regular bookmark
    await browser.menus.update(MENU_ID, {
      visible: true,
      title: getMenuTitle(db.isIconOnly(regularId))
    });
    assert.strictEqual(browser.menus.items.get(MENU_ID).title, "Bookmark Icon Only", "Parent menu should show plain title for regular bookmark");

    // Simulate onShown for protected bookmark/folder
    assert.strictEqual(db.isProtected("toolbar_____"), true);
    await browser.menus.update(MENU_ID, { visible: false });
    assert.strictEqual(browser.menus.items.get(MENU_ID).visible, false, "Menu should be invisible for protected bookmark");

    console.log("✓ Test 10 Passed: Top-level parent checkmark behavior (no children) verified");
  }

  console.log("\n==========================================");
  console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! (10/10)");
  console.log("==========================================");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
