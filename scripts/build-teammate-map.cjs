/**
 * Builds the teammate-organization map used as Elo identity input.
 */
const path = require("path");
const {
  normalize,
  readJson,
  resolveText,
  teammateHashId,
  teammatePairKey,
  writeJson,
} = require("./lib/ranklist-utils.cjs");

/**
 * Scans static ranklists and aggregates teammate-organization pairs.
 *
 * @param {string} staticRootDir Directory containing static ranklists.
 * @param {string} outputFile Output JSON path.
 * @returns {object} Built teammate map data.
 */
function buildTeammateOrganizationMap(staticRootDir, outputFile) {
  const sourceMapFile = path.join(path.dirname(outputFile), "source-map.json");
  const sourceMap = readJson(sourceMapFile);
  const ranklistFiles = Object.keys(sourceMap).map((fileName) => path.join(staticRootDir, fileName));
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
        const name = normalize(resolveText(member && member.name));
        if (!name) {
          continue;
        }

        const key = teammatePairKey(organization, name);
        if (!pairMap.has(key)) {
          pairMap.set(key, {
            id: teammateHashId(organization, name),
            organization,
            name,
            contests: new Set(),
            appearances: 0,
          });
        }

        const item = pairMap.get(key);
        item.appearances += 1;
        item.contests.add(contestKey);
      }
    }
  }

  const entries = [...pairMap.values()]
    .map((item) => ({
      id: item.id,
      organization: item.organization,
      name: item.name,
      appearances: item.appearances,
      contests: [...item.contests].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const mappingById = {};
  for (const entry of entries) {
    mappingById[entry.id] = {
      organization: entry.organization,
      name: entry.name,
      appearances: entry.appearances,
      contests: entry.contests,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    staticRootDir,
    totalStaticRanklists: ranklistFiles.length,
    totalPairs: entries.length,
    entries,
    mappingById,
  };

  writeJson(outputFile, output, true);
  return output;
}

/**
 * CLI entry point for teammate map generation.
 */
function main() {
  const staticRootDir = path.resolve(process.argv[2] || path.join("out", "static-ranklists"));
  const outputFile = path.resolve(process.argv[3] || path.join("out", "teammate-map.json"));

  const result = buildTeammateOrganizationMap(staticRootDir, outputFile);
  console.log(`Scanned static ranklists: ${result.totalStaticRanklists}`);
  console.log(`Collected teammate-organization pairs: ${result.totalPairs}`);
  console.log(`Saved mapping to: ${outputFile}`);
}

main();
