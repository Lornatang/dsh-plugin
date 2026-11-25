const path = require("node:path");

function hasValidUnicodeScalarValues(value) {
  let index = 0;
  while (index < value.length) {
    const first = value.charCodeAt(index++);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index >= value.length) return false;
      const second = value.charCodeAt(index++);
      if (second < 0xdc00 || second > 0xdfff) return false;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function createValidationHelpers(errorLimit) {
  const VISIBLE_CONTENT = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
  const UNSAFE_DIAGNOSTIC_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
  const PATH_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
  const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;
  const MAX_DIAGNOSTIC_STRING_LENGTH = 256;

  function escapeUnsafeDiagnosticCharacters(value) {
    return String(value).replace(UNSAFE_DIAGNOSTIC_CHARACTER, (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : `\\u{${codePoint.toString(16)}}`;
    });
  }

  function safeQuote(value) {
    let serialized;
    if (typeof value === "string") {
      const clipped = value.length > MAX_DIAGNOSTIC_STRING_LENGTH
        ? `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}...`
        : value;
      serialized = JSON.stringify(clipped);
    } else if (value === null || typeof value === "boolean") {
      serialized = String(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      serialized = String(value);
    } else {
      serialized = `"<${Array.isArray(value) ? "array" : typeof value}>"`;
    }
    return escapeUnsafeDiagnosticCharacters(serialized);
  }

  function createErrorList() {
    const errors = [];
    Object.defineProperty(errors, "truncated", { value: false, writable: true, enumerable: false });
    Object.defineProperty(errors, "push", {
      value(...messages) {
        const remaining = errorLimit - this.length;
        if (remaining > 0) {
          Array.prototype.push.apply(this, messages.slice(0, remaining).map(escapeUnsafeDiagnosticCharacters));
        }
        if (messages.length > remaining) this.truncated = true;
        // The full list is saturated even when no message overflowed this push.
        if (this.length >= errorLimit) this.truncated = true;
        return this.length;
      },
    });
    return errors;
  }

  function hasVisibleProse(value) {
    return hasValidUnicodeScalarValues(value) && VISIBLE_CONTENT.test(value);
  }

  function isSafeRelativePath(value) {
    if (typeof value !== "string" || value.length === 0 || !hasValidUnicodeScalarValues(value) || value.trim() !== value || PATH_FORBIDDEN_CHARACTER.test(value) || value.includes("\\") || value.includes(":")) return false;
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("~")) return false;
    return value.split("/").every((segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !/[ .]$/u.test(segment) &&
      !WINDOWS_RESERVED_COMPONENT.test(segment));
  }

  return {
    PATH_FORBIDDEN_CHARACTER,
    WINDOWS_RESERVED_COMPONENT,
    UNSAFE_DIAGNOSTIC_CHARACTER,
    VISIBLE_CONTENT,
    createErrorList,
    escapeUnsafeDiagnosticCharacters,
    hasVisibleProse,
    isSafeRelativePath,
    safeQuote,
  };
}

module.exports = { createValidationHelpers, hasValidUnicodeScalarValues };
