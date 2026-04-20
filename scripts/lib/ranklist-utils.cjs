const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const EXCLUDED_CONTEST_PATTERNS = [
  /world\s*finals?/i,
  /worldfinals?/i,
  /macau/i,
  /university/i,
  /rejudge/i,
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return value["zh-CN"] || value.en || value.fallback || Object.values(value).find((v) => typeof v === "string") || "";
}

function normalize(value) {
  return `${value || ""}`.trim().replace(/\s+/g, " ");
}

function normalizeForMatch(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\s_－—-]+/g, "")
    .replace(/[()（）·・.,，。:：'"`]/g, "");
}

function isMetaMemberName(name) {
  const s = normalize(name);
  if (!s) return true;
  if (/^(无|無|空)$/i.test(s)) return true;
  return /coach|教练/i.test(s);
}

function isValidParticipantName(name) {
  const s = normalize(name);
  if (!s) return false;
  if (s.length < 2) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^(unknown|n\/?a|null|none|anonymous|匿名|待定|未知|未命名|未填写|-)$/i.test(s)) return false;
  if (isMetaMemberName(s)) return false;
  return /[a-zA-Z\u4e00-\u9fff0-9]/.test(s);
}

function normalizeRowTeamMembers(row) {
  const user = row && row.user ? row.user : {};
  const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
  const normalized = [];

  for (const member of teamMembers) {
    const raw = normalize(resolveText(member && member.name));
    if (!raw || isMetaMemberName(raw)) {
      continue;
    }
    const parts = raw
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      for (const part of parts) {
        if (!isMetaMemberName(part)) {
          normalized.push({ name: part });
        }
      }
    } else {
      normalized.push({ name: raw.replace(/^\s+|\s+$/g, "") });
    }
  }

  user.teamMembers = normalized;
  row.user = user;
}

function normalizeRanklistTeamMembers(ranklist) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  for (const row of rows) {
    normalizeRowTeamMembers(row);
  }
  return ranklist;
}

function assessParticipantNames(ranklist) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  if (!rows.length) {
    return {
      invalid: true,
      detail: "no participants",
      invalidRows: [],
    };
  }

  let totalNames = 0;
  let validNames = 0;
  const invalidRows = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const user = row && row.user ? row.user : {};
    const members = Array.isArray(user.teamMembers) ? user.teamMembers : [];
    const invalidNames = [];

    for (const member of members) {
      const name = normalize(resolveText(member && member.name));
      if (!name || isMetaMemberName(name)) {
        continue;
      }
      totalNames += 1;
      if (isValidParticipantName(name)) {
        validNames += 1;
      } else {
        invalidNames.push(name);
      }
    }

    if (invalidNames.length) {
      invalidRows.push({
        rowIndex,
        rank: rowIndex + 1,
        organization: normalize(resolveText(user.organization)),
        team: normalize(resolveText(user.name)),
        invalidNames,
      });
    }
  }

  return {
    invalid: validNames !== totalNames,
    detail: `validNames=${validNames}, totalNames=${totalNames}`,
    validNames,
    totalNames,
    invalidRows,
  };
}

function parseCollectionConfig(collectionDir) {
  const configPath = path.join(collectionDir, "config.yaml");
  const configRaw = fs.readFileSync(configPath, "utf8");
  const config = yaml.load(configRaw);

  if (!config || !config.root || !Array.isArray(config.root.children)) {
    throw new Error(`Invalid collection config: ${configPath}`);
  }

  const files = [];

  function walk(item, basePath) {
    if (!item || typeof item !== "object") {
      return;
    }

    const itemPath = `${item.path || ""}`.replace(/\\/g, "/");
    const currentPath = path.posix.join(basePath, itemPath);

    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        walk(child, currentPath);
      }
      return;
    }

    if (item.format === "srk.json") {
      files.push({
        uniqueKey: item.path,
        relativeFilePath: `${currentPath}.${item.format}`,
      });
    }
  }

  for (const child of config.root.children) {
    walk(child, "");
  }

  return files;
}

function shouldSkipContest(entry, ranklist) {
  const title = resolveText(ranklist && ranklist.contest && ranklist.contest.title);
  const haystack = `${entry.uniqueKey} ${entry.relativeFilePath} ${title}`;

  if (EXCLUDED_CONTEST_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return {
      skip: true,
      reason: "excluded-category",
      detail: `matched excluded contest pattern: ${title || entry.uniqueKey}`,
    };
  }
  return { skip: false };
}

function collectStaticRanklistFiles(rootDir) {
  const files = [];
  function walk(dir) {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    for (const child of children) {
      const fullPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(fullPath);
      } else if (child.isFile() && child.name.endsWith(".static.srk.json")) {
        files.push(fullPath);
      }
    }
  }
  walk(rootDir);
  return files;
}

module.exports = {
  assessParticipantNames,
  collectStaticRanklistFiles,
  ensureDir,
  normalize,
  normalizeForMatch,
  normalizeRanklistTeamMembers,
  parseCollectionConfig,
  readJson,
  resolveText,
  shouldSkipContest,
  isMetaMemberName,
  isValidParticipantName,
  writeJson,
};
