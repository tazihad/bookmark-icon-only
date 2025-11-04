// Function to create context menus
function createMenus() {
  // Remove existing menus to avoid duplicates
  browser.menus.remove("show-icon-only");
  browser.menus.remove("show-full-bookmark");
  
  // Create "Show icon only" menu
  browser.menus.create({
    id: "show-icon-only",
    title: "Show icon only",
    contexts: ["bookmark"]
  });
  
  // Create "Show full bookmark" menu
  browser.menus.create({
    id: "show-full-bookmark",
    title: "Show full bookmark",
    contexts: ["bookmark"]
  });
  
  console.log("Context menus created.");
}

// Create menus on extension install/update
browser.runtime.onInstalled.addListener(createMenus);

// Recreate menus on browser startup (for persistence in MV3)
browser.runtime.onStartup.addListener(createMenus);

// Handle menu clicks
browser.menus.onClicked.addListener(async (info, tab) => {
  if (!info.bookmarkId) return;
  
  if (info.menuItemId === "show-icon-only") {
    // Reload from storage to ensure latest state (service worker may restart)
    const result = await browser.storage.local.get("iconOnlyBookmarks");
    let iconOnlyBookmarks = result.iconOnlyBookmarks || [];
    
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
  } else if (info.menuItemId === "show-full-bookmark") {
    // Reload from storage to ensure latest state (service worker may restart)
    const result = await browser.storage.local.get("iconOnlyBookmarks");
    let iconOnlyBookmarks = result.iconOnlyBookmarks || [];
    
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
  // Reload from storage to ensure latest state
  const result = await browser.storage.local.get("iconOnlyBookmarks");
  let iconOnlyBookmarks = result.iconOnlyBookmarks || [];
  
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