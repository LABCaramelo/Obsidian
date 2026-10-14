import { Events } from './util.js';

const api = window.basalto.vault;

export const DEFAULT_SETTINGS = {
  theme: 'dark', // dark | light | system
  accentColor: '#8b6cf6',
  fontSize: 16,
  readableLineLength: true,
  livePreview: true,
  defaultViewMode: 'source', // source | preview
  showLineNumbers: false,
  foldHeadings: true,
  vimMode: false,
  spellcheck: true,
  strictLineBreaks: false,
  newFileLocation: 'root', // root | current | folder
  newFileFolder: '',
  attachmentFolder: '',
  autoUpdateLinks: true,
  dailyNotesFolder: '',
  dailyNoteFormat: 'YYYY-MM-DD',
  dailyNoteTemplate: '',
  templatesFolder: 'Templates',
  confirmDelete: true,
};

// Keys follow the graph settings file observed in the original app (.obsidian/graph.json).
export const DEFAULT_GRAPH_SETTINGS = {
  search: '',
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  centerStrength: 0.52,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1,
};

/** A JSON settings file stored under .basalto/ in the vault, with defaults. */
export class ConfigFile extends Events {
  constructor(name, defaults) {
    super();
    this.name = name;
    this.defaults = defaults;
    this.data = { ...defaults };
    this._timer = null;
  }

  async load() {
    const stored = await api.readConfig(this.name);
    this.data = { ...this.defaults, ...(stored || {}) };
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.emit('change', patch);
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), 300);
  }

  save() {
    clearTimeout(this._timer);
    return api.writeConfig(this.name, this.data);
  }
}
