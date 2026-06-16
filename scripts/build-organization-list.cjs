const path = require("path");
const { normalize, readJson, writeJson } = require("./lib/ranklist-utils.cjs");

function buildOrganizationList(teammateMapFile, outputFile) {
  const teammateMap = readJson(teammateMapFile);
  const entries = Array.isArray(teammateMap && teammateMap.entries) ? teammateMap.entries : [];
  const organizationCounts = new Map();

  for (const entry of entries) {
    const organization = normalize(entry && entry.organization);
    if (!organization) {
      continue;
    }
    organizationCounts.set(organization, (organizationCounts.get(organization) || 0) + 1);
  }

  const organizations = [...organizationCounts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
  const output = {
    generatedAt: new Date().toISOString(),
    teammateMapFile: path.resolve(teammateMapFile),
    totalOrganizations: organizations.length,
    totalOccurrences: entries.length,
    organizations,
  };

  writeJson(outputFile, output);
  return output;
}

function main() {
  const teammateMapFile = path.resolve(process.argv[2] || path.join("out", "teammate-map.json"));
  const outputFile = path.resolve(process.argv[3] || path.join("out", "organization-list.json"));

  const result = buildOrganizationList(teammateMapFile, outputFile);
  console.log(`Source teammate map: ${teammateMapFile}`);
  console.log(`Unique organizations: ${result.totalOrganizations}`);
  console.log(`Total occurrences: ${result.totalOccurrences}`);
  console.log(`Saved organization list to: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
