"use strict";

const fs = require("node:fs");
const { TextDecoder } = require("node:util");

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class SafeInputError extends Error {}

function readFileWithinLimit(file, limit) {
  if (process.platform === "win32") {
    try {
      return require("./windows-safe-input.cjs").readFileWithinLimit(file, limit);
    } catch (error) {
      if (error && error.code === "DSH_SAFE_INPUT") throw new SafeInputError(error.message);
      throw error;
    }
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || noFollow === 0 || !Number.isInteger(nonBlock) || nonBlock === 0) {
    // Node exposes no race-safe fallback on these platforms, so reject all inputs.
    throw new SafeInputError("OS no-follow and nonblocking input protection is unavailable");
  }

  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) throw new SafeInputError("input must not be a symlink");
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new SafeInputError("input must be a regular file");
    if (stat.size > limit) throw new SafeInputError(`input exceeds ${limit} byte limit`);

    // Use the size of the opened file as a hint. Reserve a byte to detect EOF
    // without a second allocation when the size is unchanged.
    let buffer = Buffer.allocUnsafe(stat.size + 1);
    let bytesRead = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > limit) throw new SafeInputError(`input exceeds ${limit} byte limit`);
      if (bytesRead === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit + 1, Math.max(buffer.length * 2, 64 * 1024)));
        buffer.copy(grown, 0, 0, bytesRead);
        buffer = grown;
      }
    }
    try {
      return UTF8_DECODER.decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new SafeInputError("input is not valid UTF-8");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { SafeInputError, readFileWithinLimit };
