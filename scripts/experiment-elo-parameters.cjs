/**
 * Sweeps Elo parameters and aggregates prediction Spearman rho for
 * post-2020 ICPC/CCPC contests.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const staticRoot = path.join(rootDir, "out", "static-ranklists");
const teammateMap = path.join(rootDir, "out", "teammate-map.json");
const experimentDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcpc-elo-experiment-"));
const sourceMap = path.join(rootDir, "out", "_source-map.json");
if (fs.existsSync(sourceMap)) fs.copyFileSync(sourceMap, path.join(experimentDir, "_source-map.json"));
const rankFactors = [0.5];
const updateFactors = [ 0.5];
const scales = [400];
const searchOffsets = [0.5, 1, 2];
const adjustTops = [false];

function aggregate(output) {
  const values = (output.contests || []).filter((contest) => {
    const year = contest.startAt ? new Date(contest.startAt).getFullYear() : 0;
    return (
      year >= 2023 &&
      /^(icpc|ccpc)\//i.test(contest.sourcePath) &&
      !/invitational/i.test(contest.sourcePath) &&
      !/preliminary/i.test(contest.sourcePath) &&
      Number.isFinite(contest.statistics && contest.statistics.predictionSpearman) &&
      (contest.statistics.predictionTeamCount || 0) >= 2
    );
  });
  const macroMean = values.reduce((sum, contest) => sum + contest.statistics.predictionSpearman, 0) / values.length;
  const weightedMean =
    values.reduce((sum, contest) => sum + contest.statistics.predictionSpearman * contest.statistics.predictionTeamCount, 0) /
    values.reduce((sum, contest) => sum + contest.statistics.predictionTeamCount, 0);
  return { contests: values.length, macroMean, weightedMean };
}

const results = [];
for (const scale of scales) {
  for (const rankFactor of rankFactors) {
    for (const updateFactor of updateFactors) {
      for (const searchOffset of searchOffsets) {
        for (const adjustTop of adjustTops) {
          console.log("current:", scale, rankFactor, updateFactor, searchOffset, adjustTop);
          const outputFile = path.join(experimentDir, `${scale}-${rankFactor}-${updateFactor}.json`);
          const result = spawnSync(
            process.execPath,
            [path.join(rootDir, "scripts", "compute-teammate-elo.cjs"), staticRoot, teammateMap, outputFile],
            {
              cwd: rootDir,
              env: {
                ...process.env,
                XCPC_ELO_SCALE: `${scale}`,
                XCPC_ELO_RANK_FACTOR: `${rankFactor}`,
                XCPC_ELO_UPDATE_FACTOR: `${updateFactor}`,
                XCPC_ELO_SEARCH_OFFSET: `${searchOffset}`,
                XCPC_ELO_ADJUST_TOP_DELTA: `${adjustTop}`,
              },
              encoding: "utf8",
            },
          );
          if (result.status !== 0)
            throw new Error(
              result.stderr ||
                result.stdout ||
                `experiment failed: ${scale}/${rankFactor}/${updateFactor}/${searchOffset}/${adjustTop}`,
            );
          results.push({
            scale,
            rankFactor,
            updateFactor,
            searchOffset,
            adjustTop,
            ...aggregate(JSON.parse(fs.readFileSync(outputFile, "utf8"))),
          });
        }
      }
    }
  }
}

results.sort((a, b) => b.macroMean - a.macroMean || b.weightedMean - a.weightedMean);
console.log(JSON.stringify({ objective: "macroMean", results }, null, 2));
