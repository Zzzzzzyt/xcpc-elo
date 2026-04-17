const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

function pairHashId(organization, teamMember) {
  const orgNorm = normalize(organization).toLowerCase();
  const memberNorm = normalize(teamMember).toLowerCase();
  const raw = `${orgNorm}\u0001${memberNorm}`;
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return `xcpc_${digest.slice(0, 16)}`;
}

function collectStaticRanklistFiles(rootDir) {
  const files = [];

  function walk(dir) {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    for (const child of children) {
      const fullPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (child.isFile() && child.name.endsWith(".static.srk.json")) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function buildMapping(staticRootDir, outputFile) {
  const ranklistFiles = collectStaticRanklistFiles(staticRootDir);
  const pairMap = new Map();

  for (const filePath of ranklistFiles) {
    const data = readJson(filePath);
    const rows = Array.isArray(data && data.rows) ? data.rows : [];
    const contestKey = path.basename(filePath, ".static.srk.json");

    for (const row of rows) {
      const user = row && row.user ? row.user : {};
      const organization = normalize(resolveText(user.organization));
      const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];

      if (!organization || !teamMembers.length) {
        continue;
      }

      for (const member of teamMembers) {
        const teamMember = normalize(resolveText(member && member.name));
        if (!teamMember) {
          continue;
        }

        const key = `${organization}\u0001${teamMember}`;
        if (!pairMap.has(key)) {
          pairMap.set(key, {
            id: pairHashId(organization, teamMember),
            organization,
            teamMember,
            contests: new Set(),
            count: 0,
          });
        }

        const item = pairMap.get(key);
        item.count += 1;
        item.contests.add(contestKey);
      }
    }
  }

  const entries = [...pairMap.values()]
    .map((item) => ({
      id: item.id,
      organization: item.organization,
      teamMember: item.teamMember,
      appearances: item.count,
      contests: [...item.contests].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const mappingById = {};
  for (const entry of entries) {
    mappingById[entry.id] = {
      organization: entry.organization,
      teamMember: entry.teamMember,
      appearances: entry.appearances,
      contests: entry.contests,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourceDir: staticRootDir,
    totalStaticRanklists: ranklistFiles.length,
    totalPairs: entries.length,
    entries,
    mappingById,
  };

  writeJson(outputFile, output);

  return output;
}

function main() {
  const staticRootDir = path.resolve(process.argv[2] || path.join("out", "static-ranklists"));
  const outputFile = path.resolve(process.argv[3] || path.join("out", "teammate-map.json"));

  if (!fs.existsSync(staticRootDir)) {
    throw new Error(`Static ranklist directory does not exist: ${staticRootDir}`);
  }

  const result = buildMapping(staticRootDir, outputFile);
  console.log(`Scanned static ranklists: ${result.totalStaticRanklists}`);
  console.log(`Collected pairs: ${result.totalPairs}`);
  console.log(`Saved mapping to: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
