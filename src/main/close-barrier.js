'use strict';

/** A window may close only after its renderer confirms a successful save flush. */
class CloseBarrier {
  constructor({ request, close, failed }) {
    this.request = request;
    this.close = close;
    this.failed = failed;
    this.nextId = 0;
    this.pending = null;
    this.approved = false;
  }

  onClose(event) {
    if (this.approved) return true;
    event.preventDefault();
    if (this.pending === null) {
      this.pending = ++this.nextId;
      this.request(this.pending);
    }
    return false;
  }

  complete(id, error) {
    if (id !== this.pending || this.pending === null) return false;
    this.pending = null;
    if (error) {
      this.failed(error);
      return false;
    }
    this.approved = true;
    this.close();
    return true;
  }
}

module.exports = { CloseBarrier };
