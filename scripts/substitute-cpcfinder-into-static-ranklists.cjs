const fs = require("fs");
const path = require("path");
const {
  assessParticipantNames,
  collectStaticRanklistFiles,
  isMetaMemberName,
  isValidParticipantName,
  normalize,
  readJson,
  resolveText,
  writeJson,
} = require("./lib/ranklist-utils.cjs");

const DEFAULT_STATIC_ROOT_DIR = path.join("out", "static-ranklists");
const DEFAULT_CPCFINDER_OUTPUT_DIR = path.join("out", "cpcfinder");

function isHongKongContestId(contestKey) {
  const value = `${contestKey || ""}`;
  return /hong\s*kong/i.test(value) || /hongkong/i.test(value);
}

function chooseBestContestMapping(successItems) {
  const bySrkKey = new Map();
  for (const item of successItems) {
    const key = normalize(item && item.srkUniqueKey);
    const contestId = Number.parseInt(`${item && item.contestId ? item.contestId : ""}`, 10);
    if (!key || !Number.isFinite(contestId) || contestId <= 0) {
      continue;
    }
    if (!bySrkKey.has(key)) {
      bySrkKey.set(key, []);
    }
    bySrkKey.get(key).push(item);
  }

  const chosen = new Map();
  const conflicts = [];

  for (const [key, candidates] of bySrkKey.entries()) {
    const sorted = [...candidates].sort((a, b) => {
      function score(item) {
        let s = 0;
        if (item.method === "manual-override") s += 100;
        if (item.duplicateOfContestId === null || item.duplicateOfContestId === undefined) s += 20;
        if (item.method === "board-link") s += 10;
        if (item.method === "rankId-link") s += 8;
        if (item.method === "ref-link") s += 6;
        if (item.method === "date-prefix-single") s += 4;
        return s;
      }
      return score(b) - score(a) || Number.parseInt(`${b.contestId}`, 10) - Number.parseInt(`${a.contestId}`, 10);
    });
    chosen.set(key, sorted[0]);
    if (sorted.length > 1) {
      conflicts.push({
        srkUniqueKey: key,
        chosenContestId: sorted[0].contestId,
        candidates: sorted.map((item) => ({
          contestId: item.contestId,
          method: item.method,
          duplicateOfContestId: item.duplicateOfContestId ?? null,
        })),
      });
    }
  }

  return { chosen, conflicts };
}

function sanitizeMembersFromAward(award) {
  const members = Array.isArray(award && award.members) ? award.members : [];
  const sanitized = [];
  for (const member of members) {
    const name = normalize(resolveText(member && member.name));
    if (!name || isMetaMemberName(name) || !isValidParticipantName(name)) {
      continue;
    }
    sanitized.push({ name });
  }
  return sanitized;
}

function buildAwardsInRankOrder(awards) {
  return [...awards]
    .filter((award) => Number.isFinite(Number.parseInt(`${award && award.rank ? award.rank : ""}`, 10)))
    .sort((a, b) => {
      const rankA = Number.parseInt(`${a && a.rank ? a.rank : ""}`, 10);
      const rankB = Number.parseInt(`${b && b.rank ? b.rank : ""}`, 10);
      if (rankA !== rankB) return rankA - rankB;
      const awardIdA = Number.parseInt(`${a && a.awardId ? a.awardId : ""}`, 10);
      const awardIdB = Number.parseInt(`${b && b.awardId ? b.awardId : ""}`, 10);
      if (Number.isFinite(awardIdA) && Number.isFinite(awardIdB) && awardIdA !== awardIdB) {
        return awardIdA - awardIdB;
      }
      return 0;
    });
}

function substituteRowByRow(ranklist, awards, options) {
  const applyOrganization = !!(options && options.applyOrganization);
  const mode = applyOrganization ? "hongkong-row-by-row" : "row-by-row";
  const before = assessParticipantNames(ranklist);
  const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
  const orderedAwards = buildAwardsInRankOrder(Array.isArray(awards) ? awards : []);

  let replacedRows = 0;
  let replacedNames = 0;
  let unresolvedRows = 0;
  const details = [];

  const count = Math.min(rows.length, orderedAwards.length);
  for (let index = 0; index < count; index += 1) {
    const row = rows[index];
    const award = orderedAwards[index];
    const nextMembers = sanitizeMembersFromAward(award);
    const nextOrganization = normalize(resolveText(award && award.schoolName));
    if (!nextMembers.length) {
      unresolvedRows += 1;
      continue;
    }

    const prevMembers = Array.isArray(row && row.user && row.user.teamMembers) ? row.user.teamMembers : [];
    const prevOrganization = normalize(resolveText(row && row.user && row.user.organization));
    row.user = row.user || {};
    if (applyOrganization && nextOrganization) {
      row.user.organization = nextOrganization;
    }
    row.user.teamMembers = nextMembers.map((member) => ({ name: member.name }));
    replacedRows += 1;
    replacedNames += prevMembers.length;
    details.push({
      rank: index + 1,
      mode,
      previousOrganization: prevOrganization,
      substitutedSchool: normalize(resolveText(award && award.schoolName)),
      substitutedTeam: normalize(resolveText(award && award.teamName)),
      substitutedMembers: nextMembers.map((member) => member.name),
    });
  }

  if (rows.length > orderedAwards.length) {
    unresolvedRows += rows.length - orderedAwards.length;
  }

  const after = assessParticipantNames(ranklist);
  return {
    changed: replacedRows > 0,
    before,
    after,
    replacedRows,
    replacedNames,
    unresolvedRows,
    details,
  };
}

function loadAwards(cpcfinderOutputDir, contestId, cache) {
  if (cache.has(contestId)) {
    return cache.get(contestId);
  }
  const awardsFile = path.join(cpcfinderOutputDir, "awards", `${contestId}.awards.json`);
  if (!fs.existsSync(awardsFile)) {
    cache.set(contestId, null);
    return null;
  }
  const awards = readJson(awardsFile);
  const normalized = Array.isArray(awards) ? awards : null;
  cache.set(contestId, normalized);
  return normalized;
}

function substituteCpcfinderIntoStaticRanklists(staticRootDir, cpcfinderOutputDir, reportFile) {
  const successMapFile = path.join(cpcfinderOutputDir, "contest-map.success.json");
  if (!fs.existsSync(successMapFile)) {
    throw new Error(`CPCFinder contest map file does not exist: ${successMapFile}`);
  }

  const successItems = readJson(successMapFile);
  const mapping = chooseBestContestMapping(Array.isArray(successItems) ? successItems : []);
  const awardsCache = new Map();
  const staticFiles = collectStaticRanklistFiles(staticRootDir);
  const items = [];

  let validBefore = 0;
  let invalidBefore = 0;
  let fixed = 0;
  let stillInvalid = 0;
  let noMap = 0;
  let noAwards = 0;
  let hongKongRowByRowApplied = 0;

  for (const filePath of staticFiles) {
    const ranklist = readJson(filePath);
    const contestKey = path.basename(filePath, ".static.srk.json");
    const isHongKong = isHongKongContestId(contestKey);
    const before = assessParticipantNames(ranklist);
    if (!before.invalid && !isHongKong) {
      validBefore += 1;
      items.push({
        contestKey,
        status: "already-valid",
        before: before.detail,
        after: before.detail,
      });
      continue;
    }

    if (before.invalid) {
      invalidBefore += 1;
    }
    const match = mapping.chosen.get(contestKey);
    if (!match) {
      noMap += 1;
      items.push({
        contestKey,
        status: "no-cpcfinder-map",
        before: before.detail,
        after: before.detail,
      });
      continue;
    }

    const contestId = Number.parseInt(`${match.contestId}`, 10);
    const awards = loadAwards(cpcfinderOutputDir, contestId, awardsCache);
    if (!awards || !awards.length) {
      noAwards += 1;
      items.push({
        contestKey,
        status: "no-cpcfinder-awards",
        contestId,
        before: before.detail,
        after: before.detail,
        mappingMethod: match.method,
      });
      continue;
    }

    const result = substituteRowByRow(ranklist, awards, {
      applyOrganization: isHongKong,
    });
    if (result.changed) {
      writeJson(filePath, ranklist);
    }

    if (isHongKong) {
      if (result.replacedRows > 0) {
        hongKongRowByRowApplied += 1;
        items.push({
          contestKey,
          status: "hongkong-row-by-row-applied",
          contestId,
          mappingMethod: match.method,
          before: result.before.detail,
          after: result.after.detail,
          replacedRows: result.replacedRows,
          replacedNames: result.replacedNames,
          unresolvedRows: result.unresolvedRows,
          details: result.details,
        });
      } else {
        if (result.before.invalid || result.after.invalid) {
          stillInvalid += 1;
        }
        items.push({
          contestKey,
          status: "hongkong-row-by-row-unapplied",
          contestId,
          mappingMethod: match.method,
          before: result.before.detail,
          after: result.after.detail,
          replacedRows: result.replacedRows,
          replacedNames: result.replacedNames,
          unresolvedRows: result.unresolvedRows,
          details: result.details,
        });
      }
    } else if (!result.after.invalid && result.replacedRows > 0) {
      fixed += 1;
      items.push({
        contestKey,
        status: "substituted-and-valid",
        contestId,
        mappingMethod: match.method,
        before: result.before.detail,
        after: result.after.detail,
        replacedRows: result.replacedRows,
        replacedNames: result.replacedNames,
        unresolvedRows: result.unresolvedRows,
        details: result.details,
      });
    } else {
      stillInvalid += 1;
      items.push({
        contestKey,
        status: "substitution-attempted-but-still-invalid",
        contestId,
        mappingMethod: match.method,
        before: result.before.detail,
        after: result.after.detail,
        replacedRows: result.replacedRows,
        replacedNames: result.replacedNames,
        unresolvedRows: result.unresolvedRows,
        details: result.details,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    staticRootDir,
    cpcfinderOutputDir,
    totals: {
      staticRanklists: staticFiles.length,
      validBefore,
      invalidBefore,
      fixed,
      stillInvalid,
      noMap,
      noAwards,
      hongKongRowByRowApplied,
      mappingConflicts: mapping.conflicts.length,
    },
    mappingConflicts: mapping.conflicts,
    items,
  };

  writeJson(reportFile, report);
  return report;
}

function main() {
  const staticRootDir = path.resolve(process.argv[2] || DEFAULT_STATIC_ROOT_DIR);
  const cpcfinderOutputDir = path.resolve(process.argv[3] || DEFAULT_CPCFINDER_OUTPUT_DIR);
  const reportFile = path.resolve(process.argv[4] || path.join(staticRootDir, "_substitution.json"));

  const report = substituteCpcfinderIntoStaticRanklists(staticRootDir, cpcfinderOutputDir, reportFile);
  console.log(`Scanned static ranklists: ${report.totals.staticRanklists}`);
  console.log(`Invalid before substitution: ${report.totals.invalidBefore}`);
  console.log(`Fixed by substitution: ${report.totals.fixed}`);
  console.log(`Still invalid after substitution: ${report.totals.stillInvalid}`);
  console.log(`Missing CPCFinder map: ${report.totals.noMap}`);
  console.log(`Missing CPCFinder awards: ${report.totals.noAwards}`);
  console.log(`Hong Kong row-by-row applied: ${report.totals.hongKongRowByRowApplied}`);
  console.log(`Saved substitution report: ${reportFile}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
