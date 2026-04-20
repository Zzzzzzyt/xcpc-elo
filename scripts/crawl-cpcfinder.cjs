const path = require("path");
const {
  DEFAULT_BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_PAGE_SIZE,
  crawlCpcfinder,
  parsePositiveInteger,
} = require("./lib/cpcfinder.cjs");

async function main() {
  const outputDir = path.resolve(process.argv[2] || DEFAULT_OUTPUT_DIR);
  const baseUrl = `${process.argv[3] || DEFAULT_BASE_URL}`.trim() || DEFAULT_BASE_URL;
  const concurrency = parsePositiveInteger(process.argv[4]) || DEFAULT_CONCURRENCY;
  const pageSize = parsePositiveInteger(process.argv[5]) || DEFAULT_PAGE_SIZE;

  const result = await crawlCpcfinder({
    outputDir,
    baseUrl,
    concurrency,
    pageSize,
  });

  console.log(`Crawl output dir: ${outputDir}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Contests listed: ${result.totalContests}`);
  console.log(`Contests crawled: ${result.success}`);
  console.log(`Contests failed: ${result.failed}`);
  console.log(`Contests loaded from cache: ${result.fromCache}`);
  console.log(`Contests fetched from API: ${result.fetched}`);
  console.log(`Saved index: ${path.join(outputDir, "index.json")}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
