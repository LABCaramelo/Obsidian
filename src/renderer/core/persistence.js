/** Flushes a text editor without marking an in-flight write as already saved. */
export function flushTextEdits(view, write) {
  if (view._savePromise) return view._savePromise;
  const run = async () => {
    while (view.dirty && view.file) {
      const file = view.file;
      const text = view.text;
      await write(file, text);
      // Edits made while the write was pending need their own successful write.
      if (view.file === file && view.text === text) view.dirty = false;
    }
  };
  const pending = run().finally(() => {
    if (view._savePromise === pending) view._savePromise = null;
  });
  view._savePromise = pending;
  return pending;
}
