// Store icon-only bookmarks
let iconOnlyBookmarks = [];

// Load saved bookmarks on startup
browser.storage.local.get("iconOnlyBookmarks").then((result) => {
  iconOnlyBookmarks = result.iconOnlyBookmarks || [];
  console.log("Loaded icon-only bookmarks:", iconOnlyBookmarks);
});

// Create context menu for "Show icon only"
browser.menus.create({
  id: "show-icon-only",
  title: "Show icon only",
  contexts: ["bookmark"],
  onclick: async (info) => {
    if (!info.bookmarkId) return;
    
    // Add to icon-only list
    if (!iconOnlyBookmarks.includes(info.bookmarkId)) {
      iconOnlyBookmarks.push(info.bookmarkId);
      await browser.storage.local.set({ iconOnlyBookmarks: iconOnlyBookmarks });
      
      // Get bookmark info
      const bookmark = await browser.bookmarks.get(info.bookmarkId);
      
      // Update bookmark title to just emoji/icon (visual trick)
      // Store original title in URL hash or description
      await browser.bookmarks.update(info.bookmarkId, {
        title: "" // You can change this to just empty space: " "
      });
      
      console.log(`Bookmark "${bookmark[0].title}" hidden. ID: ${info.bookmarkId}`);
      
      // Store original title for restoration
      let originals = await browser.storage.local.get("originalTitles");
      let titles = originals.originalTitles || {};
      titles[info.bookmarkId] = bookmark[0].title;
      await browser.storage.local.set({ originalTitles: titles });
    }
  }
});

// Create context menu for "Show full bookmark"
browser.menus.create({
  id: "show-full-bookmark",
  title: "Show full bookmark",
  contexts: ["bookmark"],
  onclick: async (info) => {
    if (!info.bookmarkId) return;
    
    // Remove from icon-only list
    iconOnlyBookmarks = iconOnlyBookmarks.filter(id => id !== info.bookmarkId);
    await browser.storage.local.set({ iconOnlyBookmarks: iconOnlyBookmarks });
    
    // Restore original title
    let originals = await browser.storage.local.get("originalTitles");
    let titles = originals.originalTitles || {};
    
    if (titles[info.bookmarkId]) {
      await browser.bookmarks.update(info.bookmarkId, {
        title: titles[info.bookmarkId]
      });
      
      console.log(`Bookmark restored: ${titles[info.bookmarkId]}`);
      
      // Clean up stored title
      delete titles[info.bookmarkId];
      await browser.storage.local.set({ originalTitles: titles });
    }
  }
});

// Clean up when bookmark is deleted
browser.bookmarks.onRemoved.addListener(async (bookmarkId) => {
  if (iconOnlyBookmarks.includes(bookmarkId)) {
    iconOnlyBookmarks = iconOnlyBookmarks.filter(id => id !== bookmarkId);
    await browser.storage.local.set({ iconOnlyBookmarks: iconOnlyBookmarks });
    
    // Clean up original title
    let originals = await browser.storage.local.get("originalTitles");
    let titles = originals.originalTitles || {};
    delete titles[bookmarkId];
    await browser.storage.local.set({ originalTitles: titles });
  }
});