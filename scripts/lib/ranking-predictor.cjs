const { parse: parseCsvSync } = require("csv-parse/sync");
const { stringify: stringifyCsvSync } = require("csv-stringify/sync");
const { normalize, resolveText } = require("./ranklist-utils.cjs");

const TEAMMATE_HEADER_PATTERN = /teammate|队员/i;
const TEAMMATE_HEADER_BLACKLIST_PATTERN = /rating/i;
const ORG_HEADER_PATTERN = /school|university|学校|院校/i;
const NAME_SPLIT_PATTERN = /[;,，、\/\|\n\t]+/;
const DEFAULT_INITIAL_RATING = 1500;
const AGGREGATION_MODES = ["sum", "max", "mean", "geometric-mean"];
const AGGREGATION_MODE_ALIASES = new Map([
	["sum", "sum"],
	["max", "max"],
	["mean", "mean"],
	["avg", "mean"],
	["average", "mean"],
	["geometric-mean", "geometric-mean"],
	["geometricmean", "geometric-mean"],
	["geo-mean", "geometric-mean"],
	["geomean", "geometric-mean"],
	["gmean", "geometric-mean"],
]);

function parseCsv(text) {
	const rows = parseCsvSync(text, {
		relax_column_count: true,
		skip_empty_lines: false,
	});

	if (!rows.length) {
		return { headers: [], rows: [] };
	}

	const headers = rows[0].map((header, index) => {
		const value = index === 0 ? `${header || ""}`.replace(/^\uFEFF/, "") : header;
		return normalize(value);
	});
	const dataRows = rows.slice(1).map((rawRow) => {
		const padded = rawRow.slice();
		while (padded.length < headers.length) {
			padded.push("");
		}
		return padded.slice(0, headers.length);
	});

	return { headers, rows: dataRows };
}

function stringifyCsv(headers, rows) {
	return stringifyCsvSync([headers, ...rows]);
}

function splitTeammates(rawText) {
	const text = normalize(rawText);
	if (!text) {
		return [];
	}

	return text
		.split(NAME_SPLIT_PATTERN)
		.map((part) => normalize(part))
		.filter(Boolean);
}

function buildLookupKey(organization, teammate) {
	return `${normalize(organization).toLowerCase()}\u0001${normalize(teammate).toLowerCase()}`;
}

function buildStableTeamKey(organization, teammateNames) {
	const normalizedNames = teammateNames
		.map((name) => normalize(name).toLowerCase())
		.filter(Boolean)
		.sort();
	return `${normalize(organization).toLowerCase()}\u0001${normalizedNames.join("\u0001")}`;
}

function createRatingIndex({ initialRating, ratingsByPair }) {
	const resolvedInitialRating = Number.isFinite(initialRating) ? initialRating : DEFAULT_INITIAL_RATING;
	const normalizedRatings = ratingsByPair instanceof Map ? ratingsByPair : new Map();

	return {
		initialRating: resolvedInitialRating,
		getRating(organization, teammate) {
			const key = buildLookupKey(organization, teammate);
			const rating = normalizedRatings.get(key);
			if (Number.isFinite(rating)) {
				return { rating, known: true };
			}
			return { rating: resolvedInitialRating, known: false };
		},
	};
}

function buildRatingIndex(eloData) {
	const configuredInitialRating = Number.isFinite(eloData && eloData.config && eloData.config.initialRating)
		? eloData.config.initialRating
		: DEFAULT_INITIAL_RATING;
	const players = Array.isArray(eloData && eloData.players) ? eloData.players : [];
	const ratingsByPair = new Map();

	for (const player of players) {
		const organization = normalize(player && player.organization);
		const teammate = normalize(player && player.teamMember);
		const rating = Number(player && player.rating);
		if (!organization || !teammate || !Number.isFinite(rating)) {
			continue;
		}
		ratingsByPair.set(buildLookupKey(organization, teammate), rating);
	}

	return createRatingIndex({ initialRating: configuredInitialRating, ratingsByPair });
}

function detectColumnIndexes(headers) {
	const teammateIndexes = [];
	let organizationIndex = -1;

	for (let index = 0; index < headers.length; index += 1) {
		const header = headers[index] || "";
		if (TEAMMATE_HEADER_PATTERN.test(header)&& !TEAMMATE_HEADER_BLACKLIST_PATTERN.test(header)) {
			teammateIndexes.push(index);
		}
		if (organizationIndex < 0 && ORG_HEADER_PATTERN.test(header)) {
			organizationIndex = index;
		}
	}

	return { teammateIndexes, organizationIndex };
}

function parseAggregationMode(modeArg) {
	const normalizedMode = normalize(modeArg || "sum")
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	const compactMode = normalizedMode.replace(/-/g, "");
	const aggregationMode = AGGREGATION_MODE_ALIASES.get(normalizedMode) || AGGREGATION_MODE_ALIASES.get(compactMode);
	if (aggregationMode) {
		return aggregationMode;
	}
	throw new Error(`Invalid mode: ${modeArg}. Use ${AGGREGATION_MODES.join(", ")}.`);
}

function aggregateRatings(ratingValues, aggregationMode) {
	const mode = parseAggregationMode(aggregationMode);
	if (!ratingValues.length) {
		return 0;
	}

	if (mode === "max") {
		return Math.max(...ratingValues);
	}

	const sum = ratingValues.reduce((accumulator, value) => accumulator + value, 0);
	if (mode === "sum") {
		return sum;
	}
	if (mode === "mean") {
		return sum / ratingValues.length;
	}
	if (ratingValues.some((value) => value <= 0)) {
		throw new Error("geometric-mean requires all teammate ratings to be positive.");
	}

	const logSum = ratingValues.reduce((accumulator, value) => accumulator + Math.log(value), 0);
	return Math.exp(logSum / ratingValues.length);
}

function buildTeamEntriesFromCsv(parsedCsv, teammateIndexes, organizationIndex) {
	return parsedCsv.rows.map((row, rowIndex) => {
		const organization = organizationIndex >= 0 ? normalize(row[organizationIndex]) : "";
		const teammateNames = [...new Set(teammateIndexes.flatMap((idx) => splitTeammates(row[idx])))]
			.map((name) => normalize(name))
			.filter(Boolean);

		return {
			originalRow: row,
			sourceRowIndex: rowIndex,
			organization,
			teammateNames,
			stableKey: buildStableTeamKey(organization, teammateNames),
		};
	});
}

function buildTeamEntriesFromRanklist(ranklist) {
	const rows = Array.isArray(ranklist && ranklist.rows) ? ranklist.rows : [];
	const entries = [];

	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex];
		const user = row && row.user ? row.user : {};
		const organization = normalize(resolveText(user.organization));
		const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
		const teammateNames = [...new Set(teamMembers
			.map((member) => normalize(resolveText(member && member.name)))
			.filter(Boolean))];

		if (!organization || !teammateNames.length) {
			continue;
		}

		entries.push({
			originalRow: row,
			sourceRowIndex: rowIndex,
			actualRank: entries.length + 1,
			organization,
			teammateNames,
			stableKey: buildStableTeamKey(organization, teammateNames),
		});
	}

	return entries;
}

function predictEntries(teamEntries, ratingIndex, aggregationMode, options = {}) {
	const mode = parseAggregationMode(aggregationMode);
	const tieBreak = options.tieBreak === "source-order" ? "source-order" : "team-key";
	const predicted = teamEntries.map((entry, entryIndex) => {
		const teammateNames = Array.isArray(entry && entry.teammateNames) ? entry.teammateNames : [];
		const matchedRatingValues = [];
		let knownMembers = 0;
		let unknownMembers = 0;

		for (const teammateName of teammateNames) {
			const resolved = ratingIndex.getRating(entry.organization, teammateName);
			if (resolved.known) {
				knownMembers += 1;
				matchedRatingValues.push(resolved.rating);
			} else {
				unknownMembers += 1;
			}
		}

		return {
			...entry,
			sourceRowIndex: Number.isInteger(entry && entry.sourceRowIndex) ? entry.sourceRowIndex : entryIndex,
			stableKey: entry && entry.stableKey ? entry.stableKey : buildStableTeamKey(entry.organization, teammateNames),
			ratingScore: aggregateRatings(matchedRatingValues, mode),
			knownMembers,
			unknownMembers,
		};
	});

	predicted.sort((left, right) => {
		const scoreDiff = right.ratingScore - left.ratingScore;
		if (scoreDiff !== 0) {
			return scoreDiff;
		}

		const knownDiff = right.knownMembers - left.knownMembers;
		if (knownDiff !== 0) {
			return knownDiff;
		}

		if (tieBreak === "source-order") {
			return left.sourceRowIndex - right.sourceRowIndex;
		}

		return left.stableKey.localeCompare(right.stableKey) || left.sourceRowIndex - right.sourceRowIndex;
	});

	for (let index = 0; index < predicted.length; index += 1) {
		predicted[index].predictedRank = index + 1;
	}
	return predicted;
}

function scoreHeaderForMode(modeArg) {
	const mode = parseAggregationMode(modeArg);
	if (mode === "sum") return "predicted_elo_sum";
	if (mode === "max") return "predicted_elo_max";
	if (mode === "mean") return "predicted_elo_mean";
	return "predicted_elo_geometric_mean";
}

module.exports = {
	AGGREGATION_MODES,
	TEAMMATE_HEADER_PATTERN,
	ORG_HEADER_PATTERN,
	aggregateRatings,
	buildLookupKey,
	buildRatingIndex,
	buildTeamEntriesFromCsv,
	buildTeamEntriesFromRanklist,
	createRatingIndex,
	detectColumnIndexes,
	parseAggregationMode,
	parseCsv,
	predictEntries,
	scoreHeaderForMode,
	splitTeammates,
	stringifyCsv,
};
