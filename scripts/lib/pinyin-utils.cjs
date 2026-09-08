/**
 * Helpers for generating pinyin-based search tokens.
 */
const { pinyin } = require("pinyin-pro");

/**
 * Returns compact lowercased pinyin initials for a name.
 *
 * @param {string} value Text to convert.
 * @returns {string} Initials without whitespace, or an empty string.
 */
function getPinyinInitials(value) {
  const text = `${value || ""}`.trim();
  if (!text) {
    return "";
  }

  return pinyin(text, {
    pattern: "first",
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
    surname: "head",
  })
    .join("")
    .replace(/\s+/g, "")
    .toLowerCase();
}

module.exports = {
  getPinyinInitials,
};
