'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_PER_SERVICE = 700;

function emptyState() {
  return { results: {}, history: {}, incidents: [], meta: {}, lastRun: null };
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = emptyState();
    try {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] ${file} unreadable, starting empty: ${err.message}`);
    }
  }

  pushHistory(id, entry) {
    const list = this.state.history[id] || (this.state.history[id] = []);
    list.push(entry);
    if (list.length > HISTORY_PER_SERVICE) list.splice(0, list.length - HISTORY_PER_SERVICE);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(this.state);
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows can refuse the rename while another process holds the file.
      fs.writeFileSync(this.file, text);
    }
  }
}

module.exports = { Store };
