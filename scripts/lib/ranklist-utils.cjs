/**
 * Ranklist normalization, contest discovery, and file helpers.
 */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const crypto = require("crypto");

const EXCLUDED_CONTEST_PATTERNS = [
  /world\s*finals?/i,
  /worldfinals?/i,
  /macau/i,
  /university/i,
  /rejudge/i,
  /ucup/i,
  /ahcpc2026preliminary/i,
];
const ORGANIZATION_NAME_FIXES = new Map([
  ["上海理エ大学", "上海理工大学"],
  ["哈尔滨エ业大学", "哈尔滨工业大学"],
  ["澳门大学(Universidade de Macau)", "澳门大学"],
  ["蒙古国立大学（Монгол Улсын Их Сургууль）", "蒙古国立大学"],
  ["National University of Mongolia", "蒙古国立大学"],
  ["Mongolian University of Science and Technology", "蒙古科技大学"],
  ["哈尔滨理工大学（荣成校区）", "哈尔滨理工大学（荣成）"],
  ["哈尔滨理工大学荣成校区", "哈尔滨理工大学（荣成）"],
  ["哈尔滨理工大学荣成学院", "哈尔滨理工大学（荣成）"],
  ["河北农业大学渤海学院", "河北农业大学渤海校区"],
  ["北京交通大学（威海）", "北京交通大学威海校区"],
  ["北京师范大学（珠海校区）", "北京师范大学珠海校区"],
  ["大连理工大学（盘锦校区）", "大连理工大学盘锦校区"],
  ["山东科技大学（济南）", "山东科技大学济南校区"],
  ["北京师范大学珠海分校", "北京师范大学珠海校区"],
  ["中国人民解放军战略支援部队信息工程大学", "战略支援部队信息工程大学"],
  ["中国人民解放军信息工程大", "信息工程大学"],
  ["中国人民解放军信息工程大学", "信息工程大学"],

  ["代码源+", "代码源"],
  ["社会参赛（代码源）", "代码源"],
  ["华为", "华为技术有限公司"],
  ["华为公司", "华为技术有限公司"],
  ["华为战队", "华为技术有限公司"],
  ["洛谷网络科技", "洛谷科技"],
  ["南昌五中", "南昌市第五中学"],
  ["牛客网", "牛客竞赛"],
  ["腾讯科技（深圳）有限公司", "腾讯"],

  ["个人", "个人参赛"],
  ["个人报名", "个人参赛"],
  ["个人打星", "个人参赛"],
  ["个人联合参赛", "个人参赛"],
  ["打星参赛", "个人参赛"],
  ["友情参赛", "个人参赛"],

  ["浙江省诸暨海亮高级中学", "浙江省诸暨市海亮高级中学"],
  ["杭高", "浙江省杭州高级中学"],
  ["杭州高级中学", "浙江省杭州高级中学"],
  ["杭二中", "杭州第二中学"],
  ["杭州市第二中学", "杭州第二中学"],
  ["浙江省杭州第二中学", "杭州第二中学"],
  ["成都市第七中学", "四川省成都市第七中学"],
  ["绍兴一中", "绍兴市第一中学"],
  ["重庆市鲁能巴蜀中学校", "重庆市鲁能巴蜀中学"],
  ["鲁能巴蜀中学", "重庆市鲁能巴蜀中学"],
  ["长郡中学", "长沙市长郡中学"],
  ["雅礼中学", "长沙市雅礼中学"],
  ["学军中学", "杭州学军中学"],
  ["金陵中学河西分校", "南京市金陵中学河西分校"],
]);

/**
 * Creates a directory recursively when needed.
 *
 * @param {string} dirPath Directory path.
 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Reads and parses a UTF-8 JSON file.
 *
 * @param {string} filePath File path.
 * @returns {*} Parsed JSON value.
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Writes a JSON file as formatted or minified UTF-8 text.
 *
 * @param {string} filePath Output path.
 * @param {*} value Value to serialize.
 * @param {boolean} [minify=false] When true, omits whitespace.
 */
function writeJson(filePath, value, minify = false) {
  ensureDir(path.dirname(filePath));
  const jsonString = minify ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  fs.writeFileSync(filePath, jsonString, "utf8");
}

/**
 * Resolves localized or scalar text fields used by SRK data.
 *
 * @param {*} value String, localized object, or missing value.
 * @returns {string} Resolved text.
 */
function resolveText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return value["zh-CN"] || value.en || value.fallback || Object.values(value).find((v) => typeof v === "string") || "";
}

/**
 * Trims whitespace and collapses internal whitespace runs.
 *
 * @param {*} value Value to normalize.
 * @returns {string} Normalized string.
 */
function normalize(value) {
  return `${value || ""}`.trim().replace(/\s+/g, " ");
}

/**
 * Builds a normalized organization/name pair key.
 *
 * @param {string} organization Organization name.
 * @param {string} name Teammate name.
 * @returns {string} Stable pair key.
 */
function teammatePairKey(organization, name) {
  return `${normalize(organization)}\u0001${normalize(name)}`;
}

/**
 * Builds the stable public ID used for a teammate-organization pair.
 *
 * @param {string} organization Organization name.
 * @param {string} name Teammate name.
 * @returns {string} Stable `xcpc_` prefixed hash ID.
 */
function teammateHashId(organization, name) {
  const orgNorm = normalize(organization).toLowerCase();
  const memberNorm = normalize(name).toLowerCase();
  const raw = `${orgNorm}\u0001${memberNorm}`;
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return `xcpc_${digest.slice(0, 16)}`;
}

/**
 * Normalizes an organization name and applies known display-name fixes.
 *
 * @param {*} value Organization text or localized object.
 * @returns {string} Normalized organization name.
 */
function normalizeOrganizationName(value) {
  let normalized = normalize(resolveText(value));
  if (!normalized) {
    return "";
  }
  if (/[a-zA-Z]/.test(normalized[0])) {
    normalized = normalized.replace("（", "(").replace("）", ")");
  } else {
    normalized = normalized.replace("(", "（").replace(")", "）");
  }
  return ORGANIZATION_NAME_FIXES.get(normalized) || normalized;
}

/**
 * Normalizes text into a lossy matching key.
 *
 * @param {*} value Text to normalize.
 * @returns {string} Compact matching key.
 */
function normalizeForMatch(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\s_－—-]+/g, "")
    .replace(/[()（）·・.,，。:：'"`]/g, "");
}

/**
 * Detects names that are placeholders, empty, or coach roles.
 *
 * @param {string} name Teammate name.
 * @returns {boolean} True when the name should not be treated as a participant.
 */
function isSpecialMemberName(name) {
  const s = normalize(name);
  if (!s) return true;
  if (/^(无|無|空)$/i.test(s)) return true;
  return /coach|教练/i.test(s);
}

/**
 * Checks whether a participant name is usable for Elo identity.
 *
 * @param {string} name Teammate name.
 * @returns {boolean} True when the name is a valid participant name.
 */
function isValidParticipantName(name) {
  const s = normalize(name);
  if (!s) return false;
  if (s.length < 2) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^(unknown|n\/?a|null|none|anonymous|匿名|待定|未知|未命名|未填写|-)$/i.test(s)) return false;
  if (isSpecialMemberName(s)) return false;
  return /[a-zA-Z\u4e00-\u9fff0-9]/.test(s);
}

/**
 * Cleans teammate and organization fields in place on one ranklist row.
 *
 * @param {object} row Ranklist row to normalize.
 */
function normalizeRowTeamMembers(row) {
  const user = row && row.user ? row.user : {};
  const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
  const normalized = [];

  for (const member of teamMembers) {
    if (member.role && member.role.toLowerCase() === "coach") {
      continue;
    }
    const raw = normalize(resolveText(member && member.name));
    if (!raw || isSpecialMemberName(raw)) {
      continue;
    }
    normalized.push({ name: raw });
  }

  user.teamMembers = normalized;
  if (user.organization !== undefined) {
    user.organization = normalizeOrganizationName(user.organization);
  }
  row.user = user;
}

/**
 * Normalizes teammate and organization fields on every ranklist row.
 *
 * @param {object} ranklist Ranklist to normalize in place.
 * @returns {object} The same ranklist object.
 */
function normalizeRanklistTeamMembers(ranklist) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  for (const row of rows) {
    normalizeRowTeamMembers(row);
  }
  return ranklist;
}

/**
 * Assesses participant names and reports invalid or suspicious rows.
 *
 * @param {object} ranklist Static ranklist data.
 * @returns {{invalid: boolean, detail: string, invalidRows: object[]}} Assessment summary.
 */
function assessParticipantNames(ranklist) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  if (!rows.length) {
    return {
      invalid: true,
      detail: "no participants",
      invalidRows: [],
    };
  }

  let totalCount = 0;
  let invalidCount = 0;
  let strangeCount = 0;
  const invalidRows = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const user = row && row.user ? row.user : {};
    const members = user.teamMembers;
    const invalidNames = [];
    const strangeNames = [];

    if (members.length > 3) {
      strangeNames.push(...members.map((m) => m.name));
    } else {
      for (const member of members) {
        const name = member.name;
        if (name.length > 4 || name.length < 2) {
          strangeNames.push(name);
          strangeCount += 1;
        }
        totalCount += 1;
        if (!isValidParticipantName(name)) {
          invalidNames.push(name);
          invalidCount += 1;
        }
      }
    }

    if (invalidNames.length > 0 || strangeNames.length > 0) {
      invalidRows.push({
        rowIndex,
        rank: rowIndex + 1,
        organization: normalize(resolveText(user.organization)),
        team: normalize(resolveText(user.name)),
        invalidNames,
        strangeNames,
      });
    }
  }

  return {
    invalid: invalidCount > 0,
    detail: `invalidCount=${invalidCount} strangeCount=${strangeCount} totalCount=${totalCount}`,
    invalidRows,
  };
}

/**
 * Recursively collects SRK file entries from a collection config.
 *
 * @param {string} collectionDir Directory containing `config.yaml`.
 * @returns {object[]} Config entries for SRK ranklist files.
 */
function parseCollectionConfig(collectionDir) {
  const configPath = path.join(collectionDir, "config.yaml");
  const configRaw = fs.readFileSync(configPath, "utf8");
  const config = yaml.load(configRaw);

  if (!config || !config.root || !Array.isArray(config.root.children)) {
    throw new Error(`Invalid collection config: ${configPath}`);
  }

  const files = [];

  /**
   * Walks one config node.
   *
   * @param {object} item Config node.
   * @param {string} basePath Parent path accumulated by the walk.
   */
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
        // The collection config name is the curated short label used by the UI.
        alias: typeof item.name === "string" ? item.name.trim() : "",
      });
    }
  }

  for (const child of config.root.children) {
    walk(child, "");
  }

  return files;
}

/**
 * Returns whether a contest should be omitted from Elo processing.
 *
 * @param {object} entry Collection config entry.
 * @param {object} ranklist Parsed ranklist for the entry.
 * @returns {{skip: boolean, reason?: string, detail?: string}} Skip decision.
 */
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

module.exports = {
  assessParticipantNames,
  ensureDir,
  normalize,
  normalizeOrganizationName,
  normalizeForMatch,
  normalizeRanklistTeamMembers,
  parseCollectionConfig,
  readJson,
  resolveText,
  shouldSkipContest,
  teammateHashId,
  teammatePairKey,
  isSpecialMemberName,
  isValidParticipantName,
  writeJson,
};
