/**
 * Shared browser helpers.
 */
window.xcpcFrontendUtils = {
  /**
   * Unpack compressed player history data.
   *
   * @param {object} data Raw packed elo data
   */
  unpackPlayerHistory(data) {
    data.players.forEach((player) => {
      player.history = player.history.map((event) => {
        return {
          contestId: event[0],
          contest: data.contests[event[0]] || null,
          rank: event[1],
          delta: event[2],
          newRating: event[3],
          performanceRating: event[4],
          seedRating: event[5],
          predictedRank: event[6],
        };
      });
    });
  },

  /**
   * Formats a signed numeric delta for display.
   *
   * @param {number} value Delta value.
   * @returns {string} Signed string, for example `+24` or `-3`.
   */
  formatDelta(value) {
    return Number.isFinite(value) ? (value > 0 ? `+${value}` : `${value}`) : `${value}`;
  },

  /**
   * Updates the current URL without adding a history entry.
   *
   * @param {string} parameter Query parameter name.
   * @param {string} value New query parameter value.
   */
  updateUrl(parameter, value) {
    const url = new URL(window.location.href);
    url.searchParams.set(parameter, value);
    window.history.replaceState(null, "", url);
  },

  /**
   * HTML-escapes a value for use inside generated markup.
   *
   * @param {*} value Value to escape.
   * @returns {string} Escaped text.
   */
  escapeHtml(value) {
    return `${value || ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  /**
   * Applies Codeforces-style rating colors to a formatted value.
   *
   * @param {number} rating Numeric rating used to select the color tier.
   * @param {*} value Text to colorize.
   * @returns {string} HTML span markup with the matching rating color.
   */
  colorizeRating(rating, value) {
    value = `${value}`;
    if (rating < 1200) return `<span style="color: var(--rating-color-0)">${value}</span>`;
    if (rating < 1400) return `<span style="color: var(--rating-color-1)">${value}</span>`;
    if (rating < 1600) return `<span style="color: var(--rating-color-2)">${value}</span>`;
    if (rating < 1900) return `<span style="color: var(--rating-color-3)">${value}</span>`;
    if (rating < 2100) return `<span style="color: var(--rating-color-4)">${value}</span>`;
    if (rating < 2300) return `<span style="color: var(--rating-color-5)">${value}</span>`;
    if (rating < 2400) return `<span style="color: var(--rating-color-6)">${value}</span>`;
    if (rating < 2600) return `<span style="color: var(--rating-color-7)">${value}</span>`;
    if (rating < 3000) return `<span style="color: var(--rating-color-8)">${value}</span>`;
    return `<span style="color:var(--rating-color-9a)">${value[0]}</span><span style="color: var(--rating-color-9b)">${value.slice(1)}</span>`;
  },
};
