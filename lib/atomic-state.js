'use strict';

// Adapted from CoimgRain's Codex Mini v5.8.5 atomic state writer; see LICENSE.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeJsonAtomically(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    // Windows does not support fsync on directories. The replaced file was
    // flushed above; never unlink the old state to work around a rename error.
    if (process.platform !== 'win32') {
      let directory;
      try {
        directory = fs.openSync(path.dirname(filePath), 'r');
        fs.fsyncSync(directory);
      } catch {} finally {
        if (directory !== undefined) fs.closeSync(directory);
      }
    }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = { writeJsonAtomically };
