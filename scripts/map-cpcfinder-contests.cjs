const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  DEFAULT_OUTPUT_DIR,
  asArray,
  extractCpcfinderLinks,
  loadCpcfinderIndex,
  normalizeText,
  normalizeUrlForMatch,
  readJson,
  writeJson,
} = require("./lib/cpcfinder.cjs");

function resolveText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return value["zh-CN"] || value.en || value.fallback || Object.values(value).find((v) => typeof v === "string") || "";
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

function normalizeDateString(input) {
  const value = `${input || ""}`.trim();
  if (!value) {
    return "";
  }
  const date = value.includes("T") ? value.slice(0, 10) : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function inferPrefixFromContestName(name) {
  const text = `${name || ""}`.toLowerCase();
  if (text.includes("icpc")) {
    return "icpc";
  }
  if (text.includes("ccpc")) {
    return "ccpc";
  }
  return "";
}

function normalizeBoardSlugToken(token) {
  const raw = `${token || ""}`.trim().toLowerCase();
  if (!raw) {
    return "";
  }

  if (raw === "xian") return "xi_an";
  if (raw === "ec-final") return "ecfinal";
  if (raw === "ecfinal") return "ecfinal";
  if (raw === "lady") return "ladies";
  if (raw === "11st") return "11th";
  return raw.replace(/-/g, "_");
}

function inferSrkKeyFromBoardUrl(boardUrl) {
  if (!boardUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(boardUrl);
  } catch {
    return null;
  }

  if (parsed.host.toLowerCase() !== "board.xcpcio.com") {
    return null;
  }

  const segments = parsed.pathname
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase());

  if (segments.length < 3) {
    return null;
  }

  const league = segments[0];
  const seasonPart = normalizeBoardSlugToken(segments[1]);
  const placePart = normalizeBoardSlugToken(segments[2]);
  if (!league || !seasonPart || !placePart) {
    return null;
  }

  let seasonYear = null;
  const nthMatch = seasonPart.match(/^(\d+)(st|nd|rd|th)$/);
  if (nthMatch) {
    const order = Number.parseInt(nthMatch[1], 10);
    if (league === "icpc") {
      seasonYear = 1975 + order;
    } else if (league === "ccpc") {
      seasonYear = 2014 + order;
    }
  } else if (/^\d{4}$/.test(seasonPart)) {
    seasonYear = Number.parseInt(seasonPart, 10);
  }

  if (!seasonYear) {
    return null;
  }

  return `${league}${seasonYear}${placePart}`;
}

function extractRankIdFromAlgouxLink(url) {
  if (!url) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.host.toLowerCase() !== "rl.algoux.cn") {
    return "";
  }
  return normalizeText(parsed.searchParams.get("rankId"));
}

function buildSrkIndex(collectionDir) {
  const configItems = parseCollectionConfig(collectionDir);
  const srkByKey = new Map();
  const srkByRefUrl = new Map();
  const srkByDate = new Map();

  for (const item of configItems) {
    const fullPath = path.join(collectionDir, item.relativeFilePath);
    const data = readJson(fullPath);
    const contest = data && data.contest ? data.contest : {};
    const title = normalizeText(resolveText(contest.title)) || item.uniqueKey;
    const startAt = normalizeText(contest.startAt);
    const date = normalizeDateString(startAt);
    const refLinks = asArray(contest.refLinks)
      .map((ref) => normalizeText(ref && ref.link))
      .filter(Boolean);
    const normalizedRefLinks = refLinks.map((url) => normalizeUrlForMatch(url)).filter(Boolean);

    const entry = {
      uniqueKey: item.uniqueKey,
      relativeFilePath: item.relativeFilePath,
      title,
      startAt,
      date,
      refLinks,
      normalizedRefLinks,
    };

    srkByKey.set(entry.uniqueKey, entry);

    for (const refUrl of normalizedRefLinks) {
      if (!srkByRefUrl.has(refUrl)) {
        srkByRefUrl.set(refUrl, new Set());
      }
      srkByRefUrl.get(refUrl).add(entry.uniqueKey);
    }

    if (date) {
      if (!srkByDate.has(date)) {
        srkByDate.set(date, []);
      }
      srkByDate.get(date).push(entry.uniqueKey);
    }
  }

  return {
    srkByKey,
    srkByRefUrl,
    srkByDate,
  };
}

function findByDatePrefixSingle(srkIndex, contestDate, prefix) {
  if (!contestDate || !prefix) {
    return "";
  }
  const keys = asArray(srkIndex.srkByDate.get(contestDate));
  const prefixMatched = keys.filter((key) => key.startsWith(prefix));
  return prefixMatched.length === 1 ? prefixMatched[0] : "";
}

function loadManualOverrides(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Map();
  }

  const raw = readJson(filePath);
  const items = Array.isArray(raw) ? raw : [];
  const overrides = new Map();

  for (const item of items) {
    const contestId = Number.parseInt(`${item && item.contestId ? item.contestId : ""}`, 10);
    const srkUniqueKey = normalizeText(item && item.srkUniqueKey);
    if (!Number.isFinite(contestId) || contestId <= 0 || !srkUniqueKey) {
      continue;
    }
    overrides.set(contestId, {
      contestId,
      srkUniqueKey,
      note: normalizeText(item && item.note),
    });
  }

  return overrides;
}

function doMapping(cpcIndexData, srkIndex, manualOverrides) {
  const records = asArray(cpcIndexData && cpcIndexData.records).filter((record) => !record.error);
  const success = [];
  const unmatched = [];
  const firstContestIdBySrkKey = new Map();

  for (const record of records) {
    const contestId = record && record.contestId ? record.contestId : null;
    const summary = record && record.summary ? record.summary : {};
    const detail = record && record.detail ? record.detail : {};
    const cpcName = normalizeText(summary.name || detail.name);
    const cpcDate = normalizeDateString(summary.date || detail.date);
    const links = extractCpcfinderLinks(record);
    const normalizedLinks = links.map((url) => normalizeUrlForMatch(url)).filter(Boolean);

    const algouxRankIds = links.map((url) => extractRankIdFromAlgouxLink(url)).filter(Boolean);
    const boardLinks = links.filter((url) => {
      try {
        return new URL(url).host.toLowerCase() === "board.xcpcio.com";
      } catch {
        return false;
      }
    });

    let mappedKey = "";
    let method = "";
    const evidence = {};

    const manual = manualOverrides && manualOverrides.get(contestId);
    if (manual) {
      if (srkIndex.srkByKey.has(manual.srkUniqueKey)) {
        mappedKey = manual.srkUniqueKey;
        method = "manual-override";
        evidence.note = manual.note || "";
      } else {
        unmatched.push({
          contestId,
          cpcName,
          cpcDate,
          links,
          reason: "manual-target-not-found",
          manualTarget: manual.srkUniqueKey,
        });
        continue;
      }
    }

    for (const rankId of algouxRankIds) {
      if (mappedKey) {
        break;
      }
      if (srkIndex.srkByKey.has(rankId)) {
        mappedKey = rankId;
        method = "rankId-link";
        evidence.rankId = rankId;
        break;
      }
    }

    if (!mappedKey) {
      const matchedKeys = new Set();
      for (const normUrl of normalizedLinks) {
        const candidates = srkIndex.srkByRefUrl.get(normUrl);
        if (!candidates) {
          continue;
        }
        for (const key of candidates) {
          matchedKeys.add(key);
        }
      }

      if (matchedKeys.size === 1) {
        mappedKey = [...matchedKeys][0];
        method = "ref-link";
        evidence.matchedRefUrls = normalizedLinks.filter((url) => srkIndex.srkByRefUrl.has(url));
      } else if (matchedKeys.size > 1) {
        unmatched.push({
          contestId,
          cpcName,
          cpcDate,
          links,
          reason: "ambiguous-ref-link",
          candidates: [...matchedKeys].sort(),
        });
        continue;
      }
    }

    if (!mappedKey) {
      const boardCandidates = boardLinks.map((url) => inferSrkKeyFromBoardUrl(url)).filter(Boolean);
      const validBoardCandidates = boardCandidates.filter((key) => srkIndex.srkByKey.has(key));
      const uniqueBoardCandidates = [...new Set(validBoardCandidates)];
      if (uniqueBoardCandidates.length === 1) {
        mappedKey = uniqueBoardCandidates[0];
        method = "board-link";
        evidence.boardLink = boardLinks[0] || "";
      } else if (uniqueBoardCandidates.length > 1) {
        unmatched.push({
          contestId,
          cpcName,
          cpcDate,
          links,
          reason: "ambiguous-board-link",
          candidates: uniqueBoardCandidates.sort(),
        });
        continue;
      }
    }

    if (!mappedKey) {
      const prefix = inferPrefixFromContestName(cpcName);
      const singleByDate = findByDatePrefixSingle(srkIndex, cpcDate, prefix);
      if (singleByDate) {
        mappedKey = singleByDate;
        method = "date-prefix-single";
        evidence.date = cpcDate;
        evidence.prefix = prefix;
      }
    }

    if (!mappedKey) {
      unmatched.push({
        contestId,
        cpcName,
        cpcDate,
        links,
        reason: "no-match",
      });
      continue;
    }

    const srkEntry = srkIndex.srkByKey.get(mappedKey);
    const duplicateOfContestId = firstContestIdBySrkKey.get(mappedKey) || null;
    if (!firstContestIdBySrkKey.has(mappedKey)) {
      firstContestIdBySrkKey.set(mappedKey, contestId);
    }

    success.push({
      contestId,
      cpcName,
      cpcDate,
      method,
      evidence,
      duplicateOfContestId,
      links,
      srkUniqueKey: srkEntry.uniqueKey,
      srkRelativeFilePath: srkEntry.relativeFilePath,
      srkTitle: srkEntry.title,
      srkDate: srkEntry.date,
      srkRefLinks: srkEntry.refLinks,
    });
  }

  success.sort((a, b) => a.contestId - b.contestId);
  unmatched.sort((a, b) => (a.contestId || 0) - (b.contestId || 0));
  return { success, unmatched };
}

function countBy(items, field) {
  const map = new Map();
  for (const item of items) {
    const key = item && item[field] ? item[field] : "unknown";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function main() {
  const cpcfinderOutputDir = path.resolve(process.argv[2] || DEFAULT_OUTPUT_DIR);
  const collectionDir = path.resolve(process.argv[3] || path.join("data", "srk-collection", "official"));
  const outputDir = path.resolve(process.argv[4] || cpcfinderOutputDir);
  const manualOverrideFile = path.resolve(process.argv[5] || path.join(outputDir, "contest-map.manual.json"));

  const { index } = loadCpcfinderIndex(cpcfinderOutputDir);
  const srkIndex = buildSrkIndex(collectionDir);
  const manualOverrides = loadManualOverrides(manualOverrideFile);
  const mapped = doMapping(index, srkIndex, manualOverrides);

  const summary = {
    generatedAt: new Date().toISOString(),
    cpcfinderOutputDir,
    collectionDir,
    manualOverrideFile: fs.existsSync(manualOverrideFile) ? manualOverrideFile : null,
    manualOverrides: manualOverrides.size,
    totals: {
      cpcfinderRecords: asArray(index && index.records).filter((record) => !record.error).length,
      srkContests: srkIndex.srkByKey.size,
      success: mapped.success.length,
      unmatched: mapped.unmatched.length,
    },
    methodCounts: countBy(mapped.success, "method"),
    unmatchedReasonCounts: countBy(mapped.unmatched, "reason"),
  };

  writeJson(path.join(outputDir, "contest-map.success.json"), mapped.success);
  writeJson(path.join(outputDir, "contest-map.unmatched.json"), mapped.unmatched);
  writeJson(path.join(outputDir, "contest-map.summary.json"), summary);

  console.log(`Mapped contests: ${summary.totals.success}`);
  console.log(`Unmatched contests: ${summary.totals.unmatched}`);
  console.log(`Saved success map: ${path.join(outputDir, "contest-map.success.json")}`);
  console.log(`Saved unmatched list: ${path.join(outputDir, "contest-map.unmatched.json")}`);
  console.log(`Saved summary: ${path.join(outputDir, "contest-map.summary.json")}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
