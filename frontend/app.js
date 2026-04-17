(function bootstrap() {
  const data = window.__ELO_DATA__;
  if (!data || !Array.isArray(data.players) || !Array.isArray(data.contests)) {
    document.body.innerHTML = "<p style='padding:16px;font-family:sans-serif'>Elo data not found. Run: npm run build:elo-dashboard</p>";
    return;
  }

  const contests = data.contests;
  const contestTimestampByIndex = contests.map((contest) => parseContestStartTimestamp(contest && contest.startAt));
  const initialRating = data.config && typeof data.config.initialRating === "number" ? data.config.initialRating : 1500;
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
      .sort(
        (a, b) =>
          b.rating - a.rating ||
          topScore(b) - topScore(a) ||
          b.contests - a.contests ||
          a.id.localeCompare(b.id)
      )
      .map((player, index) => [player.id, index + 1])
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
    subtitle.textContent = `${data.totals.players.toLocaleString()} teammates, ${data.totals.contests.toLocaleString()} contests, rank rule = row index in rows`;
    const topHistorical = players.reduce(
      (best, player) => (topScore(player) > best ? topScore(player) : best),
      Number.NEGATIVE_INFINITY
    );
    const cards = [
      { key: "Generated At", value: new Date(data.generatedAt).toLocaleString() },
      { key: "Contests", value: data.totals.contests.toLocaleString() },
      { key: "Teammates", value: data.totals.players.toLocaleString() },
      { key: "Global Top Rating", value: Number.isFinite(topHistorical) ? `${topHistorical}` : "-" },
    ];
    summaryCards.innerHTML = cards
      .map(
        (card) => `
          <article class="panel card">
            <div class="card-key">${escapeHtml(card.key)}</div>
            <div class="card-value">${escapeHtml(card.value)}</div>
          </article>
        `
      )
      .join("");
  }

  function getFilteredPlayers() {
    let filtered = players;
    if (state.query) {
      filtered = players.filter((player) => player.searchText.includes(state.query));
    }
    if (state.lastCompetedSinceTimestamp !== null) {
      filtered = filtered.filter(
        (player) =>
          typeof player.lastCompetedTimestamp === "number" &&
          player.lastCompetedTimestamp >= state.lastCompetedSinceTimestamp
      );
    }

    const cloned = [...filtered];
    if (state.sortBy === "top") {
      cloned.sort(
        (a, b) =>
          topScore(b) - topScore(a) ||
          b.rating - a.rating ||
          b.contests - a.contests ||
          a.id.localeCompare(b.id)
      );
    } else if (state.sortBy === "contests") {
      cloned.sort(
        (a, b) =>
          b.contests - a.contests ||
          b.rating - a.rating ||
          topScore(b) - topScore(a) ||
          a.id.localeCompare(b.id)
      );
    } else {
      cloned.sort(
        (a, b) =>
          b.rating - a.rating ||
          topScore(b) - topScore(a) ||
          b.contests - a.contests ||
          a.id.localeCompare(b.id)
      );
    }

    return cloned;
  }

  function renderLeaderboard() {
    const filtered = getFilteredPlayers();
    if (!filtered.length) {
      leaderboardBody.innerHTML = "";
      leaderboardHint.textContent = "No players match this filter.";
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
            <td title="${escapeHtml(player.organization)}">${escapeHtml(trimText(player.organization, 26))}</td>
            <td class="mono">${player.rating}</td>
            <td class="mono">${formatTopRating(player.historicalTopRating)}</td>
            <td class="${deltaClass} mono">${formatDelta(player.lastDelta || 0)}</td>
            <td class="mono">${player.contests}</td>
          </tr>
        `;
      })
      .join("");

    leaderboardHint.textContent =
      filtered.length > visible.length
        ? `Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()} matches. Refine search to narrow down.${formatLastCompetedFilterHint()}`
        : `Showing ${filtered.length.toLocaleString()} players.${formatLastCompetedFilterHint()}`;

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
      playerName.textContent = "Player Details";
      playerMeta.textContent = "No player selected.";
      clearChart();
      historyBody.innerHTML = "";
      historyHint.textContent = "";
      return;
    }

    const globalRank = globalRankByCurrent.get(player.id);
    playerName.textContent = `${player.teamMember} (#${globalRank} by current rating)`;
    playerMeta.textContent = `${player.organization || "Unknown org"} | current ${player.rating} | historical top ${formatTopRating(
      player.historicalTopRating
    )} (excluding initial ${initialRating}) | contests ${player.contests} | last competed ${formatDateOnly(player.lastCompetedTimestamp)}`;

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

    drawSvgFallback(sequence);
  }

  function buildRatingSequence(player) {
    const sequence = [{ label: "Initial", rating: initialRating }];
    for (const event of player.history) {
      const contest = contests[event[0]] || null;
      sequence.push({
        label: contest && contest.title ? contest.title : `contest #${event[0]}`,
        date: contest && contest.startAt ? contest.startAt : null,
        rating: event[3],
        delta: event[2],
      });
    }
    return sequence;
  }

  function drawPlotlyChart(sequence) {
    const x = sequence.map((_, index) => index);
    const y = sequence.map((point) => point.rating);
    const hoverText = sequence.map((point) => {
      const dateText = point.date ? new Date(point.date).toLocaleString() : "";
      const deltaText = typeof point.delta === "number" ? ` | delta ${formatDelta(point.delta)}` : "";
      return `${point.label}${dateText ? ` | ${dateText}` : ""}<br>rating ${point.rating}${deltaText}`;
    });

    window.Plotly.react(
      ratingChart,
      [
        {
          x,
          y,
          type: "scatter",
          mode: "lines+markers",
          line: { color: "#007f73", width: 2.5 },
          marker: { color: "#db7a0d", size: 5 },
          text: hoverText,
          hovertemplate: "%{text}<extra></extra>",
        },
      ],
      {
        margin: { l: 42, r: 16, t: 16, b: 28 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        xaxis: {
          title: "Contest sequence",
          tickmode: "auto",
          showgrid: true,
          gridcolor: "rgba(16, 33, 39, 0.1)",
          zeroline: false,
        },
        yaxis: {
          title: "Rating",
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
      }
    );
  }

  function drawSvgFallback(sequence) {
    if (window.Plotly && typeof window.Plotly.purge === "function") {
      window.Plotly.purge(ratingChart);
    }

    const width = 860;
    const height = 260;
    const padding = { top: 20, right: 20, bottom: 24, left: 36 };
    const contentWidth = width - padding.left - padding.right;
    const contentHeight = height - padding.top - padding.bottom;

    let minRating = Number.POSITIVE_INFINITY;
    let maxRating = Number.NEGATIVE_INFINITY;
    for (const point of sequence) {
      minRating = Math.min(minRating, point.rating);
      maxRating = Math.max(maxRating, point.rating);
    }
    if (minRating === maxRating) {
      minRating -= 50;
      maxRating += 50;
    }
    const pad = Math.max(40, Math.floor((maxRating - minRating) * 0.08));
    minRating -= pad;
    maxRating += pad;

    const points = sequence.map((point, index) => {
      const x = padding.left + (index / (sequence.length - 1)) * contentWidth;
      const y = padding.top + ((maxRating - point.rating) / (maxRating - minRating)) * contentHeight;
      return { ...point, x, y };
    });

    const gridValues = [0, 0.5, 1].map((k) => Math.round(maxRating - (maxRating - minRating) * k));
    const gridLines = gridValues
      .map((value) => {
        const y = padding.top + ((maxRating - value) / (maxRating - minRating)) * contentHeight;
        return `<line class="chart-grid" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line>
          <text x="8" y="${y + 4}" fill="#5f6b71" font-size="11" font-family="monospace">${value}</text>`;
      })
      .join("");

    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const dots = points
      .map(
        (point) =>
          `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3.1">
              <title>${escapeHtml(`${point.label}: ${point.rating}${point.delta ? ` (${formatDelta(point.delta)})` : ""}`)}</title>
            </circle>`
      )
      .join("");

    ratingChart.innerHTML = `
      <svg viewBox="0 0 860 260" preserveAspectRatio="none">
        <g>
          ${gridLines}
          <polyline class="chart-line" points="${polyline}"></polyline>
          ${dots}
        </g>
      </svg>
    `;
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
        const dateText = contest && contest.startAt ? new Date(contest.startAt).toLocaleDateString() : "-";
        return `
          <tr>
            <td title="${escapeHtml(contest && contest.title ? contest.title : `contest #${event[0]}`)}">${escapeHtml(
          trimText(contest && contest.title ? contest.title : `contest #${event[0]}`, 34)
        )}</td>
            <td class="mono">${escapeHtml(dateText)}</td>
            <td class="mono">${event[1]}</td>
            <td class="${deltaClass} mono">${formatDelta(delta)}</td>
            <td class="mono">${event[3]}</td>
          </tr>
        `;
      })
      .join("");

    historyHint.textContent =
      history.length > visible.length
        ? `Showing latest ${visible.length} of ${history.length} contests.`
        : `Total contests in history: ${history.length}.`;
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
    return ` Last competed no earlier than ${state.lastCompetedSince}.`;
  }

  function topScore(player) {
    return typeof player.historicalTopRating === "number" ? player.historicalTopRating : Number.NEGATIVE_INFINITY;
  }

  function formatDelta(delta) {
    return delta > 0 ? `+${delta}` : `${delta}`;
  }

  function trimText(value, maxLength) {
    const s = value || "";
    return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
  }

  function formatTopRating(value) {
    return typeof value === "number" ? `${value}` : "-";
  }

  function formatDateOnly(value) {
    if (typeof value !== "number") {
      return "unknown";
    }
    return new Date(value).toLocaleDateString();
  }

  function escapeHtml(value) {
    return `${value || ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
