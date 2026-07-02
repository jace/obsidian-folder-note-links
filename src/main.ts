import { around } from "monkey-around";
import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

interface FolderNoteLinksSettings {
  // Index-note basenames to try, in order, inside a linked folder. `{{folder_name}}`
  // expands to the folder's own name. First one that exists wins.
  candidateNames: string[];
  // When the "Folder notes" plugin is installed, also recognize its configured note name.
  deferToFolderNotes: boolean;
}

const DEFAULT_SETTINGS: FolderNoteLinksSettings = {
  // `index` first to match Quartz's folder-index convention, then README, then a
  // note named after the folder. First existing candidate wins.
  candidateNames: ["index", "README", "{{folder_name}}"],
  deferToFolderNotes: true,
};

export default class FolderNoteLinksPlugin extends Plugin {
  settings: FolderNoteLinksSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FolderNoteLinksSettingTab(this.app, this));

    // Wrap Obsidian's single link-resolution entry point. When a wikilink
    // resolves to nothing (no note of that name), and it actually points at a
    // folder, resolve it to that folder's folder note instead. `around` from
    // monkey-around restores cleanly on unload even if other plugins also wrap.
    const self = this;
    this.register(
      around(this.app.metadataCache as any, {
        getFirstLinkpathDest(original: (lp: string, sp: string) => TFile | null) {
          return function (this: unknown, linkpath: string, sourcePath: string): TFile | null {
            const dest = original.call(this, linkpath, sourcePath);
            if (dest) return dest; // a real note matched — never override it
            return self.resolveFolderNote(linkpath, sourcePath);
          };
        },
      }),
    );
  }

  // Resolve a folder-pointing linkpath (e.g. "Docs/Infra", "Docs/Infra/", "Infra")
  // to the first existing candidate index note inside that folder.
  resolveFolderNote(linkpath: string, sourcePath: string): TFile | null {
    if (!linkpath) return null;
    // Drop any #heading / #^block subpath, then a trailing slash.
    const clean = linkpath.split("#")[0].replace(/\/+$/, "").trim();
    if (!clean) return null;

    const folder = this.findFolder(clean, sourcePath);
    if (!folder) return null;

    for (const rawName of this.candidateNames()) {
      const name = rawName.replace(/\{\{\s*folder_name\s*\}\}/g, folder.name);
      const path = folder.path ? `${folder.path}/${name}.md` : `${name}.md`;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (file instanceof TFile) return file;
    }
    return null;
  }

  // Find the TFolder a linkpath refers to: exact path (relative to the source
  // file, then vault root), else the shortest-path folder whose name matches.
  private findFolder(linkpath: string, sourcePath: string): TFolder | null {
    const vault = this.app.vault;

    const sourceFolder = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const exactPaths = [sourceFolder ? `${sourceFolder}/${linkpath}` : "", linkpath].filter(Boolean);
    for (const p of exactPaths) {
      const af = vault.getAbstractFileByPath(normalizePath(p));
      if (af instanceof TFolder) return af;
    }

    // Basename fallback (like Obsidian's shortest-path note resolution). If the
    // linkpath contains slashes, also require the folder's path to end with it.
    const base = linkpath.split("/").pop() as string;
    let best: TFolder | null = null;
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          const pathMatches = !linkpath.includes("/") || child.path.endsWith(linkpath);
          if (child.name === base && pathMatches) {
            if (!best || child.path.length < best.path.length) best = child;
          }
          walk(child);
        }
      }
    };
    walk(vault.getRoot());
    return best;
  }

  // The configured candidate names, plus the Folder Notes plugin's own name if it
  // isn't already covered — appended so it's recognized without overriding the
  // priority order above.
  private candidateNames(): string[] {
    const names = [...this.settings.candidateNames];
    if (this.settings.deferToFolderNotes) {
      const configured = (this.app as any).plugins?.plugins?.["folder-notes"]?.settings
        ?.folderNoteName;
      if (typeof configured === "string" && configured.trim() && !names.includes(configured)) {
        names.push(configured);
      }
    }
    return names;
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
        "Index-note basenames to look for inside a linked folder, one per line, in priority order. " +
          "Use {{folder_name}} for a note named after the folder. First match wins.",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text
          .setValue(this.plugin.settings.candidateNames.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.candidateNames = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Recognize the Folder Notes plugin's name")
      .setDesc(
        "When the Folder Notes plugin is installed, also try its configured folder-note name " +
          "(added to the list above if not already there), so a custom name stays in sync.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deferToFolderNotes).onChange(async (value) => {
          this.plugin.settings.deferToFolderNotes = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
