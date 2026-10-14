'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Keeps vault mutations in invocation order, including writes followed by moves/deletes. */
class SerialQueue {
  constructor() {
    this.pending = Promise.resolve();
  }

  run(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
}

/** Replaces a file only after its complete new contents have reached a sibling file. */
async function atomicWrite(file, data, fs = fsp) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, data, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

module.exports = { SerialQueue, atomicWrite };
