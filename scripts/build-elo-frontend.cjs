const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

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

  ensureDir(outputDir);
  writeText(path.join(outputDir, "index.html"), indexHtml);
  writeText(path.join(outputDir, "styles.css"), stylesCss);
  writeText(path.join(outputDir, "app.js"), appJs);
  writeText(path.join(outputDir, "data.js"), `window.__ELO_DATA__ = ${JSON.stringify(data)};\n`);

  return {
    generatedAt: new Date().toISOString(),
    inputJsonFile,
    outputDir,
    players: Array.isArray(data.players) ? data.players.length : 0,
    contests: Array.isArray(data.contests) ? data.contests.length : 0,
  };
}

function main() {
  const inputJsonFile = path.resolve(process.argv[2] || path.join("out", "teammate-elo.json"));
  const templateDir = path.resolve(process.argv[3] || "frontend");
  const outputDir = path.resolve(process.argv[4] || path.join("out", "frontend"));

  const result = buildFrontend(inputJsonFile, templateDir, outputDir);
  console.log(`Frontend built at: ${result.outputDir}`);
  console.log(`Players loaded: ${result.players}`);
  console.log(`Contests loaded: ${result.contests}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}

