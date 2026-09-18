/**
 * Codeforces-style Elo rating calculations for ranked contest participants.
 */

/**
 * Sums the base-10 power of every rating.
 *
 * @param {number[]} ratings Ratings to convert.
 * @returns {number} Summed rating power.
 */
function sumRatingPower(ratings, scale) {
  var total = 0;
  for (const rating of ratings) {
    total += Math.pow(10, rating / scale);
  }
  return total;
}

/**
 * Team rating aggregations.
 *
 * Every aggregation is a function of the ratings of the members with contest
 * history and the number of members without it. It returns the team rating, or
 * null when the team cannot be rated from those members.
 */
const TEAM_RATING_AGGREGATIONS = {
  "log-power-sum": (ratedRatings, unratedCount) =>
    ratedRatings.length === 0
      ? ELO_INITIAL_RATING + Math.log10(unratedCount) * ELO_SCALE
      : Math.log10(sumRatingPower(ratedRatings, ELO_SCALE)) * ELO_SCALE,
  "log-power-mean": (ratedRatings, unratedCount) =>
    ratedRatings.length === 0
      ? ELO_INITIAL_RATING
      : Math.log10(sumRatingPower(ratedRatings, ELO_SCALE) / ratedRatings.length) * ELO_SCALE,
  mean: (ratedRatings, unratedCount) =>
    ratedRatings.length === 0
      ? ELO_INITIAL_RATING
      : ratedRatings.reduce((sum, rating) => sum + rating, 0) / ratedRatings.length,
  max: (ratedRatings, unratedCount) => (ratedRatings.length === 0 ? ELO_INITIAL_RATING : Math.max(...ratedRatings)),
};
/**
 * Member rating from team rating aggregations.
 */
const MEMBER_RATING_FUNCTIONS = {
  "log-power-sum": (teamRating, memberCount) => teamRating - ELO_SCALE * Math.log10(memberCount),
  "log-power-mean": (teamRating, memberCount) => teamRating,
  mean: (teamRating, memberCount) => teamRating,
  max: (teamRating, memberCount) => teamRating,
};

/**
 * Reads a numeric environment variable or returns a fallback value.
 * @param {string} name Environment variable name.
 * @param {number} fallback Fallback value when the variable is not set or invalid.
 * @returns {number} Numeric value of the environment variable or fallback.
 */
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Reads and validates a team rating aggregation selected by an environment variable.
 *
 * @param {string} name Environment variable name.
 * @param {string} fallback Aggregation used when the variable is not set.
 * @returns {string} Selected aggregation name.
 */
function envAggregation(name, fallback) {
  const value = process.env[name] || fallback;
  if (!Object.prototype.hasOwnProperty.call(TEAM_RATING_AGGREGATIONS, value)) {
    throw new Error(
      `Unknown team rating aggregation "${value}" for ${name}; expected one of ${Object.keys(TEAM_RATING_AGGREGATIONS).join(
        ", ",
      )}.`,
    );
  }
  return value;
}

/**
 * Clamps a value to a given range.
 * @param {number} value Value to clamp.
 * @param {number} min Minimum value.
 * @param {number} max Maximum value.
 * @returns {number} Clamped value.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const MIN_RATING_FOR_SEARCH = -20000;
const MAX_RATING_FOR_SEARCH = 20000;

const ELO_SCALE = envNumber("XCPC_ELO_SCALE", 400);
const ELO_INITIAL_RATING = envNumber("XCPC_ELO_INITIAL_RATING", 1400);
const ELO_UPDATE_FACTOR = envNumber("XCPC_ELO_UPDATE_FACTOR", 0.8);
const ELO_SEARCH_OFFSET = envNumber("XCPC_ELO_SEARCH_OFFSET", 0.5);
const ELO_SEED_RANK_RADIUS = envNumber("XCPC_ELO_SEED_RANK_RADIUS", 100000);
const ELO_MIN_ADJUST_DELTA = envNumber("XCPC_ELO_MIN_ADJUST_DELTA", -10000);
const ELO_MAX_ADJUST_DELTA = envNumber("XCPC_ELO_MAX_ADJUST_DELTA", 0);
const ELO_MIN_ADJUST_TOP_DELTA = envNumber("XCPC_ELO_MIN_ADJUST_TOP_DELTA", 0);
const ELO_MAX_ADJUST_TOP_DELTA = envNumber("XCPC_ELO_MAX_ADJUST_TOP_DELTA", 0);

// Aggregation driving the Elo computation: the seed model, and through it the
// performance and needed rating of every team.
const ELO_TEAM_RATING_AGGREGATION = envAggregation("XCPC_ELO_TEAM_RATING_AGGREGATION", "log-power-mean");

/**
 * Builds rating/seed lookup helpers for a participant population.
 *
 * @param {object[]} rows Teams with numeric `rating` fields.
 * @returns {object} Seed calculation helper functions.
 */
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

  /**
   * Returns expected win probability against an opponent with the given rating difference.
   *
   * @param {number} diff Query rating minus opponent rating.
   * @returns {number} Expected score from 0 to 1.
   */
  function probabilityByDifference(diff) {
    let value = probabilityByDiff.get(diff);
    if (value !== undefined) {
      return value;
    }
    value = 1 / (1 + Math.pow(10, diff / ELO_SCALE));
    probabilityByDiff.set(diff, value);
    return value;
  }

  /**
   * Calculates or returns cached seed against the configured population.
   *
   * @param {number} queryRating Rating to seed.
   * @returns {number} Expected number of teams finishing above the rating.
   */
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

  /**
   * Finds the rating whose population seed is closest to a target seed.
   *
   * @param {number} targetSeed Seed value to invert.
   * @returns {number} Rating corresponding to the target seed.
   */
  function findRatingForSeed(targetSeed) {
    let left = MIN_RATING_FOR_SEARCH;
    let right = MAX_RATING_FOR_SEARCH;

    while (left < right) {
      const middle = (left + right) >> 1;
      const middleSeed = seedWithPopulation(middle);
      if (middleSeed > targetSeed + ELO_SEARCH_OFFSET) {
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

/**
 * Computes Codeforces-style rating updates and contest statistics.
 *
 * @param {object[]} input Contest teams with `rank` and member IDs.
 * @param {Map<string, object>} playerStates Current player state map.
 * @returns {Array<object[]|object>} Rating updates and contest statistics.
 */
function applyCodeforcesUpdate(input, playerStates) {
  if (input.length < 2) {
    throw new Error("Not enough participants.");
  }

  /**
   * Reads a player's current rating.
   *
   * @param {string} memberId Teammate ID.
   * @returns {number} Current rating.
   */
  function getRating(memberId) {
    const state = playerStates.get(memberId);
    return state.rating;
  }

  /**
   * Checks whether a teammate has participated in at least one prior contest.
   *
   * @param {string} memberId Teammate ID.
   * @returns {boolean} True when the teammate has contest history.
   */
  function hasContestHistory(memberId) {
    return playerStates.get(memberId).history.length > 0;
  }

  /**
   * Reads the current ratings of the given members.
   *
   * @param {string[]} members Teammate IDs.
   * @returns {number[]} Current ratings.
   */
  function getRatings(members) {
    return members.map((member) => getRating(member));
  }

  /**
   * Aggregates a team into a team rating with the given aggregation.
   *
   * The aggregation drives the Elo computation only; the seeded rank prediction
   * is derived from the same rating and exists for display purposes.
   *
   * Teammates without contest history only carry their initial rating, so they are
   * passed to the aggregation as a count instead of as ratings.
   *
   * @param {object} team Team row containing member IDs.
   * @param {Function} aggregation Team rating aggregation.
   * @returns {number} Team rating.
   */
  function calculateTeamRating(team, aggregation) {
    const ratedMembers = team.members.filter(hasContestHistory);
    return aggregation(getRatings(ratedMembers), team.members.length - ratedMembers.length);
  }

  /**
   * Determine if the rank of a team is possible to predict.
   *
   * @param {object} team Team to determine
   * @returns {boolean} True if the team is eligible for prediction
   */
  function predictionPossible(team) {
    return team.members.some((member) => playerStates.get(member).history.length > 0);
  }

  const aggregation = TEAM_RATING_AGGREGATIONS[ELO_TEAM_RATING_AGGREGATION];
  const calculateMemberRating = MEMBER_RATING_FUNCTIONS[ELO_TEAM_RATING_AGGREGATION];

  const teams = input.map((team) => ({
    rank: team.rank,
    members: team.members,
    teamName: team.teamName,
    rating: calculateTeamRating(team, aggregation),
    hasHistory: team.members.some((member) => hasContestHistory(member)),
    shouldPredict: predictionPossible(team),
    predictedRank: null,
    seed: 1,
    performanceRating: null,
    neededRating: null,
    delta: 0,
  }));

  // Rank prediction only uses what is known before the contest: teams with rated
  // members keep their aggregated rating, teams without history are assumed to be
  // at the initial rating. The interpolation below is part of the Elo computation
  // and must not leak the contest outcome into the prediction.
  const predictedOrder = [...teams].sort((left, right) => right.rating - left.rating);

  var deviation = 0;
  predictedOrder.forEach((team, index) => {
    if (team.shouldPredict) {
      team.predictedRank = index + 1;
      const diff = team.rank - team.predictedRank;
      deviation += diff * diff;
    }
  });

  const predictedTeams = [];
  for (const team of teams) {
    if (team.shouldPredict) {
      predictedTeams.push({ ratedRank: predictedTeams.length + 1, rating: team.rating });
    }
  }
  predictedTeams.sort((left, right) => right.rating - left.rating);
  predictedTeams.forEach((team, index) => {
    team.predictedRatedRank = index + 1;
  });

  var spearmanSum = 0;
  for (const team of predictedTeams) {
    const diff = team.predictedRatedRank - team.ratedRank;
    spearmanSum += diff * diff;
  }

  const predictionStats = {
    predictionTeamCount: predictedTeams.length,
    predictionSpearman: 1 - (6 * spearmanSum) / (predictedTeams.length * (predictedTeams.length * predictedTeams.length - 1)),
    predictionStddev: Math.sqrt(deviation / predictedTeams.length),
  };

  // Teams without contest history are anchored to the closest rated teams around
  // their rank; without an anchor on both sides every member joins the aggregate
  // at its initial rating.
  const minRank = 1;
  const maxRank = teams.length;

  // Teams arrive in rank order with contiguous ranks, so one scan per direction
  // finds the closest rated team on each side of every rank, which keeps this
  // linear in the number of teams instead of scanning up to
  // ELO_SEED_RANK_RADIUS ranks per team.
  const previousRated = new Array(teams.length).fill(-1);
  let lastRated = -1;
  for (let index = 0; index < teams.length; index += 1) {
    previousRated[index] = lastRated;
    if (teams[index].hasHistory) {
      lastRated = index;
    }
  }

  let upcomingRated = -1;
  for (let index = teams.length - 1; index >= 0; index -= 1) {
    const team = teams[index];
    if (team.hasHistory) {
      upcomingRated = index;
      continue;
    }

    const upperTeam = previousRated[index] < 0 ? null : teams[previousRated[index]];
    const lowerTeam = upcomingRated < 0 ? null : teams[upcomingRated];
    const upperInRange = upperTeam !== null && team.rank - upperTeam.rank <= ELO_SEED_RANK_RADIUS;
    const lowerInRange = lowerTeam !== null && lowerTeam.rank - team.rank <= ELO_SEED_RANK_RADIUS;

    if (upperInRange && lowerInRange) {
      const share = (team.rank - upperTeam.rank) / (lowerTeam.rank - upperTeam.rank);
      team.rating = upperTeam.rating + (lowerTeam.rating - upperTeam.rating) * share;
    } else if (team.rank - ELO_SEED_RANK_RADIUS < minRank && lowerInRange) {
      team.rating = lowerTeam.rating;
    } else if (team.rank + ELO_SEED_RANK_RADIUS > maxRank && upperInRange) {
      team.rating = upperTeam.rating;
    }
  }

  for (const team of teams) {
    team.rating = Math.round(team.rating);
  }

  const seedModel = buildSeedModel(teams);
  for (const team of teams) {
    team.seed = seedModel.seedWithoutSelf(team.rating);
  }

  for (const team of teams) {
    team.performanceRating = seedModel.findRatingForSeed(team.rank);
    const middleRank = Math.sqrt(team.rank * team.seed);
    team.neededRating = seedModel.findRatingForSeed(middleRank);
  }

  // ELO computation starts below:

  const output = [];
  for (const team of teams) {
    const neededRating = calculateMemberRating(team.neededRating, team.members.length);
    const performanceRating = calculateMemberRating(team.performanceRating, team.members.length);
    team.members.forEach((member, index) => {
      const oldRating = getRating(member);
      output.push({
        id: member,
        rank: team.rank,
        predictedRank: team.predictedRank,
        seedRating: team.rating,
        rating: oldRating,
        performanceRating: Math.round(performanceRating),
        neededRating: Math.round(neededRating),
        seed: team.seed,
        delta: Math.round((neededRating - oldRating) * ELO_UPDATE_FACTOR),
        teamName: team.teamName,
        memberIndex: index,
      });
    });
  }

  output.sort((a, b) => b.rating - a.rating || a.rank - b.rank);

  const sumDelta = output.reduce((acc, row) => acc + row.delta, 0);
  const inc1 = clamp(Math.trunc(-sumDelta / output.length) - 1, ELO_MIN_ADJUST_DELTA, ELO_MAX_ADJUST_DELTA);
  for (const row of output) {
    row.delta += inc1;
  }

  let inc2 = 0;
  let topCount = 0;
  topCount = Math.min(output.length, Math.round(4 * Math.sqrt(output.length)));
  const sumTop = output.slice(0, topCount).reduce((acc, row) => acc + row.delta, 0);
  inc2 = Math.trunc(-sumTop / topCount);
  inc2 = clamp(inc2, ELO_MIN_ADJUST_TOP_DELTA, ELO_MAX_ADJUST_TOP_DELTA);
  for (const row of output) {
    row.delta += inc2;
  }

  var firstTimeParticipantCount = 0;
  var firstTimeParticipantRatingSum = 0;
  var ratingSum = 0;
  for (const participant of output) {
    if (!hasContestHistory(participant.id)) {
      firstTimeParticipantCount++;
      firstTimeParticipantRatingSum += participant.rating + participant.delta;
    }
    ratingSum += participant.rating + participant.delta;
  }

  const statistics = {
    teamCount: teams.length,
    participantCount: output.length,
    firstTimeParticipantCount,
    firstTimeParticipantRatingSum,
    ratingSum,
    adjustment1: inc1,
    adjustment2: inc2,
    topCount,
    ...predictionStats,
  };

  return [output, statistics];
}

module.exports = {
  applyCodeforcesUpdate,
  ELO_INITIAL_RATING,
  ELO_SCALE,
  ELO_TEAM_RATING_AGGREGATION,
  ELO_UPDATE_FACTOR,
};
