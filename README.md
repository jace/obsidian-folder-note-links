# Folder Note Links

An [Obsidian](https://obsidian.md) plugin that makes a wikilink pointing at a **folder** open that folder's **folder note** — the `index` / `README` / same-named note inside it.

Obsidian resolves `[[Something]]` to a *note* named "Something" (or one of its aliases). If your folder notes are named `README.md` or `index.md` (common when the vault also feeds a static site like Quartz or Hugo), a link to the folder matches no note, so clicking it creates a stray new file. The usual workarounds — an alias or a `title:` equal to the folder name — store the folder's name a second time, and drift the moment you rename the folder.

This plugin resolves the link **dynamically at lookup time** from the live folder tree, so there's nothing to keep in sync.

## How it works

It wraps Obsidian's link resolver (`MetadataCache.getFirstLinkpathDest`). When a link resolves to a real note, nothing changes. When it resolves to nothing but points at a folder, the plugin returns the first existing **candidate index note** in that folder. It normalizes a trailing slash, so `[[Docs/Infra]]`, `[[Docs/Infra/]]` and `[[Infra]]` all work.

The wrap is installed with [`monkey-around`](https://github.com/pjeby/monkey-around) and removed on unload.

## Configuration

- **Folder note names** — the index-note basenames to try, in priority order (default `index`, `README`, `{{folder_name}}`). `{{folder_name}}` expands to the folder's own name. First existing file wins.
- **Recognize the Folder Notes plugin's name** — when the [Folder Notes](https://github.com/LostPaul/obsidian-folder-notes) plugin is installed, also try its configured folder-note name (added to the list if it's a custom one), so the two stay in sync.

## Scope

Covers **clicking**, **hover preview**, and stops the phantom-file-on-click via the resolver wrap. Folder links are also reflected into `metadataCache.resolvedLinks`, so the **graph** and **backlinks panel** show them as real edges.

## License

MIT
