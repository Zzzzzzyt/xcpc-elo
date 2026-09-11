/**
 * Initializes the player leaderboard and player detail dashboard.
 */
(function bootstrap() {
  const data = window.__ELO_DATA__;
  if (!data || !Array.isArray(data.players) || !Array.isArray(data.contests)) {
    document.body.innerHTML =
      "<p style='padding:16px;font-family:sans-serif'>未找到 Elo 数据，请先运行：npm run build:elo-dashboard</p>";
    return;
  }

  const contestDisplayTitle = (contest, index) => {
    if (!contest) return `比赛 #${index}`;
    if (!contest.alias) return contest.title || `比赛 #${index}`;
    const parts = `${contest.sourcePath || ""}`.split("/").filter(Boolean);
    const series = parts[0] === "provincial" && parts[1] ? provincialSeriesLabel(parts[1]) : (parts[0] || "").toUpperCase();
    const year = contest.startAt ? new Date(contest.startAt).getFullYear() : "";
    const prefix = [series, year].filter(Boolean).join(" ");
    return prefix ? `${prefix} · ${contest.alias}` : contest.alias;
  };

  function provincialSeriesLabel(value) {
    const names = {
      ah: "安徽省赛",
      bj: "北京市赛",
      cq: "重庆省赛",
      fj: "福建省赛",
      gd: "广东省赛",
      gx: "广西省赛",
      gz: "贵州省赛",
      ha: "河南省赛",
      hb: "湖北省赛",
      he: "河北省赛",
      hl: "黑龙江省赛",
      hn: "湖南省赛",
      jl: "吉林省赛",
      js: "江苏省赛",
      jx: "江西省赛",
      ln: "辽宁省赛",
      nm: "内蒙古省赛",
      northeast: "东北地区赛",
      sc: "四川省赛",
      sd: "山东省赛",
      sh: "上海市赛",
      sn: "陕西省赛",
      xj: "新疆省赛",
      zj: "浙江省赛",
    };
    return names[value] || value.toUpperCase();
  }

  const { unpackPlayerHistory, colorizeRating, escapeHtml, formatDelta, updateUrl } = window.xcpcFrontendUtils;
  unpackPlayerHistory(data);
  const contests = data.contests;
  const contestTimestampByIndex = contests.map((contest) => parseContestStartTimestamp(contest && contest.startAt));
  const initialRating = data.config.initialRating;
  const eloScale = data.config.eloScale;
  const eloUpdateFactor = data.config.eloUpdateFactor;
  const players = data.players.map((player) => {
    const maxRating = computeMaxRating(player);
    const rating = player.history[player.history.length - 1].newRating;
    const lastDelta = player.history[player.history.length - 1].delta;
    const lastCompetedTimestamp = computeLastCompetedTimestamp(player);
    const pinyinInitials = normalizeSearchToken(player.pinyinInitials);
    return {
      pinyinInitials,
      rating,
      maxRating,
      lastDelta,
      lastCompetedTimestamp,
      contests: player.history.length,
      searchText: normalizeSearchToken(`${player.name}-${player.organization}-${pinyinInitials}`),
      ...player,
    };
  });
  const globalRankByCurrent = new Map(
    [...players]
      .sort((a, b) => b.rating - a.rating || topScore(b) - topScore(a) || b.contests - a.contests || a.id.localeCompare(b.id))
      .map((player, index) => [player.id, index + 1]),
  );
  const playerById = new Map(players.map((player) => [player.id, player]));
  const requestedPlayerId = new URLSearchParams(window.location.search).get("player");

  const state = {
    query: "",
    queryTerms: [],
    sortBy: "current",
    lastCompetedSince: "",
    lastCompetedSinceTimestamp: null,
    selectedId:
      requestedPlayerId && playerById.has(requestedPlayerId) ? requestedPlayerId : players.length ? players[0].id : null,
  };

  const subtitle = document.getElementById("subtitle");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const lastCompetedSinceInput = document.getElementById("lastCompetedSinceInput");
  const clearLastCompetedFilterButton = document.getElementById("clearLastCompetedFilterButton");
  const leaderboardBody = document.getElementById("leaderboardBody");
  const leaderboardHint = document.getElementById("leaderboardHint");
  const playerName = document.getElementById("playerName");
  const playerMeta = document.getElementById("playerMeta");
  const ratingChart = document.getElementById("ratingChart");
  const historyBody = document.getElementById("historyBody");
  const historyHint = document.getElementById("historyHint");

  renderSummary();
  renderLeaderboard();
  renderPlayerDetail();

  searchInput.addEventListener("input", () => {
    state.query = normalizeSearchToken(searchInput.value);
    state.queryTerms = splitSearchTerms(state.query);
    renderLeaderboard();
  });

  sortSelect.addEventListener("change", () => {
    state.sortBy = sortSelect.value;
    renderLeaderboard();
  });

  if (lastCompetedSinceInput) {
    lastCompetedSinceInput.addEventListener("change", () => {
      updateLastCompetedFilter(lastCompetedSinceInput.value);
    });
  }

  if (clearLastCompetedFilterButton) {
    clearLastCompetedFilterButton.addEventListener("click", () => {
      if (lastCompetedSinceInput) {
        lastCompetedSinceInput.value = "";
      }
      updateLastCompetedFilter("");
    });
  }

  const colorSchemeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  if (colorSchemeMedia && typeof colorSchemeMedia.addEventListener === "function") {
    colorSchemeMedia.addEventListener("change", () => {
      renderPlayerDetail();
    });
  }

  /**
   * Updates the global subtitle with dataset statistics.
   */
  function renderSummary() {
    subtitle.textContent = `共 ${data.totals.players.toLocaleString()} 名选手，${data.totals.contests.toLocaleString()} 场比赛，生成时间: ${new Date(data.generatedAt).toLocaleString("zh-CN")}，ELO 初始分: ${initialRating}，ELO 缩放系数: ${eloScale}，ELO 更新系数: ${eloUpdateFactor}`;
  }

  /**
   * Applies search and date filters, then returns players in the selected order.
   *
   * @returns {object[]} Filtered and sorted player list.
   */
  function getFilteredPlayers() {
    let filtered = players;
    if (state.queryTerms.length) {
      filtered = players.filter((player) => state.queryTerms.every((term) => player.searchText.includes(term)));
    }
    if (state.lastCompetedSinceTimestamp !== null) {
      filtered = filtered.filter(
        (player) =>
          typeof player.lastCompetedTimestamp === "number" && player.lastCompetedTimestamp >= state.lastCompetedSinceTimestamp,
      );
    }

    const cloned = [...filtered];
    if (state.sortBy === "top") {
      cloned.sort(
        (a, b) => topScore(b) - topScore(a) || b.rating - a.rating || b.contests - a.contests || a.id.localeCompare(b.id),
      );
    } else if (state.sortBy === "contests") {
      cloned.sort(
        (a, b) => b.contests - a.contests || b.rating - a.rating || topScore(b) - topScore(a) || a.id.localeCompare(b.id),
      );
    } else {
      cloned.sort(
        (a, b) => b.rating - a.rating || topScore(b) - topScore(a) || b.contests - a.contests || a.id.localeCompare(b.id),
      );
    }

    return cloned;
  }

  /**
   * Renders the leaderboard and keeps the selected player within the filtered set.
   */
  function renderLeaderboard() {
    const filtered = getFilteredPlayers();
    if (!filtered.length) {
      leaderboardBody.innerHTML = "";
      leaderboardHint.textContent = "没有选手符合当前筛选条件。";
      return;
    }

    if (!state.selectedId || !playerById.has(state.selectedId)) {
      state.selectedId = filtered[0].id;
    } else if (!filtered.some((player) => player.id === state.selectedId)) {
      state.selectedId = filtered[0].id;
    }

    const visible = filtered.slice(0, 500);
    leaderboardBody.innerHTML = visible
      .map((player, visibleIndex) => {
        const deltaClass = player.lastDelta > 0 ? "delta-positive" : player.lastDelta < 0 ? "delta-negative" : "delta-neutral";
        const selected = player.id === state.selectedId ? "active" : "";
        const shownRank = visibleIndex + 1;
        return `
          <tr class="${selected}" data-player-id="${escapeHtml(player.id)}">
            <td class="mono">${shownRank}</td>
            <td>${escapeHtml(player.name || player.id)}</td>
            <td>${escapeHtml(player.organization || "")}</td>
            <td class="mono">${formatRatingColored(player.rating, player.rating)}</td>
            <td class="mono">${formatRatingColored(player.maxRating, formatTopRating(player.maxRating))}</td>
            <td class="${deltaClass} mono">${formatDelta(player.lastDelta || 0)}</td>
            <td class="mono">${player.contests}</td>
          </tr>
        `;
      })
      .join("");

    leaderboardHint.textContent =
      filtered.length > visible.length
        ? `当前显示 ${visible.length.toLocaleString()} / ${filtered.length.toLocaleString()} 条结果。可继续缩小筛选范围。${formatLastCompetedFilterHint()}`
        : `当前显示 ${filtered.length.toLocaleString()} 名选手。${formatLastCompetedFilterHint()}`;

    for (const row of leaderboardBody.querySelectorAll("tr")) {
      row.addEventListener("click", () => {
        state.selectedId = row.getAttribute("data-player-id");
        updateUrl("player", state.selectedId);
        renderLeaderboard();
        renderPlayerDetail();
      });
    }

    renderPlayerDetail();
  }

  /**
   * Renders metadata, rating chart, and history for the selected player.
   */
  function renderPlayerDetail() {
    const player = playerById.get(state.selectedId);
    if (!player) {
      playerName.textContent = "选手详情";
      playerMeta.textContent = "尚未选择选手。";
      clearChart();
      historyBody.innerHTML = "";
      historyHint.textContent = "";
      return;
    }

    const globalRank = globalRankByCurrent.get(player.id);
    playerName.textContent = `${player.organization || "未知组织"} - ${player.name}`;
    playerMeta.innerHTML = `当前排名 #${globalRank} | 当前分 ${formatRatingColored(player.rating, player.rating)} | 历史最高 ${formatRatingColored(
      player.maxRating,
      formatTopRating(player.maxRating),
    )} | 参赛 ${player.contests} 场 | 最后参赛 ${formatDateOnly(player.lastCompetedTimestamp)}`;

    drawChart(player);
    renderHistory(player);
  }

  /**
   * Draws the selected player's rating chart when enough history exists.
   *
   * @param {object} player Player data.
   */
  function drawChart(player) {
    const sequence = buildRatingSequence(player);
    if (sequence.length <= 1) {
      clearChart();
      return;
    }

    if (window.Plotly && typeof window.Plotly.react === "function") {
      drawPlotlyChart(sequence);
      return;
    }

    ratingChart.innerHTML = "<p style='padding:12px;font-size:13px;color:#5f6b71'>图表组件未加载，无法显示评分曲线。</p>";
  }

  /**
   * Builds chart points from a player's rating history.
   *
   * @param {object} player Player data.
   * @returns {object[]} Chart points.
   */
  function buildRatingSequence(player) {
    const sequence = [{ label: "初始分", rating: initialRating, date: null }];
    for (const event of player.history) {
      const contest = event.contest;
      sequence.push({
        label: contestDisplayTitle(contest, event.contestId),
        date: contest && contest.startAt ? contest.startAt : null,
        rating: event.newRating,
        delta: event.delta,
      });
    }
    return sequence;
  }

  /**
   * Renders the rating sequence using Plotly.
   *
   * @param {object[]} sequence Rating chart points.
   */
  function drawPlotlyChart(sequence) {
    const chartTheme = getChartTheme();
    const firstDatedPoint = sequence.find((point) => point.date);
    const firstTimestamp = firstDatedPoint ? Date.parse(firstDatedPoint.date) : Number.NaN;
    const initialDate = Number.isFinite(firstTimestamp) ? new Date(firstTimestamp - 24 * 60 * 60 * 1000).toISOString() : null;
    const x = sequence.map((point, index) => (index === 0 ? initialDate : point.date));
    const y = sequence.map((point) => point.rating);
    const hoverText = sequence.map((point) => {
      const dateText = point.date ? new Date(point.date).toLocaleString("zh-CN") : "";
      const deltaText = typeof point.delta === "number" ? ` | 变化 ${formatDelta(point.delta)}` : "";
      return `${point.label}${dateText ? ` | ${dateText}` : ""}<br>分数 ${point.rating}${deltaText}`;
    });

    window.Plotly.react(
      ratingChart,
      [
        {
          x,
          y,
          type: "scatter",
          mode: "lines+markers",
          line: { color: chartTheme.lineColor, width: 2.5 },
          marker: { color: chartTheme.markerColor, size: 5 },
          text: hoverText,
          hovertemplate: "%{text}<extra></extra>",
        },
      ],
      {
        margin: { l: 42, r: 16, t: 16, b: 28 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        xaxis: {
          type: "date",
          tickformat: "%Y-%m-%d",
          tickmode: "auto",
          color: chartTheme.textColor,
          showgrid: true,
          gridcolor: chartTheme.gridColor,
          zeroline: false,
        },
        yaxis: {
          color: chartTheme.textColor,
          showgrid: true,
          gridcolor: chartTheme.gridColor,
          zeroline: false,
        },
        hovermode: "closest",
        showlegend: false,
      },
      {
        responsive: true,
        displaylogo: false,
        modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"],
      },
    );
  }

  /**
   * Clears Plotly and any remaining chart markup.
   */
  function clearChart() {
    if (window.Plotly && typeof window.Plotly.purge === "function") {
      window.Plotly.purge(ratingChart);
    }
    ratingChart.innerHTML = "";
  }

  /**
   * Renders recent contest history for a player.
   *
   * @param {object} player Player data.
   */
  function renderHistory(player) {
    const history = [...player.history].reverse();
    const visible = history.slice(0, 240);

    historyBody.innerHTML = visible
      .map((event) => {
        const contest = event.contest;
        const delta = event.delta;
        const deltaClass = delta > 0 ? "delta-positive" : delta < 0 ? "delta-negative" : "delta-neutral";
        const dateText = contest && contest.startAt ? new Date(contest.startAt).toLocaleDateString("zh-CN") : "-";
        return `
          <tr>
            <td>${contest ? `<a href="./contests.html?contest=${encodeURIComponent(contest.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contestDisplayTitle(contest, event.contestId))}</a>` : escapeHtml(`比赛 #${event.contestId}`)}</td>
            <td class="mono">${event.rank}</td>
            <td class="mono">${formatRatingColored(event.performanceRating, event.performanceRating)}</td>
            <td class="${deltaClass} mono">${formatDelta(delta)}</td>
            <td class="mono">${formatRatingColored(event.newRating, event.newRating)}</td>
          </tr>
        `;
      })
      .join("");

    historyHint.textContent =
      history.length > visible.length
        ? `仅显示最近 ${visible.length} / ${history.length} 场比赛。`
        : `历史比赛总数：${history.length}。`;
  }

  /**
   * Finds the highest rating reached in a player's history.
   *
   * @param {object} player Player data.
   * @returns {number} Maximum rating.
   */
  function computeMaxRating(player) {
    const history = player.history;
    if (!history || !history.length) {
      throw new Error("empty history");
    }
    let best = Number.NEGATIVE_INFINITY;
    for (const event of history) {
      if (event.newRating > best) {
        best = event.newRating;
      }
    }
    return best;
  }

  /**
   * Finds the latest contest timestamp a player competed in.
   *
   * @param {object} player Player data.
   * @returns {number|null} Latest timestamp, or null without history.
   */
  function computeLastCompetedTimestamp(player) {
    const history = Array.isArray(player && player.history) ? player.history : [];
    let latest = null;
    for (const event of history) {
      const timestamp = contestTimestampByIndex[event.contestId];
      if (typeof timestamp !== "number") {
        throw new Error(`invalid contestId ${event.contestId} timestamp ${timestamp}`);
      }
      if (latest === null || timestamp > latest) {
        latest = timestamp;
      }
    }
    return latest;
  }

  /**
   * Parses an optional contest start timestamp.
   *
   * @param {string} startAt ISO date string.
   * @returns {number|null} Millisecond timestamp, or null.
   */
  function parseContestStartTimestamp(startAt) {
    if (!startAt) {
      return null;
    }
    const timestamp = Date.parse(startAt);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  /**
   * Parses a date input value as a local midnight timestamp.
   *
   * @param {string} value Date input value.
   * @returns {number|null} Millisecond timestamp, or null.
   */
  function parseDateInputToTimestamp(value) {
    if (!value) {
      return null;
    }
    const timestamp = Date.parse(`${value}T00:00:00`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  /**
   * Updates the last-competition filter and rerenders the leaderboard.
   *
   * @param {string} value Date input value.
   */
  function updateLastCompetedFilter(value) {
    state.lastCompetedSince = `${value || ""}`.trim();
    state.lastCompetedSinceTimestamp = parseDateInputToTimestamp(state.lastCompetedSince);
    renderLeaderboard();
  }

  /**
   * Formats active last-competition filter text.
   *
   * @returns {string} Hint suffix, or an empty string when inactive.
   */
  function formatLastCompetedFilterHint() {
    if (!state.lastCompetedSince) {
      return "";
    }
    return ` 最后参赛不早于 ${state.lastCompetedSince}。`;
  }

  /**
   * Returns a comparable top score for sorting.
   *
   * @param {object} player Player data.
   * @returns {number} Maximum rating or negative infinity.
   */
  function topScore(player) {
    return typeof player.maxRating === "number" ? player.maxRating : Number.NEGATIVE_INFINITY;
  }

  /**
   * Reads chart colors from the active CSS theme.
   *
   * @returns {object} Plotly color theme values.
   */
  function getChartTheme() {
    const styles = getComputedStyle(document.documentElement);
    return {
      lineColor: styles.getPropertyValue("--chart-line").trim() || "#129462",
      markerColor: styles.getPropertyValue("--chart-dot").trim() || "#31f3b2",
      gridColor: styles.getPropertyValue("--chart-grid").trim() || "rgba(16, 33, 39, 0.1)",
      textColor: styles.getPropertyValue("--muted").trim() || "#546067",
    };
  }

  /**
   * Normalizes a value for case-insensitive search.
   *
   * @param {*} value Value to normalize.
   * @returns {string} Trimmed lowercased text.
   */
  function normalizeSearchToken(value) {
    return `${value || ""}`.trim().toLowerCase();
  }

  /**
   * Splits a normalized query into whitespace-separated terms.
   *
   * @param {string} value Search query.
   * @returns {string[]} Non-empty search terms.
   */
  function splitSearchTerms(value) {
    if (!value) {
      return [];
    }
    return value.split(/\s+/).filter(Boolean);
  }

  /**
   * Formats a top rating for display.
   *
   * @param {number} value Rating value.
   * @returns {string} Rating text or a dash.
   */
  function formatTopRating(value) {
    return typeof value === "number" ? `${value}` : "-";
  }

  /**
   * Formats rating text with the appropriate rating color.
   *
   * @param {number} rating Numeric rating tier.
   * @param {*} text Display value.
   * @returns {string} Escaped colored rating markup.
   */
  function formatRatingColored(rating, text) {
    if (typeof rating === "number") {
      return colorizeRating(rating, escapeHtml(`${text}`));
    }
    return escapeHtml(`${text}`);
  }

  /**
   * Formats a timestamp as a localized date.
   *
   * @param {number} value Millisecond timestamp.
   * @returns {string} Localized date or unknown text.
   */
  function formatDateOnly(value) {
    if (typeof value !== "number") {
      return "未知";
    }
    return new Date(value).toLocaleDateString("zh-CN");
  }
})();
