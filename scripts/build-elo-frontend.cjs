/**
 * Copies frontend templates and injects teammate Elo data.
 */
const fs = require("fs");
const path = require("path");
const { ensureDir, readJson } = require("./lib/ranklist-utils.cjs");

/**
 * Reads a UTF-8 text file.
 *
 * @param {string} filePath File path.
 * @returns {string} File contents.
 */
function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Writes UTF-8 text and creates missing parent directories.
 *
 * @param {string} filePath Output path.
 * @param {string} value Text to write.
 */
function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

/**
 * Builds the static frontend bundle from template files and Elo JSON.
 *
 * @param {string} inputJsonFile Teammate Elo JSON path.
 * @param {string} templateDir Frontend template directory.
 * @param {string} outputDir Output directory.
 * @returns {object} Build summary.
 */
function buildFrontend(inputJsonFile, templateDir, outputDir) {
  if (!fs.existsSync(inputJsonFile)) {
    throw new Error(`Input teammate Elo data file does not exist: ${inputJsonFile}`);
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Frontend template directory does not exist: ${templateDir}`);
  }

  const data = readJson(inputJsonFile);
  const indexHtml = readText(path.join(templateDir, "index.html"));
  const stylesCss = readText(path.join(templateDir, "styles.css"));
  const appJs = readText(path.join(templateDir, "app.js"));
  const commonJs = readText(path.join(templateDir, "common.js"));
  const contestsHtml = readText(path.join(templateDir, "contests.html"));
  const contestsJs = readText(path.join(templateDir, "contests.js"));
  const faviconSvg = readText(path.join(templateDir, "favicon.svg"));

  ensureDir(outputDir);
  writeText(path.join(outputDir, "index.html"), indexHtml);
  writeText(path.join(outputDir, "styles.css"), stylesCss);
  writeText(path.join(outputDir, "app.js"), appJs);
  writeText(path.join(outputDir, "common.js"), commonJs);
  writeText(path.join(outputDir, "contests.html"), contestsHtml);
  writeText(path.join(outputDir, "contests.js"), contestsJs);
  writeText(path.join(outputDir, "favicon.svg"), faviconSvg);
  writeText(path.join(outputDir, "data.js"), `window.__ELO_DATA__ = ${JSON.stringify(data)};\n`);

  return {
    generatedAt: new Date().toISOString(),
    inputJsonFile,
    outputDir,
    players: Array.isArray(data.players) ? data.players.length : 0,
    contests: Array.isArray(data.contests) ? data.contests.length : 0,
  };
}

/**
 * CLI entry point for frontend generation.
 */
function main() {
  const inputJsonFile = path.resolve(process.argv[2] || path.join("out", "teammate-elo.json"));
  const templateDir = path.resolve(process.argv[3] || "frontend");
  const outputDir = path.resolve(process.argv[4] || path.join("out", "frontend"));

  const result = buildFrontend(inputJsonFile, templateDir, outputDir);
  console.log(`Frontend built at: ${result.outputDir}`);
  console.log(`Players loaded: ${result.players}`);
  console.log(`Contests loaded: ${result.contests}`);
}

main();
