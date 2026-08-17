const MIN_RATING_FOR_SEARCH = -500;
const MAX_RATING_FOR_SEARCH = 6000;
const ELO_SCALE = 400;
const DEFAULT_INITIAL_RATING = 1400;
const ELO_UPDATE_FACTOR = 0.8;

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

  function findRatingForSeed(targetSeed) {
    let left = MIN_RATING_FOR_SEARCH;
    let right = MAX_RATING_FOR_SEARCH;

    while (left < right) {
      const middle = (left + right) >> 1;
      const middleSeed = seedWithPopulation(middle);
      if (middleSeed > targetSeed + 0.5) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }

    return left;
  }

  return {
    findRatingForSeed,
    seedWithPopulation,
    seedWithoutSelf(rating) {
      return seedWithPopulation(rating) - probabilityByDifference(0);
    },
  };
}

function applyCodeforcesUpdate(participants, playerStates) {
  if (participants.length < 2) {
    throw new Error("Not enough participants.");
  }

  function getRating(memberId) {
    const state = playerStates.get(memberId);
    return state.rating;
  }

  function calculateTeamRating(team) {
    var total = 0;
    for (const member of team.members) {
      total += Math.pow(10, getRating(member) / ELO_SCALE);
    }
    return Math.round(Math.log10(total) * ELO_SCALE);
  }

  function calculateMemberRating(rating, memberCount) {
    return Math.round(rating - ELO_SCALE * Math.log10(memberCount));
  }

  const teams = participants.map((team) => ({
    rank: team.rank,
    members: team.members,
    rating: calculateTeamRating(team),
    seed: 1,
    performanceRating: null,
    neededRating: null,
    delta: 0,
  }));

  const seedModel = buildSeedModel(teams);
  for (const row of teams) {
    row.seed = seedModel.seedWithoutSelf(row.rating);
  }

  for (const row of teams) {
    row.performanceRating = seedModel.findRatingForSeed(row.rank);
    const middleRank = Math.sqrt(row.rank * row.seed);
    row.neededRating = seedModel.findRatingForSeed(middleRank);
  }

  const output = [];
  for (const row of teams) {
    const neededRating = calculateMemberRating(row.neededRating, row.members.length);
    const performanceRating = calculateMemberRating(row.performanceRating, row.members.length);
    for (const member of row.members) {
      output.push({
        id: member,
        rank: row.rank,
        rating: getRating(member),
        performanceRating,
        neededRating,
        seed: row.seed,
        delta: Math.trunc((neededRating - getRating(member)) * ELO_UPDATE_FACTOR),
      });
    }
  }

  output.sort((a, b) => b.rating - a.rating || a.rank - b.rank);

  const sumDelta = output.reduce((acc, row) => acc + row.delta, 0);
  const inc1 = Math.trunc(-sumDelta / output.length) - 1;
  for (const row of output) {
    row.delta += inc1;
  }

  const topCount = Math.min(output.length, Math.round(4 * Math.sqrt(output.length)));
  const sumTop = output.slice(0, topCount).reduce((acc, row) => acc + row.delta, 0);
  let inc2 = Math.trunc(-sumTop / topCount);
  inc2 = Math.max(-10, Math.min(0, inc2));
  for (const row of output) {
    row.delta += inc2;
  }

  const sumDeltaFinal = output.reduce((acc, row) => acc + row.delta, 0);

  const firstTimeParticipantCount = output.reduce((count, participant) => {
    const state = playerStates.get(participant.id);
    return count + (state && state.history.length === 0 ? 1 : 0);
  }, 0);

  const statistics = {
    firstTimeParticipantCount,
    adjustment1: inc1,
    adjustment2: inc2,
    topCount,
    sumDeltaFinal,
  };

  return [output, statistics];
}

module.exports = {
  applyCodeforcesUpdate,
  parseContestTimestamp,
  DEFAULT_INITIAL_RATING,
  ELO_SCALE,
  ELO_UPDATE_FACTOR,
};
