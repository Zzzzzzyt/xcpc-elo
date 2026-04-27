const MIN_RATING_FOR_SEARCH = -10000;
const MAX_RATING_FOR_SEARCH = 10000;
const ELO_SCALE = 800;
const DEFAULT_INITIAL_RATING = 1500;

function parseContestTimestamp(contest) {
  const startAt = contest && contest.startAt ? contest.startAt : null;
  const ts = startAt ? Date.parse(startAt) : Number.NaN;
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}

function buildSeedModel(rows) {
  const ratingCountMap = new Map();
  for (const row of rows) {
    const count = ratingCountMap.get(row.rating) || 0;
    ratingCountMap.set(row.rating, count + 1);
  }

  const uniqueRatings = [...ratingCountMap.keys()];
  const uniqueCounts = uniqueRatings.map((rating) => ratingCountMap.get(rating));

  const probabilityByDiff = new Map();
  const seedByRating = new Map();

  function probabilityByDifference(diff) {
    let value = probabilityByDiff.get(diff);
    if (value !== undefined) {
      return value;
    }
    value = 1 / (1 + Math.pow(10, diff / ELO_SCALE));
    probabilityByDiff.set(diff, value);
    return value;
  }

  function seedWithPopulation(queryRating) {
    let cached = seedByRating.get(queryRating);
    if (cached !== undefined) {
      return cached;
    }

    let seed = 1;
    for (let i = 0; i < uniqueRatings.length; i += 1) {
      const opponentRating = uniqueRatings[i];
      const count = uniqueCounts[i];
      seed += count * probabilityByDifference(queryRating - opponentRating);
    }

    seedByRating.set(queryRating, seed);
    return seed;
  }

  return {
    seedWithPopulation,
    seedWithoutSelf(playerRating) {
      return seedWithPopulation(playerRating) - probabilityByDifference(playerRating - playerRating);
    },
  };
}

function findRatingForSeed(targetSeed, seedModel) {
  let left = MIN_RATING_FOR_SEARCH;
  let right = MAX_RATING_FOR_SEARCH;

  while (right - left > 1) {
    const middle = (left + right) >> 1;
    const middleSeed = seedModel.seedWithPopulation(middle);
    if (middleSeed > targetSeed) {
      left = middle;
    } else {
      right = middle;
    }
  }

  return left;
}

function applyCodeforcesUpdate(participants, getRating) {
  const rows = participants.map((participant) => ({
    id: participant.id,
    rank: participant.rank,
    rating: getRating(participant.id),
    seed: 1,
    delta: 0,
  }));

  if (rows.length < 2) {
    return rows;
  }

  const seedModel = buildSeedModel(rows);
  for (const row of rows) {
    row.seed = seedModel.seedWithoutSelf(row.rating);
  }

  for (const row of rows) {
    const middleRank = Math.sqrt(row.rank * row.seed);
    const neededRating = findRatingForSeed(middleRank, seedModel);
    row.delta = Math.trunc((neededRating - row.rating) / 2);
  }

  const sumDelta = rows.reduce((acc, row) => acc + row.delta, 0);
  const inc1 = Math.trunc(-sumDelta / rows.length) - 1;
  for (const row of rows) {
    row.delta += inc1;
  }

  const topCount = Math.min(rows.length, Math.floor(4 * Math.sqrt(rows.length)) + 1);
  const byRating = [...rows].sort((a, b) => b.rating - a.rating || a.rank - b.rank || a.id.localeCompare(b.id));
  const sumTop = byRating.slice(0, topCount).reduce((acc, row) => acc + row.delta, 0);
  let inc2 = Math.trunc(-sumTop / topCount);
  inc2 = Math.max(-10, Math.min(0, inc2));
  for (const row of rows) {
    row.delta += inc2;
  }

  return rows;
}

function ratingTitle(rating) {
  if (rating < 1200) return "newbie";
  if (rating < 1400) return "pupil";
  if (rating < 1600) return "specialist";
  if (rating < 1900) return "expert";
  if (rating < 2100) return "candidate master";
  if (rating < 2300) return "master";
  if (rating < 2400) return "international master";
  if (rating < 2600) return "grandmaster";
  if (rating < 3000) return "international grandmaster";
  return "legendary grandmaster";
}

module.exports = {
  applyCodeforcesUpdate,
  parseContestTimestamp,
  ratingTitle,
  DEFAULT_INITIAL_RATING,
  ELO_SCALE,
};
