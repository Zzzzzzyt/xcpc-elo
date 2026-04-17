const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { convertToStaticRanklist } = require("@algoux/standard-ranklist-utils");

const EXCLUDED_CONTEST_PATTERNS = [
  /world\s*finals?/i,
  /worldfinals?/i,
  /hong\s*kong/i,
  /hongkong/i,
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

function isValidParticipantName(name) {
  const s = `${name || ""}`.trim();
  if (!s) return false;
  if (s.length < 2) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^(unknown|n\/?a|null|none|anonymous|匿名|待定|未知|未命名|未填写|-)$/i.test(s)) return false;
  return /[a-zA-Z\u4e00-\u9fff0-9]/.test(s);
}

function isCoachName(name) {
  const s = `${name || ""}`.trim();
  if (!s) return false;
  return /coach|教练/i.test(s);
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
      const relativeFilePath = `${currentPath}.${item.format}`;
      files.push({
        uniqueKey: item.path,
        relativeFilePath,
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

function assessParticipantNames(ranklist) {
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  if (!rows.length) {
    return {
      invalid: true,
      detail: "no participants",
    };
  }

  let totalNames = 0;
  let validNames = 0;

  for (const row of rows) {
    const user = row && row.user ? row.user : {};

    let names = [];
    if (Array.isArray(user.teamMembers) && user.teamMembers.length > 0) {
      names = user.teamMembers.map((member) => resolveText(member && member.name)).filter((name) => name && !isCoachName(name));
    }

    for (const name of names) {
      totalNames += 1;
      if (isValidParticipantName(name)) {
        validNames += 1;
      }
    }
  }

  return {
    invalid: validNames !== totalNames,
    detail: `validNames=${validNames}, totalNames=${totalNames}`,
  };
}

function invalidNames(entry, ranklist) {
  void entry;
  return assessParticipantNames(ranklist);
}

function fixRanklist(ranklist) {
  for (const row of ranklist.rows) {
    // teammember names contains spaces
    const teamMembers = row.user.teamMembers;
    var newTeamMembers = [];
    if (teamMembers && teamMembers.length > 0) {
      for (const member of teamMembers) {
        member.name = member.name.trim();
        if (isCoachName(member.name)) {
          continue;
        }
        if (member.name.length > 0) {
          const parts = member.name.split(" ").filter((part) => part.trim().length > 0);
          if (parts.length > 1) {
            for (const part of parts) {
              newTeamMembers.push({
                name: part.trim(),
              });
            }
          } else {
            newTeamMembers.push(member);
          }
        }
      }
      newTeamMembers = newTeamMembers.filter((member) => !isCoachName(member.name));
      row.user.teamMembers = newTeamMembers;
    }
  }
  return ranklist;
}

async function computeAllStaticRanklists(collectionDir, outputDir) {
  const files = parseCollectionConfig(collectionDir);

  let successCount = 0;
  let skippedCount = 0;
  const failures = [];
  const skipped = [];

  for (const entry of files) {
    const srcFilePath = path.join(collectionDir, entry.relativeFilePath);
    const outFilePath = path.join(outputDir, `${entry.uniqueKey}.static.srk.json`);

    try {
      const ranklist = fixRanklist(readJson(srcFilePath));

      const skipResult = shouldSkipContest(entry, ranklist);
      if (skipResult.skip) {
        skippedCount += 1;
        skipped.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: skipResult.reason,
          detail: skipResult.detail,
        });
        continue;
      }

      const nameCheck = invalidNames(entry, ranklist);
      if (nameCheck.invalid) {
        skippedCount += 1;
        skipped.push({
          uniqueKey: entry.uniqueKey,
          file: entry.relativeFilePath,
          reason: "invalid-participant-names",
          detail: nameCheck.detail,
        });
        continue;
      }

      const staticRanklist = convertToStaticRanklist(ranklist);
      writeJson(outFilePath, staticRanklist);
      successCount += 1;
    } catch (error) {
      failures.push({
        uniqueKey: entry.uniqueKey,
        file: entry.relativeFilePath,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    collectionDir,
    outputDir,
    total: files.length,
    success: successCount,
    skipped: skippedCount,
    failed: failures.length,
    skippedItems: skipped,
    failures,
  };

  writeJson(path.join(outputDir, "_summary.json"), summary);

  return summary;
}

async function main() {
  const collectionDir = path.resolve(process.argv[2] || path.join("data", "srk-collection", "official"));
  const outputDir = path.resolve(process.argv[3] || path.join("out", "static-ranklists"));

  console.log(`Using collection: ${collectionDir}`);
  console.log(`Writing outputs to: ${outputDir}`);

  const summary = await computeAllStaticRanklists(collectionDir, outputDir);

  console.log(`Total contests: ${summary.total}`);
  console.log(`Generated: ${summary.success}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Failed: ${summary.failed}`);

  if (summary.failed > 0) {
    console.log("See out/static-ranklists/_summary.json for failure details.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
