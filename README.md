# Bookmark Icon Only
Icon-only bookmarks extension for Firefox — designed to work just like Microsoft Edge's native "Show icon only" favorites bar option.

## Install

<p align="center">
  <a href="https://addons.mozilla.org/en-US/firefox/addon/bookmark-icon-only" target="_blank">
    <img src="https://blog.mozilla.org/addons/files/2015/11/get-the-addon.png"
         alt="Get the add-on for Firefox"
         height="60" />
  </a>
</p>

## About this extension
**Bookmark Icon Only** lets you display selected bookmarks in your toolbar using only their website icons (favicons) — no text labels. This gives your Firefox Bookmarks Toolbar a tidy, minimalist look while maximizing toolbar real estate.

### ✨ Features:

- **Microsoft Edge Parity**: Right-click any bookmark on your toolbar to toggle **`Bookmark Icon Only`**. A clean, top-level native Firefox checkbox toggle with no submenus.
- **Resilient Multi-Tier Database**:
  - **L1 In-Memory Cache**: 0ms instant menu response with no lag or flicker.
  - **L2 Local Document Store**: 10MB durable storage immune to browser history or cookie clearing (supports 50,000+ bookmarks).
  - **L3 Chunk-Packed Sync Engine**: High-efficiency bin-packed sync chunks (`c_0`, `c_1`, ...) that maximize Firefox Sync capacity up to **800–1,000+ synced bookmarks** safely within Firefox's 8KB per-item and 100KB total quotas.
- **Real-Time Multi-Device Sync**: Automatically mirrors hidden and restored bookmark states across your synced Firefox profiles via `browser.storage.onChanged`.
- **Two-Phase Atomic Transactions**: Ensures bookmark titles are never lost even if a browser operation fails or is interrupted.
- **External Edit Reconciliation**: If you edit or rename a bookmark in Firefox's Bookmark Library (`Ctrl+Shift+O`), the extension automatically updates its stored records.
- **Ultra-Lightweight & Minimal**: No toolbar popup or background bloat — works purely through the native right-click menu.
- **100% Private**: All data stays within your local Firefox profile and your personal Firefox Sync account. No telemetry or external servers.
