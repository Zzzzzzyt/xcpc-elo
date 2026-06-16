const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const EXCLUDED_CONTEST_PATTERNS = [/world\s*finals?/i, /worldfinals?/i, /macau/i, /university/i, /rejudge/i, /ucup/i];
const ORGANIZATION_NAME_FIXES = new Map([
  ["上海理エ大学", "上海理工大学"],
  ["哈尔滨エ业大学", "哈尔滨工业大学"],
  ["澳门大学(Universidade de Macau)", "澳门大学"],
  ["蒙古国立大学（Монгол Улсын Их Сургууль）", "蒙古国立大学"],
  ["National University of Mongolia", "蒙古国立大学"],
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

function normalizeOrganizationName(value) {
  var normalized = normalize(resolveText(value));
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

function normalizeForMatch(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\s_－—-]+/g, "")
    .replace(/[()（）·・.,，。:：'"`]/g, "");
}

function isSpecialMemberName(name) {
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
  if (isSpecialMemberName(s)) return false;
  return /[a-zA-Z\u4e00-\u9fff0-9]/.test(s);
}

function normalizeRowTeamMembers(row) {
  const user = row && row.user ? row.user : {};
  const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
  const normalized = [];

  for (const member of teamMembers) {
    const raw = normalize(resolveText(member && member.name));
    if (!raw || isSpecialMemberName(raw)) {
      continue;
    }
    normalized.push({ name: raw.replace(/^\s+|\s+$/g, "") });
  }

  user.teamMembers = normalized;
  if (user.organization !== undefined) {
    user.organization = normalizeOrganizationName(user.organization);
  }
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

  let totalCount = 0;
  let invalidCount = 0;
  let strangeCount = 0;
  const invalidRows = [];
  const strangeRows = [];

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
  normalizeOrganizationName,
  normalizeForMatch,
  normalizeRanklistTeamMembers,
  parseCollectionConfig,
  readJson,
  resolveText,
  shouldSkipContest,
  isSpecialMemberName,
  isValidParticipantName,
  writeJson,
};
