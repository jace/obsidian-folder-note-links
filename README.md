# Folder Note Links

An [Obsidian](https://obsidian.md) plugin that makes a wikilink pointing at a **folder** resolve to that folder's **index note** — the `index` / `Index` / `README` note inside it.

Obsidian resolves `[[Something]]` to a *note* named "Something" (or an alias). If your folder notes are named `index.md` or `README.md` (common when the vault also feeds a static site like Quartz or Hugo), a link to the folder matches no note, so clicking it creates a stray sibling file — a file and a folder with the same name, which is always confusing. The usual workarounds — an alias or a `title:` equal to the folder name — store the folder's name a second time and drift the moment you rename the folder.

This plugin resolves the link **dynamically from the live folder tree**, so there's nothing to keep in sync. It's small and opinion-free: **no UI changes, nothing hidden, no title/alias machinery.**

## What it does

1. **Resolve** — a link to a folder resolves to the first existing index note in it, trying your candidate names in order (default `index`, `Index`, `README` — Obsidian is case-sensitive). Trailing slash is fine: `[[Docs/Infra]]`, `[[Docs/Infra/]]`, and `[[Infra]]` all work. A bare name means Markdown (`.md`); add an extension (e.g. `Index.base`) to target another file type.
2. **Graph & backlinks** — the resolved folder links are reflected into `metadataCache.resolvedLinks`, so they show as real edges in the graph and in the backlinks panel.
3. **Create on follow** — following a link to a folder that has no index note creates one *inside* the folder (not a sibling file with the folder's name). Obsidian would create a file for any unresolved link anyway; this just puts it where it belongs. The name to create is configurable and may differ from the lookup order — e.g. look up `index` first but create `README`.
4. **Autocomplete** — while typing `[[`, folders are offered as targets and the index notes themselves (`README`/`index`/…) are dropped from the list, so editors link to the folder rather than the note inside it. Folders without an index note are offered too: the link is unresolved until you follow it (create-on-follow fills it in), and stays meaningful on a site like Quartz that renders a folder listing. (This patches the built-in link suggester — an internal API.)

The resolver wraps `MetadataCache.getFirstLinkpathDest` (and `Workspace.openLinkText` for creation) with [`monkey-around`](https://github.com/pjeby/monkey-around), removed on unload.

## Settings

- **Folder note names** — candidate names to look for, in priority order (case-sensitive; `.md` implied).
- **Create on follow** — create an index note inside an index-less folder when followed.
- **Name to create** — the note name to create (extension optional).

## License

MIT
