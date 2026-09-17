/**
 * Bookmark Icon Only - Background Service
 *
 * Provides native Edge-like "Show icon only" checkbox context menu,
 * powered by the multi-tier BookmarkDatabase.
 */

// Instantiate database engine
const db = new BookmarkDatabase();

const MENU_ID = "toggle-icon-only";

function getMenuTitle(isIconOnly) {
  return isIconOnly ? "🮱 Bookmark Icon Only" : "Bookmark Icon Only";
}

let setupMenuPromise = null;

/**
 * Register the single top-level context menu item.
 * NOTE: Firefox on Linux has a hardcoded rule in ext-menus.js (bug 1492969) that
 * forces single menu items with type: "checkbox" into a submenu.
 * Using type: "normal" ensures it stays at the top level with NO children and
 * NO submenu on all platforms including Linux.
 */
function setupMenu() {
  if (!setupMenuPromise) {
    setupMenuPromise = (async () => {
      try {
        await browser.menus.removeAll();
        browser.menus.create({
          id: MENU_ID,
          title: getMenuTitle(false),
                             type: "normal",
                             contexts: ["bookmark"]
        });
        console.log("[BookmarkIO] Top-level menu registered.");
      } catch (err) {
        console.warn("[BookmarkIO] Error registering menu:", err);
      } finally {
        setupMenuPromise = null;
      }
    })();
  }
  return setupMenuPromise;
}

// Lifecycle events
browser.runtime.onInstalled.addListener(async () => {
  await db.init();
  await setupMenu();
});

browser.runtime.onStartup.addListener(async () => {
  await db.init();
  await setupMenu();
});

// Initialize on background script load
db.init().then(() => setupMenu());

/**
 * Handle context menu display (Dynamic Edge Parity)
 * Synchronously checks L1 in-memory cache for instant rendering
 * Updates the checkmark state directly at the top level
 */
browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.bookmarkId) return;

  // Protect separators and root folders
  if (db.isProtected(info.bookmarkId)) {
    await browser.menus.update(MENU_ID, { visible: false });
    await browser.menus.refresh();
    return;
  }

  // Instant L1 cache check: is bookmark icon-only?
  const isIconOnly = db.isIconOnly(info.bookmarkId);

  await browser.menus.update(MENU_ID, {
    visible: true,
    title: getMenuTitle(isIconOnly)
  });
  await browser.menus.refresh();
});

const activeToggles = new Set();

/**
 * Handle menu clicks (Toggle between icon-only and full title)
 */
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.bookmarkId) return;

  const bookmarkId = info.bookmarkId;
  if (activeToggles.has(bookmarkId)) {
    return;
  }
  activeToggles.add(bookmarkId);

  try {
    const isIconOnly = db.isIconOnly(bookmarkId);
    if (isIconOnly) {
      // Checked -> Uncheck: Restore title
      await db.restoreTitle(bookmarkId);
    } else {
      // Unchecked -> Check: Hide title
      await db.hideTitle(bookmarkId);
    }
  } catch (err) {
    console.error(`[BookmarkIO] Toggle error on bookmark ${bookmarkId}:`, err);
  } finally {
    setTimeout(() => {
      activeToggles.delete(bookmarkId);
    }, 300);
  }
});

/**
 * Listen for bookmark removals (external deletions)
 */
browser.bookmarks.onRemoved.addListener(async (bookmarkId) => {
  await db.removeRecordOnly(bookmarkId);
});

/**
 * Listen for bookmark updates (e.g. user renames via Library or Star popup)
 */
browser.bookmarks.onChanged.addListener(async (bookmarkId, changeInfo) => {
  // Consume and ignore internal programmatic updates from this extension
  if (db.internalTitleUpdates && db.internalTitleUpdates.has(bookmarkId)) {
    db.internalTitleUpdates.delete(bookmarkId);
    return;
  }

  if (changeInfo && changeInfo.title !== undefined) {
    if (changeInfo.title !== "") {
      // User entered a new title manually in Firefox: restore from icon-only
      if (db.isIconOnly(bookmarkId)) {
        await db.removeRecordOnly(bookmarkId);
      }
    }
  }
});
