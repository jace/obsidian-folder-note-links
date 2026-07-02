import { around } from "monkey-around";
import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  parseLinktext,
} from "obsidian";

interface FolderNoteLinksSettings {
  // Index-note names to try inside a linked folder, in priority order. Names are
  // case-sensitive (Obsidian is). A name with no extension implies `.md`; add an
  // extension (e.g. "Index.base") to target another file type. First match wins.
  candidateNames: string[];
  // Create a folder note when you follow a link to a folder that has none.
  createOnFollow: boolean;
  // Name to create for that note (extension optional, `.md` implied). May differ
  // from the lookup order above — e.g. look up `index` first but create `README`.
  createName: string;
}

const DEFAULT_SETTINGS: FolderNoteLinksSettings = {
  candidateNames: ["index", "Index", "README"],
  createOnFollow: true,
  createName: "index",
};

// A bare name implies a Markdown target, matching Obsidian's wikilink resolution;
// an explicit extension is kept as-is.
function withExtension(name: string): string {
  return /\.[^./\\]+$/.test(name) ? name : `${name}.md`;
}

export default class FolderNoteLinksPlugin extends Plugin {
  settings: FolderNoteLinksSettings = DEFAULT_SETTINGS;
  private folderIndexCache: Map<string, TFolder[]> | null = null;
  private allFoldersCache: TFolder[] | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FolderNoteLinksSettingTab(this.app, this));

    const self = this;

    // 1. Resolve a wikilink that points at a folder to that folder's index note.
    // Wrap Obsidian's one link-resolution entry point; only step in on a miss, so
    // a real note always wins. monkey-around restores cleanly on unload.
    this.register(
      around(this.app.metadataCache as any, {
        getFirstLinkpathDest(original: (lp: string, sp: string) => TFile | null) {
          return function (this: unknown, linkpath: string, sourcePath: string): TFile | null {
            const dest = original.call(this, linkpath, sourcePath);
            if (dest) return dest;
            return self.resolveFolderNote(linkpath, sourcePath);
          };
        },
      }),
    );

    // 2. The graph and backlinks read metadataCache.resolvedLinks, computed
    // independently of the resolver — folder links land in unresolvedLinks. Move
    // them across after each file resolves (Obsidian recomputes from scratch, so
    // re-apply each time) plus a bulk pass on startup.
    this.registerEvent(
      this.app.metadataCache.on("resolve", (file) => this.reflectFolderLinks(file.path)),
    );
    const invalidate = () => {
      this.folderIndexCache = null;
      this.allFoldersCache = null;
    };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
    this.app.workspace.onLayoutReady(() => {
      const mc = this.app.metadataCache;
      const paths = new Set([...Object.keys(mc.resolvedLinks), ...Object.keys(mc.unresolvedLinks)]);
      for (const path of paths) this.reflectFolderLinks(path);
      (mc as any).trigger("resolved");

      // 4. Autocomplete: offer folders (that have an index note) as link targets
      // and drop the index notes themselves, so editors link to the folder — not
      // to `README`. Patches the built-in link suggester (internal API).
      this.patchLinkSuggest();
    });

    // 3. Following a link to an index-less folder makes the note *inside* the
    // folder rather than a sibling file of the same name (Obsidian would create a
    // file for any unresolved link anyway — this just puts it where it belongs).
    this.register(
      around(this.app.workspace as any, {
        openLinkText(original: (...a: any[]) => Promise<void>) {
          return async function (
            this: unknown,
            linktext: string,
            sourcePath: string,
            newLeaf?: unknown,
            openViewState?: unknown,
          ): Promise<void> {
            const { path: linkpath } = parseLinktext(linktext);
            if (!self.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) {
              const created = await self.createFolderNote(linkpath, sourcePath);
              if (created) {
                await self.app.workspace.getLeaf(newLeaf as any).openFile(created, openViewState as any);
                return;
              }
            }
            return original.call(this, linktext, sourcePath, newLeaf, openViewState);
          };
        },
      }),
    );
  }

  // Resolve a folder-pointing linkpath ("Docs/Infra", "Docs/Infra/", "Infra") to
  // the first existing candidate index note inside that folder.
  resolveFolderNote(linkpath: string, sourcePath: string): TFile | null {
    const folder = this.linkedFolder(linkpath, sourcePath);
    if (!folder) return null;
    for (const rawName of this.settings.candidateNames) {
      const rel = withExtension(rawName);
      const path = normalizePath(folder.path ? `${folder.path}/${rel}` : rel);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
    }
    return null;
  }

  // Create the configured index note inside a linked folder that has none, and
  // return it. Returns null if the link isn't a folder or creation is off.
  private async createFolderNote(linkpath: string, sourcePath: string): Promise<TFile | null> {
    if (!this.settings.createOnFollow) return null;
    const folder = this.linkedFolder(linkpath, sourcePath);
    if (!folder) return null;
    const rel = withExtension(this.settings.createName);
    const path = normalizePath(folder.path ? `${folder.path}/${rel}` : rel);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    if (existing) return null; // a folder sits at that path — don't clobber
    try {
      return await this.app.vault.create(path, "");
    } catch {
      return null;
    }
  }

  // Move any unresolved links from `sourcePath` that point at a folder note into
  // resolvedLinks, so the graph and backlinks show them as real edges.
  private reflectFolderLinks(sourcePath: string): void {
    const mc = this.app.metadataCache;
    const unresolved = mc.unresolvedLinks[sourcePath];
    if (!unresolved) return;
    for (const linktext of Object.keys(unresolved)) {
      const dest = this.resolveFolderNote(linktext, sourcePath);
      if (!dest || dest.path === sourcePath) continue;
      const resolved = (mc.resolvedLinks[sourcePath] ??= {});
      resolved[dest.path] = (resolved[dest.path] ?? 0) + unresolved[linktext];
      delete unresolved[linktext];
    }
  }

  // The TFolder a linkpath points at: strip #subpath and a trailing slash, then
  // match an exact path (relative to the source, then vault root), else the
  // shortest-path folder whose name matches (via the cached index).
  private linkedFolder(linkpath: string, sourcePath: string): TFolder | null {
    if (!linkpath) return null;
    const clean = linkpath.split("#")[0].replace(/\/+$/, "").trim();
    if (!clean) return null;

    const sourceFolder = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const exactPaths = [sourceFolder ? `${sourceFolder}/${clean}` : "", clean].filter(Boolean);
    for (const p of exactPaths) {
      const af = this.app.vault.getAbstractFileByPath(normalizePath(p));
      if (af instanceof TFolder) return af;
    }

    const base = clean.split("/").pop() as string;
    let best: TFolder | null = null;
    for (const folder of this.getFolderIndex().get(base) ?? []) {
      const pathMatches = !clean.includes("/") || folder.path.endsWith(clean);
      if (pathMatches && (!best || folder.path.length < best.path.length)) best = folder;
    }
    return best;
  }

  // Lazily-built { folder name → folders } index, invalidated on folder changes,
  // so the basename fallback is a map lookup instead of a full-tree walk.
  private getFolderIndex(): Map<string, TFolder[]> {
    if (this.folderIndexCache) return this.folderIndexCache;
    const index = new Map<string, TFolder[]>();
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          const arr = index.get(child.name);
          if (arr) arr.push(child);
          else index.set(child.name, [child]);
          walk(child);
        }
      }
    };
    walk(this.app.vault.getRoot());
    this.folderIndexCache = index;
    return index;
  }

  // All folders (cached, invalidated with the folder index). Every folder is a
  // valid link target: with an index note it resolves to it; without one it's an
  // unresolved link that create-on-follow fills in — and that Quartz renders as a
  // folder listing until then.
  private allFolders(): TFolder[] {
    if (this.allFoldersCache) return this.allFoldersCache;
    const result: TFolder[] = [];
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          result.push(child);
          walk(child);
        }
      }
    };
    walk(this.app.vault.getRoot());
    this.allFoldersCache = result;
    return result;
  }

  // The text to insert for a folder link: bare name if unique, else full path
  // (no brackets — they're already in the editor around the query).
  private folderLinktext(folder: TFolder): string {
    const sameName = this.getFolderIndex().get(folder.name) ?? [];
    return sameName.length <= 1 ? folder.name : folder.path;
  }

  // Rework the built-in link suggestions: drop the index notes and prepend the
  // folders that contain them, matched against the typed query.
  private augmentLinkSuggestions(items: unknown[], context: { query?: string }): unknown[] {
    const indexNames = new Set(this.settings.candidateNames.map(withExtension));
    const filtered = items.filter((s: any) => !(s?.file instanceof TFile && indexNames.has(s.file.name)));
    const query = String(context?.query ?? "")
      .toLowerCase()
      .replace(/\/+$/, "");
    if (!query) return filtered;
    const folders = this.allFolders()
      .filter((f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 8)
      .map((f) => ({ __folderNoteLink: f }));
    return [...folders, ...filtered];
  }

  // Patch the built-in link suggester (suggests[0]) to add folder targets and
  // hide index notes. Internal API — guarded, and a no-op if the shape changes.
  private patchLinkSuggest(): void {
    const suggests = (this.app.workspace as any).editorSuggest?.suggests;
    const link = Array.isArray(suggests) ? suggests[0] : undefined;
    if (!link || typeof link.getSuggestions !== "function" || typeof link.selectSuggestion !== "function") {
      return;
    }
    const self = this;
    this.register(
      around(link, {
        getSuggestions(original: (ctx: any) => unknown) {
          return function (this: unknown, context: any) {
            const out = original.call(this, context);
            const process = (items: unknown[]) => self.augmentLinkSuggestions(items ?? [], context);
            return out instanceof Promise ? out.then(process) : process(out as unknown[]);
          };
        },
        renderSuggestion(original: (v: any, el: HTMLElement) => void) {
          return function (this: unknown, value: any, el: HTMLElement) {
            const folder: TFolder | undefined = value?.__folderNoteLink;
            if (folder) {
              el.addClass("mod-complex");
              const content = el.createDiv({ cls: "suggestion-content" });
              content.createDiv({ cls: "suggestion-title", text: folder.name });
              content.createDiv({ cls: "suggestion-note", text: folder.path });
              el.createDiv({ cls: "suggestion-aux" }).createSpan({
                cls: "suggestion-flair",
                text: "folder",
              });
              return;
            }
            return original.call(this, value, el);
          };
        },
        selectSuggestion(original: (v: any, evt: any) => void) {
          return function (this: any, value: any, evt: any) {
            const folder: TFolder | undefined = value?.__folderNoteLink;
            if (folder) {
              const ctx = this.context;
              if (ctx?.editor && ctx.start && ctx.end) {
                const target = self.folderLinktext(folder);
                ctx.editor.replaceRange(target, ctx.start, ctx.end);
                ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + target.length });
              }
              if (typeof this.close === "function") this.close();
              return;
            }
            return original.call(this, value, evt);
          };
        },
      }),
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class FolderNoteLinksSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: FolderNoteLinksPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Folder note names")
      .setDesc(
        "Names to look for inside a linked folder, one per line, in priority order. " +
          "Case-sensitive. A bare name means Markdown (.md); add an extension " +
          "(e.g. Index.base) to target another type. First match wins.",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.plugin.settings.candidateNames.join("\n")).onChange(async (value) => {
          this.plugin.settings.candidateNames = value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Create on follow")
      .setDesc(
        "When you follow a link to a folder that has no index note, create one inside " +
          "the folder (instead of a sibling file with the same name).",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.createOnFollow).onChange(async (value) => {
          this.plugin.settings.createOnFollow = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Name to create")
      .setDesc("Note name to create for the above (extension optional, .md implied).")
      .addText((text) =>
        text
          .setPlaceholder("index")
          .setValue(this.plugin.settings.createName)
          .onChange(async (value) => {
            this.plugin.settings.createName = value.trim() || DEFAULT_SETTINGS.createName;
            await this.plugin.saveSettings();
          }),
      );
  }
}
