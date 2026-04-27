(function bootstrap() {
  const data = window.__ELO_DATA__;
  if (!data || !Array.isArray(data.players) || !Array.isArray(data.contests)) {
    document.body.innerHTML =
      "<p style='padding:16px;font-family:sans-serif'>未找到 Elo 数据，请先运行：npm run build:elo-dashboard</p>";
    return;
  }

  const contests = data.contests;
  const contestTimestampByIndex = contests.map((contest) => parseContestStartTimestamp(contest && contest.startAt));
  const initialRating = data.config && typeof data.config.initialRating === "number" ? data.config.initialRating : 1500;
  const eloScale = data.config && typeof data.config.eloScale === "number" ? data.config.eloScale : 800;
  const players = data.players.map((player) => {
    const historicalTopRating = computeHistoricalTopRating(player);
    const lastCompetedTimestamp = computeLastCompetedTimestamp(player);
    return {
      ...player,
      historicalTopRating,
      lastCompetedTimestamp,
      searchText: `${player.teamMember} ${player.organization} ${player.id}`.toLowerCase(),
    };
  });
  const globalRankByCurrent = new Map(
    [...players]
      .sort((a, b) => b.rating - a.rating || topScore(b) - topScore(a) || b.contests - a.contests || a.id.localeCompare(b.id))
      .map((player, index) => [player.id, index + 1]),
  );
  const playerById = new Map(players.map((player) => [player.id, player]));

  const state = {
    query: "",
    sortBy: "current",
    lastCompetedSince: "",
    lastCompetedSinceTimestamp: null,
    selectedId: players.length ? players[0].id : null,
  };

  const summaryCards = document.getElementById("summaryCards");
  const subtitle = document.getElementById("subtitle");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const lastCompetedSinceInput = document.getElementById("lastCompetedSinceInput");
  const clearLastCompetedFilterButton = document.getElementById("clearLastCompetedFilterButton");
  const leaderboardBody = document.getElementById("leaderboardBody");
  const leaderboardHint = document.getElementById("leaderboardHint");
  const playerName = document.getElementById("playerName");
  const playerOrganization = document.getElementById("playerOrganization");
  const playerMeta = document.getElementById("playerMeta");
  const ratingChart = document.getElementById("ratingChart");
  const historyBody = document.getElementById("historyBody");
  const historyHint = document.getElementById("historyHint");

  renderSummary();
  renderLeaderboard();
  renderPlayerDetail();

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value.trim().toLowerCase();
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

  function renderSummary() {
    subtitle.textContent = `共 ${data.totals.players.toLocaleString()} 名选手，${data.totals.contests.toLocaleString()} 场比赛, 生成时间: ${new Date(data.generatedAt).toLocaleString("zh-CN")}，ELO 初始分: ${initialRating}，ELO 缩放系数: ${eloScale}`;
    const topHistorical = players.reduce(
      (best, player) => (topScore(player) > best ? topScore(player) : best),
      Number.NEGATIVE_INFINITY,
    );
  }

  function getFilteredPlayers() {
    let filtered = players;
    if (state.query) {
      filtered = players.filter((player) => player.searchText.includes(state.query));
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
            <td>${escapeHtml(player.teamMember || player.id)}</td>
            <td>${escapeHtml(player.organization || "")}</td>
            <td class="mono">${formatRatingColored(player.rating, player.rating)}</td>
            <td class="mono">${formatRatingColored(player.historicalTopRating, formatTopRating(player.historicalTopRating))}</td>
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
        renderLeaderboard();
        renderPlayerDetail();
      });
    }

    renderPlayerDetail();
  }

  function renderPlayerDetail() {
    const player = playerById.get(state.selectedId);
    if (!player) {
      playerName.textContent = "选手详情";
      playerOrganization.textContent = "";
      playerMeta.textContent = "尚未选择选手。";
      clearChart();
      historyBody.innerHTML = "";
      historyHint.textContent = "";
      return;
    }

    const globalRank = globalRankByCurrent.get(player.id);
    playerName.textContent = `${player.teamMember}`;
    playerOrganization.textContent = `${player.organization || "未知学校"}`;
    playerMeta.innerHTML = `当前排名 #${globalRank} | 当前分 ${formatRatingColored(player.rating, player.rating)} | 历史最高 ${formatRatingColored(
      player.historicalTopRating,
      formatTopRating(player.historicalTopRating),
    )} | 参赛 ${player.contests} 场 | 最后参赛 ${formatDateOnly(player.lastCompetedTimestamp)}`;

    drawChart(player);
    renderHistory(player);
  }

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

  function buildRatingSequence(player) {
    const sequence = [{ label: "初始分", rating: initialRating, date: null }];
    for (const event of player.history) {
      const contest = contests[event[0]] || null;
      sequence.push({
        label: contest && contest.title ? contest.title : `比赛 #${event[0]}`,
        date: contest && contest.startAt ? contest.startAt : null,
        rating: event[3],
        delta: event[2],
      });
    }
    return sequence;
  }

  function drawPlotlyChart(sequence) {
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
          line: { color: "#31f3b2", width: 2.5 },
          marker: { color: "#129462", size: 5 },
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
          showgrid: true,
          gridcolor: "rgba(16, 33, 39, 0.1)",
          zeroline: false,
        },
        yaxis: {
          showgrid: true,
          gridcolor: "rgba(16, 33, 39, 0.1)",
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

  function clearChart() {
    if (window.Plotly && typeof window.Plotly.purge === "function") {
      window.Plotly.purge(ratingChart);
    }
    ratingChart.innerHTML = "";
  }

  function renderHistory(player) {
    const history = [...player.history].reverse();
    const visible = history.slice(0, 240);

    historyBody.innerHTML = visible
      .map((event) => {
        const contest = contests[event[0]] || null;
        const delta = event[2];
        const deltaClass = delta > 0 ? "delta-positive" : delta < 0 ? "delta-negative" : "delta-neutral";
        const dateText = contest && contest.startAt ? new Date(contest.startAt).toLocaleDateString("zh-CN") : "-";
        return `
          <tr>
            <td>${escapeHtml(contest && contest.title ? contest.title : `比赛 #${event[0]}`)}</td>
            <td class="mono">${escapeHtml(dateText)}</td>
            <td class="mono">${event[1]}</td>
            <td class="${deltaClass} mono">${formatDelta(delta)}</td>
            <td class="mono">${formatRatingColored(event[3], event[3])}</td>
          </tr>
        `;
      })
      .join("");

    historyHint.textContent =
      history.length > visible.length
        ? `仅显示最近 ${visible.length} / ${history.length} 场比赛。`
        : `历史比赛总数：${history.length}。`;
  }

  function computeHistoricalTopRating(player) {
    const history = Array.isArray(player && player.history) ? player.history : [];
    if (!history.length) {
      return null;
    }
    let best = Number.NEGATIVE_INFINITY;
    for (const event of history) {
      if (Array.isArray(event) && typeof event[3] === "number" && event[3] > best) {
        best = event[3];
      }
    }
    if (!Number.isFinite(best)) {
      return null;
    }
    return best;
  }

  function computeLastCompetedTimestamp(player) {
    const history = Array.isArray(player && player.history) ? player.history : [];
    let latest = null;
    for (const event of history) {
      if (!Array.isArray(event) || typeof event[0] !== "number") {
        continue;
      }
      const timestamp = contestTimestampByIndex[event[0]];
      if (typeof timestamp !== "number") {
        continue;
      }
      if (latest === null || timestamp > latest) {
        latest = timestamp;
      }
    }
    return latest;
  }

  function parseContestStartTimestamp(startAt) {
    if (!startAt) {
      return null;
    }
    const timestamp = Date.parse(startAt);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function parseDateInputToTimestamp(value) {
    if (!value) {
      return null;
    }
    const timestamp = Date.parse(`${value}T00:00:00`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function updateLastCompetedFilter(value) {
    state.lastCompetedSince = `${value || ""}`.trim();
    state.lastCompetedSinceTimestamp = parseDateInputToTimestamp(state.lastCompetedSince);
    renderLeaderboard();
  }

  function formatLastCompetedFilterHint() {
    if (!state.lastCompetedSince) {
      return "";
    }
    return ` 最后参赛不早于 ${state.lastCompetedSince}。`;
  }

  function topScore(player) {
    return typeof player.historicalTopRating === "number" ? player.historicalTopRating : Number.NEGATIVE_INFINITY;
  }

  function formatDelta(delta) {
    return delta > 0 ? `+${delta}` : `${delta}`;
  }

  function formatTopRating(value) {
    return typeof value === "number" ? `${value}` : "-";
  }

  function formatRatingColored(rating, text) {
    if (typeof rating === "number") {
      return colorizeValue(rating, escapeHtml(`${text}`));
    }
    return escapeHtml(`${text}`);
  }

  function formatDateOnly(value) {
    if (typeof value !== "number") {
      return "未知";
    }
    return new Date(value).toLocaleDateString("zh-CN");
  }

  function escapeHtml(value) {
    return `${value || ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function colorizeValue(rating, value) {
    if (rating < 1200) return `<span style="color: gray">${value}</span>`;
    if (rating < 1400) return `<span style="color: green">${value}</span>`;
    if (rating < 1600) return `<span style="color: #03A89E">${value}</span>`;
    if (rating < 1900) return `<span style="color: blue">${value}</span>`;
    if (rating < 2100) return `<span style="color: #a0a">${value}</span>`;
    if (rating < 2300) return `<span style="color: #FF8C00">${value}</span>`;
    if (rating < 2400) return `<span style="color: red">${value}</span>`;
    if (rating < 2600) return `<span style="color: red">${value}</span>`;
    if (rating < 3000) return `<span style="color: red">${value}</span>`;
    return `<span style="color:black">${value[0]}</span><span style="color: red">${value.slice(1)}</span>`;
  }
})();
