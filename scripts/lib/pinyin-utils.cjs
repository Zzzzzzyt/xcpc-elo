const { pinyin } = require("pinyin-pro");

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
