/**
 * Pure helpers behind the prediction page.
 *
 * The CSV handling mirrors the former CLI predictor: headers normalize to
 * trimmed collapsed text, column names are matched by the same patterns, a
 * teammate cell splits on the same separators, short rows pad and long rows
 * truncate to the header length. The team rating, however, always follows the
 * aggregation recorded in the Elo data instead of a user-chosen mode.
 */
(function (root) {
  const TEAMMATE_HEADER = /teammate|队员|member/i;
  const TEAMMATE_HEADER_BLACKLIST = /rating/i;
  const ORGANIZATION_HEADER = /school|university|学校|院校|organization/i;
  const NAME_SPLIT = /[;,，、\/\|\n\t]+/;

  /**
   * Trims and collapses whitespace, matching ranklist-utils.normalize.
   *
   * @param {*} value Raw value.
   * @returns {string} Normalized text.
   */
  function normalize(value) {
    return `${value == null ? "" : value}`.trim().replace(/\s+/g, " ");
  }

  /**
   * Splits one CSV cell into distinct teammate names.
   *
   * @param {*} rawText Teammate cell text.
   * @returns {string[]} Normalized, non-empty, de-duplicated names.
   */
  function splitTeammates(rawText) {
    const text = normalize(rawText);
    if (!text) return [];
    return [...new Set(text.split(NAME_SPLIT).map(normalize).filter(Boolean))];
  }

  /**
   * Parses CSV text into normalized headers and padded rows.
   *
   * Follows the csv-parse options used by the legacy CLI: relaxed column counts,
   * empty lines kept as records, quoted fields with doubled quotes and embedded
   * newlines.
   *
   * @param {string} text CSV source text.
   * @returns {{headers: string[], rows: string[][]}} Parsed data.
   */
  function parseCsv(text) {
    const records = [];
    let record = [];
    let field = "";
    let inQuotes = false;
    let hasContent = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        inQuotes = true;
        hasContent = true;
      } else if (char === ",") {
        record.push(field);
        field = "";
        hasContent = true;
      } else if (char === "\n") {
        record.push(field);
        records.push(record);
        record = [];
        field = "";
        hasContent = false;
      } else if (char !== "\r") {
        field += char;
        hasContent = true;
      }
    }
    if (hasContent || record.length > 0) {
      record.push(field);
      records.push(record);
    }

    if (!records.length) return { headers: [], rows: [] };

    const headers = records[0].map((header, index) => {
      const value = index === 0 ? `${header || ""}`.replace(/^\uFEFF/, "") : header;
      return normalize(value);
    });
    const rows = records.slice(1).map((rawRow) => {
      const padded = rawRow.slice();
      while (padded.length < headers.length) padded.push("");
      return padded.slice(0, headers.length);
    });
    return { headers, rows };
  }

  /**
   * Locates teammate and organization columns by header patterns.
   *
   * @param {string[]} headers Normalized headers.
   * @returns {{teammateIndexes: number[], organizationIndex: number}} Columns.
   */
  function detectColumns(headers) {
    const teammateIndexes = [];
    let organizationIndex = -1;
    headers.forEach((header, index) => {
      if (TEAMMATE_HEADER.test(header) && !TEAMMATE_HEADER_BLACKLIST.test(header)) teammateIndexes.push(index);
      if (organizationIndex < 0 && ORGANIZATION_HEADER.test(header)) organizationIndex = index;
    });
    return { teammateIndexes, organizationIndex };
  }

  /**
   * Turns CSV rows into prediction-ready team entries.
   *
   * @param {{headers: string[], rows: string[][]}} parsed Parsed CSV.
   * @param {number[]} teammateIndexes Teammate column indexes.
   * @param {number} organizationIndex Organization column index.
   * @returns {object[]} Team entries in source order.
   */
  function buildTeams(parsed, teammateIndexes, organizationIndex) {
    return parsed.rows.map((row, rowIndex) => ({
      originalRow: row,
      sourceRowIndex: rowIndex,
      organization: organizationIndex >= 0 ? normalize(row[organizationIndex]) : "",
      teammateNames: [...new Set(teammateIndexes.flatMap((index) => splitTeammates(row[index])))],
    }));
  }

  /**
   * Builds the lowercased organization/name lookup key.
   *
   * @param {string} organization Organization name.
   * @param {string} teammate Teammate name.
   * @returns {string} Lookup key.
   */
  function lookupKey(organization, teammate) {
    return `${normalize(organization).toLowerCase()}\u0001${normalize(teammate).toLowerCase()}`;
  }

  /**
   * Aggregates teammate ratings with the aggregation configured in the Elo data.
   *
   * @param {number[]} ratings Ratings of the matched teammates.
   * @param {string} aggregation Aggregation name from elo config.
   * @param {number} scale Elo scale.
   * @returns {number} Team rating, or 0 when nothing matched.
   */
  function aggregateRating(ratings, aggregation, scale) {
    if (!ratings.length) return 0;
    const sum = ratings.reduce((total, rating) => total + rating, 0);
    if (aggregation === "max") return Math.max(...ratings);
    if (aggregation === "mean") return sum / ratings.length;
    if (aggregation === "log-power-sum" || aggregation === "log-power-mean") {
      const powers = ratings.reduce((total, rating) => total + Math.pow(10, rating / scale), 0);
      return Math.log10(aggregation === "log-power-sum" ? powers : powers / ratings.length) * scale;
    }
    if (aggregation === "sum") return sum;
    throw new Error(`未知的评分方式: ${aggregation}`);
  }

  /**
   * Scores and ranks the teams.
   *
   * @param {object[]} teams Team entries from buildTeams.
   * @param {Map<string, number>} ratingIndex Teammate rating lookup.
   * @param {object} options Rating options.
   * @param {string} options.aggregation Aggregation name from elo config.
   * @param {number} options.scale Elo scale.
   * @param {object} [options.law] Fitted rank law, enabling bucket probabilities.
   * @returns {object[]} Teams sorted by predicted rank.
   */
  function predict(teams, ratingIndex, options) {
    const scored = teams.map((team) => {
      const ratings = [];
      let known = 0;
      let unknown = 0;
      for (const name of team.teammateNames) {
        const rating = ratingIndex.get(lookupKey(team.organization, name));
        if (Number.isFinite(rating)) {
          known += 1;
          ratings.push(rating);
        } else {
          unknown += 1;
        }
      }
      return {
        ...team,
        matchedRatings: ratings,
        knownMembers: known,
        unknownMembers: unknown,
        ratingScore: aggregateRating(ratings, options.aggregation, options.scale),
      };
    });

    scored.sort(
      (left, right) =>
        right.ratingScore - left.ratingScore ||
        right.knownMembers - left.knownMembers ||
        left.sourceRowIndex - right.sourceRowIndex,
    );
    scored.forEach((team, index) => {
      team.predictedRank = index + 1;
    });

    // Bucket probabilities are relative to the rated teams, the population the
    // law was fitted on; teams without a matched member stay outside it.
    const matched = scored.filter((team) => team.knownMembers > 0);
    if (options.law && matched.length > 1) {
      for (const team of matched) {
        const percentile = (team.predictedRank - 0.5) / matched.length;
        team.bucketProbabilities = bucketProbabilities(percentile, options.law);
        team.bucketPercents = percentBuckets(team.bucketProbabilities);
      }
    }
    return scored;
  }

  /**
   * Formats one CSV cell, quoting only when needed.
   *
   * @param {*} value Cell value.
   * @returns {string} Cell text.
   */
  function csvCell(value) {
    const text = value == null ? "" : `${value}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // Lanczos coefficients for log Gamma, used by the Student-t CDF.
  const LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  /**
   * Natural log of the gamma function.
   *
   * @param {number} x Positive argument.
   * @returns {number} log Gamma(x).
   */
  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    const z = x - 1;
    let series = LANCZOS[0];
    for (let index = 1; index < LANCZOS.length; index += 1) series += LANCZOS[index] / (z + index);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
  }

  /**
   * Natural log of the beta function.
   *
   * @param {number} a First shape.
   * @param {number} b Second shape.
   * @returns {number} log B(a, b).
   */
  function logBeta(a, b) {
    return logGamma(a) + logGamma(b) - logGamma(a + b);
  }

  /**
   * Continued fraction of the incomplete beta function (Numerical Recipes betacf).
   *
   * @param {number} x Argument.
   * @param {number} a First shape.
   * @param {number} b Second shape.
   * @returns {number} Fraction value.
   */
  function betaFraction(x, a, b) {
    const tiny = 1e-300;
    const epsilon = 3e-12;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m += 1) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const step = d * c;
      h *= step;
      if (Math.abs(step - 1) < epsilon) break;
    }
    return h;
  }

  /**
   * Regularized incomplete beta function.
   *
   * @param {number} x Upper limit in [0, 1].
   * @param {number} a First shape.
   * @param {number} b Second shape.
   * @returns {number} I_x(a, b).
   */
  function incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = logBeta(a, b);
    if (x < (a + 1) / (a + b + 2)) {
      return (Math.exp(a * Math.log(x) + b * Math.log(1 - x) - front) * betaFraction(x, a, b)) / a;
    }
    return 1 - (Math.exp(b * Math.log(1 - x) + a * Math.log(x) - front) * betaFraction(1 - x, b, a)) / b;
  }

  /**
   * CDF of Student's t distribution.
   *
   * @param {number} t Quantile.
   * @param {number} nu Degrees of freedom.
   * @returns {number} P(T <= t).
   */
  function studentTCdf(t, nu) {
    if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
    const tail = 0.5 * incompleteBeta(nu / (nu + t * t), nu / 2, 0.5);
    return t >= 0 ? 1 - tail : tail;
  }

  /**
   * Logit of a probability, guarded at the boundaries.
   *
   * @param {number} p Probability.
   * @returns {number} log(p / (1 - p)).
   */
  function logit(p) {
    const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
    return Math.log(clamped / (1 - clamped));
  }

  /**
   * Award band of a rank under ICPC medal rules.
   *
   * Medals cover 10%, 30% and 60% of the field and the number of places is
   * rounded up, so a rank earns gold when `rank <= ceil(0.1 * n)` and likewise
   * for silver and bronze.
   *
   * @param {number} rank 1-based rank.
   * @param {number} total Number of teams in the field.
   * @returns {"gold"|"silver"|"bronze"|"iron"} Award band.
   */
  function awardForRank(rank, total) {
    if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 0) return "iron";
    if (rank <= Math.ceil(total * 0.1)) return "gold";
    if (rank <= Math.ceil(total * 0.3)) return "silver";
    if (rank <= Math.ceil(total * 0.6)) return "bronze";
    return "iron";
  }

  /**
   * Probability of each finishing bucket for a team at percentile p.
   *
   * The law is `q = logistic(a + b*logit(p) + c*logit(p)^2 + scale * t(nu))`, so
   * P(q <= x) = CDF_t((logit(x) - location) / scale).
   *
   * @param {number} p Predicted percentile in (0, 1).
   * @param {object} law Fitted law from out/calibration/law.json.
   * @returns {Array<{name: string, probability: number}>} Bucket probabilities.
   */
  function bucketProbabilities(p, law) {
    const { a, b, c } = law.params;
    const scale = Math.exp(law.params.logScale);
    const nu = Math.exp(law.params.logNu);
    const x = logit(p);
    const location = a + b * x + c * x * x;
    const cumulativeAt = (threshold) =>
      threshold >= 1 ? 1 : studentTCdf((logit(threshold) - location) / scale, nu);

    let previous = 0;
    return law.buckets.map(([name, , upper]) => {
      const cumulative = cumulativeAt(upper);
      const probability = Math.max(0, cumulative - previous);
      previous = Math.max(previous, cumulative);
      return { name, probability };
    });
  }

  /**
   * Rounds bucket probabilities to whole percentages that sum to 100.
   *
   * @param {Array<{name: string, probability: number}>} buckets Bucket probabilities.
   * @returns {number[]} Percentages in bucket order.
   */
  function percentBuckets(buckets) {
    const exact = buckets.map((bucket) => bucket.probability * 100);
    const rounded = exact.map((value) => Math.round(value));
    const delta = 100 - rounded.reduce((total, value) => total + value, 0);
    if (delta !== 0) {
      let target = 0;
      exact.forEach((value, index) => {
        if (Math.abs(value - rounded[index]) > Math.abs(exact[target] - rounded[target])) target = index;
      });
      rounded[target] += delta;
    }
    return rounded;
  }

  /**
   * Serializes rows as CSV text.
   *
   * @param {string[]} headers Output headers.
   * @param {Array<Array<*>>} rows Output rows.
   * @returns {string} CSV text.
   */
  function serializeCsv(headers, rows) {
    return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  }

  /**
   * Builds the predicted CSV, mirroring the legacy default output columns.
   *
   * @param {object[]} predicted Predicted teams.
   * @param {string[]} inputHeaders Headers of the input CSV.
   * @param {string} scoreColumn Name of the score column.
   * @param {boolean} [withBuckets] Whether to add the bucket columns.
   * @returns {{headers: string[], rows: Array<Array<*>>}} Output table.
   */
  function buildOutput(predicted, inputHeaders, scoreColumn, withBuckets = false) {
    const names = predicted.find((team) => team.bucketProbabilities)?.bucketProbabilities.map((b) => b.name) || [];
    const bucketHeaders = withBuckets ? names.map((name) => `p_${name}_pct`) : [];
    const headers = ["predicted_rank", scoreColumn, ...bucketHeaders, ...inputHeaders];
    const rows = predicted.map((team) => [
      team.predictedRank,
      Math.round(team.ratingScore),
      ...(withBuckets && team.bucketPercents ? team.bucketPercents : bucketHeaders.map(() => "")),
      ...team.originalRow,
    ]);
    return { headers, rows };
  }

  const api = {
    aggregateRating,
    awardForRank,
    bucketProbabilities,
    buildOutput,
    buildTeams,
    detectColumns,
    logit,
    lookupKey,
    normalize,
    parseCsv,
    percentBuckets,
    predict,
    serializeCsv,
    splitTeammates,
    studentTCdf,
  };

  root.xcpcPredict = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
