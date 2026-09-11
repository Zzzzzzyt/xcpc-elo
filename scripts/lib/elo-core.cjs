/**
 * Codeforces-style Elo rating calculations for ranked contest participants.
 */
const MIN_RATING_FOR_SEARCH = -20000;
const MAX_RATING_FOR_SEARCH = 20000;
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const ELO_SCALE = envNumber("XCPC_ELO_SCALE", 400);
const ELO_INITIAL_RATING = envNumber("XCPC_ELO_INITIAL_RATING", 1400);
const ELO_UPDATE_FACTOR = envNumber("XCPC_ELO_UPDATE_FACTOR", 0.65);
const ELO_SEARCH_OFFSET = envNumber("XCPC_ELO_SEARCH_OFFSET", 0.5);
const ELO_SEED_RANK_RADIUS = envNumber("XCPC_ELO_SEED_RANK_RADIUS", 2);
const ELO_ADJUST_TOP_DELTA =
  process.env.XCPC_ELO_ADJUST_TOP_DELTA === undefined ? false : process.env.XCPC_ELO_ADJUST_TOP_DELTA !== "false";

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
   * Aggregates the given teammate ratings into a team rating.
   *
   * @param {string[]} members Teammate IDs to aggregate.
   * @returns {number} Aggregate team rating.
   */
  function aggregateTeamRating(members) {
    var total = 0;
    for (const member of members) {
      total += Math.pow(10, getRating(member) / ELO_SCALE);
    }
    return Math.round(Math.log10(total) * ELO_SCALE);
  }

  /**
   * Aggregates teammate ratings into a team rating.
   *
   * Teammates without contest history only carry their initial rating, so they are
   * excluded to keep the seed driven by members that have actually competed.
   *
   * @param {object} team Team row containing member IDs.
   * @returns {number|null} Aggregate team rating, or null when no member has history.
   */
  function calculateTeamRating(team) {
    const ratedMembers = team.members.filter(hasContestHistory);
    if (ratedMembers.length === 0) {
      return null;
    }
    return aggregateTeamRating(ratedMembers);
  }

  /**
   * Converts a team-level rating to an individual member rating.
   *
   * @param {number} rating Team rating.
   * @param {number} memberCount Team size.
   * @returns {number} Member rating.
   */
  function calculateMemberRating(rating, memberCount) {
    return Math.round(rating - ELO_SCALE * Math.log10(memberCount));
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

  const teams = input.map((team) => ({
    rank: team.rank,
    members: team.members,
    rating: calculateTeamRating(team),
    shouldPredict: predictionPossible(team),
    predictedRank: null,
    seed: 1,
    performanceRating: null,
    neededRating: null,
    delta: 0,
  }));

  const teamsByRank = new Map(teams.map((team) => [team.rank, team]));
  const ranksWithHistory = new Set(teams.filter((team) => team.rating !== null).map((team) => team.rank));
  for (const team of teams) {
    if (team.rating !== null) {
      continue;
    }

    let upperTeam = null;
    let lowerTeam = null;
    for (let offset = 1; offset <= ELO_SEED_RANK_RADIUS; offset += 1) {
      if (!upperTeam) {
        const candidate = teamsByRank.get(team.rank - offset);
        if (candidate && ranksWithHistory.has(candidate.rank)) {
          upperTeam = candidate;
        }
      }
      if (!lowerTeam) {
        const candidate = teamsByRank.get(team.rank + offset);
        if (candidate && ranksWithHistory.has(candidate.rank)) {
          lowerTeam = candidate;
        }
      }
    }

    if (upperTeam && lowerTeam) {
      const share = (team.rank - upperTeam.rank) / (lowerTeam.rank - upperTeam.rank);
      team.rating = Math.round(upperTeam.rating + (lowerTeam.rating - upperTeam.rating) * share);
    } else {
      team.rating = aggregateTeamRating(team.members);
    }
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

  const predictedTeams = [];

  for (const team of teams) {
    if (team.shouldPredict) {
      predictedTeams.push({ ratedRank: predictedTeams.length + 1, rating: team.rating });
    }
  }

  const ratedOrder = [...predictedTeams].sort((left, right) => right.rating - left.rating);
  ratedOrder.forEach((team, index) => {
    team.predictedRatedRank = index + 1;
  });

  var spearmanSum = 0;
  for (const team of predictedTeams) {
    const diff = team.predictedRatedRank - team.ratedRank;
    spearmanSum += diff * diff;
  }

  const predictedOrder = [...teams].sort((left, right) => right.rating - left.rating);
  var deviation = 0;
  const predictionRankDifferences = [];
  predictedOrder.forEach((team, index) => {
    if (team.shouldPredict) {
      team.predictedRank = index + 1;
      const diff = team.rank - team.predictedRank;
      predictionRankDifferences.push(diff);
      deviation += diff * diff;
    }
  });

  const predictionStats = {
    predictionTeamCount: predictedTeams.length,
    predictionRankDifferences,
    predictionSpearman: 1 - (6 * spearmanSum) / (predictedTeams.length * (predictedTeams.length * predictedTeams.length - 1)),
    predictionStddev: Math.sqrt(deviation / predictedTeams.length),
  };

  // ELO computation starts below:

  const output = [];
  for (const team of teams) {
    const neededRating = calculateMemberRating(team.neededRating, team.members.length);
    const performanceRating = calculateMemberRating(team.performanceRating, team.members.length);
    for (const member of team.members) {
      output.push({
        id: member,
        rank: team.rank,
        predictedRank: team.predictedRank,
        seedRating: team.rating,
        rating: getRating(member),
        performanceRating,
        neededRating,
        seed: team.seed,
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

  let inc2 = 0;
  let topCount = 0;
  if (ELO_ADJUST_TOP_DELTA) {
    topCount = Math.min(output.length, Math.round(4 * Math.sqrt(output.length)));
    const sumTop = output.slice(0, topCount).reduce((acc, row) => acc + row.delta, 0);
    inc2 = Math.trunc(-sumTop / topCount);
    inc2 = Math.max(-10, Math.min(0, inc2));
    for (const row of output) {
      row.delta += inc2;
    }
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
  ELO_UPDATE_FACTOR,
};
