import { View } from '../workspace/workspace.js';
import { el, basename, extname, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT } from '../core/util.js';

/** Shows non-Markdown files: images, PDFs, audio and video. */
export class FileView extends View {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.containerEl.classList.add('file-view');
  }

  get type() {
    return 'file';
  }

  getDisplayText() {
    return this.file ? basename(this.file) : 'Arquivo';
  }

  getIcon() {
    return this.file && IMAGE_EXT.has(extname(this.file)) ? 'file-image' : 'file';
  }

  getState() {
    return { file: this.file };
  }

  async setState(state) {
    this.file = state.file;
    this.render();
    this.app.workspace.emit('file-open', this.file, this.leaf);
  }

  render() {
    this.containerEl.textContent = '';
    if (!this.file) return;
    const url = this.app.vault.fileUrl(this.file);
    const ext = extname(this.file);
    let content;
    if (IMAGE_EXT.has(ext)) content = el('img', { src: url, alt: basename(this.file) });
    else if (ext === 'pdf') content = el('iframe', { src: url, class: 'pdf-frame' });
    else if (AUDIO_EXT.has(ext)) content = el('audio', { src: url, controls: true });
    else if (VIDEO_EXT.has(ext)) content = el('video', { src: url, controls: true });
    else {
      const btn = el('button', { class: 'mod-cta', text: 'Abrir no aplicativo padrão' });
      btn.addEventListener('click', () => window.basalto.shell.openPath(this.file));
      content = el('div', { class: 'empty-state' }, el('div', { class: 'empty-state-title', text: `Não é possível visualizar arquivos .${ext}` }), btn);
    }
    this.containerEl.appendChild(el('div', { class: 'file-view-inner' }, content));
  }

  onFileRenamed(newPath) {
    this.file = newPath;
    this.leaf.updateHeader();
  }
}
