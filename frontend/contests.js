(function bootstrapContests() {
  const data = window.__ELO_DATA__;
  if (!data || !Array.isArray(data.players) || !Array.isArray(data.contests)) {
    document.body.innerHTML =
      "<p style='padding:16px;font-family:sans-serif'>未找到 Elo 数据，请先运行：npm run build:elo-dashboard</p>";
    return;
  }

  const select = document.getElementById("contestSelect");
  const seriesSelect = document.getElementById("seriesSelect");
  const yearSelect = document.getElementById("yearSelect");
  const title = document.getElementById("contestTitle");
  const meta = document.getElementById("contestMeta");
  const statistics = document.getElementById("contestStatistics");
  const body = document.getElementById("contestParticipantsBody");
  const hint = document.getElementById("contestHint");
  document.getElementById("subtitle").textContent = `共 ${data.contests.length.toLocaleString()} 场比赛`;

  const filterableContests = data.contests.map((contest, index) => ({
    contest,
    index,
    series: contestSeries(contest.sourcePath),
    year: contest.startAt ? `${new Date(contest.startAt).getFullYear()}` : "",
  }));
  const requestedContestKey = new URLSearchParams(window.location.search).get("contest");
  let applyRequestedContest = true;
  const series = [...new Set(filterableContests.map((item) => item.series).filter(Boolean))].sort();
  const years = [...new Set(filterableContests.map((item) => item.year).filter(Boolean))].sort((a, b) => b - a);
  series.forEach((value) => addOption(seriesSelect, value, seriesLabel(value)));
  years.forEach((value) => addOption(yearSelect, value, value));
  const requestedContest = requestedContestKey
    ? filterableContests.find((item) => item.contest.key === requestedContestKey)
    : null;
  if (requestedContest) {
    seriesSelect.value = requestedContest.series;
    yearSelect.value = requestedContest.year;
  }
  seriesSelect.addEventListener("change", refreshContestOptions);
  yearSelect.addEventListener("change", refreshContestOptions);
  select.addEventListener("change", () => {
    render();
    const contest = data.contests[Number(select.value)];
    if (contest && contest.key) updateUrl("contest", contest.key);
  });
  refreshContestOptions();

  function refreshContestOptions() {
    const previous = select.value;
    const matches = filterableContests.filter(
      (item) =>
        (!seriesSelect.value || item.series === seriesSelect.value) && (!yearSelect.value || item.year === yearSelect.value),
    );
    select.innerHTML = "";
    matches.forEach(({ contest, index }) =>
      addOption(
        select,
        `${index}`,
        `${contest.title || `比赛 #${index}`} ${contest.startAt ? `· ${new Date(contest.startAt).toLocaleDateString("zh-CN")}` : ""}`,
      ),
    );
    const requested = applyRequestedContest && requestedContestKey
      ? matches.find((item) => item.contest.key === requestedContestKey)
      : null;
    if (requested) {
      select.value = `${requested.index}`;
      applyRequestedContest = false;
    } else if (matches.some((item) => `${item.index}` === previous)) select.value = previous;
    else if (matches.length) select.value = `${matches[matches.length - 1].index}`;
    select.disabled = !matches.length;
    const selectedContest = data.contests[Number(select.value)];
    if (selectedContest && selectedContest.key) updateUrl("contest", selectedContest.key);
    render();
  }

  function render() {
    if (!select.value) {
      title.textContent = "没有符合筛选条件的比赛";
      meta.textContent = "请调整比赛系列或年份。";
      statistics.innerHTML = "";
      body.innerHTML = "";
      hint.textContent = "";
      return;
    }
    const index = Number(select.value);
    const contest = data.contests[index] || {};
    const participants = [];
    data.players.forEach((player) =>
      (player.history || []).forEach((event) => {
        if (event[0] === index)
          participants.push({
            player,
            rank: event[1],
            delta: event[2],
            newRating: event[3],
            performance: event[4],
            seed: event[5],
          });
      }),
    );
    participants.sort((a, b) => (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER));
    title.textContent = contest.title || `比赛 #${index}`;
    meta.textContent = `${contest.startAt ? new Date(contest.startAt).toLocaleString("zh-CN") : "日期未知"} · ${participants.length} 名参赛选手`;
    const d = contest.statistics || {};
    statistics.innerHTML = [
      ["首次参赛", d.firstTimeParticipantCount],
      ["Delta 合计", signed(d.sumDeltaFinal)],
      ["Delta 调整", d.adjustment1],
      ["Top 调整", Number.isFinite(d.topCount) ? `${d.topCount}（${signed(d.adjustment2)}）` : "-"],
    ]
      .map(
        ([label, value]) =>
          `<div class="statistic-card"><span>${label}</span><strong>${Number.isFinite(value) ? value.toLocaleString() : (value ?? "-")}</strong></div>`,
      )
      .join("");
    body.innerHTML = participants
      .map(({ player, rank, delta, newRating, performance, neededRating, seed }) => {
        const before = Number.isFinite(newRating) && Number.isFinite(delta) ? newRating - delta : null;
        const deltaClass = delta > 0 ? "delta-positive" : delta < 0 ? "delta-negative" : "delta-neutral";
        return `<tr>
          <td class="mono">${rank}</td>
          <td class="mono">${seed}</td>
          <td><a href="./index.html?player=${encodeURIComponent(player.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(player.name || player.id)}</a></td>
          <td>${escapeHtml(player.organization || "")}</td>
          <td class="mono">${colorizeRating(before, before)}</td>
          <td class="mono">${colorizeRating(performance, performance)}</td>
          <td class="mono ${deltaClass}">${signed(delta)}</td>
          <td class="mono">${colorizeRating(newRating, newRating)}</td>
        </tr>`;
      })
      .join("");
    hint.textContent = participants.length ? `按比赛名次排序，共 ${participants.length} 名选手。` : "暂无参赛记录。";
  }

  function addOption(element, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    element.appendChild(option);
  }

  function updateUrl(parameter, value) {
    const url = new URL(window.location.href);
    url.searchParams.set(parameter, value);
    window.history.replaceState(null, "", url);
  }

  function contestSeries(sourcePath) {
    const parts = `${sourcePath || ""}`.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts[0] === "icpc" || parts[0] === "ccpc") return parts[0];
    if (parts[0] === "provincial" && parts[1]) return `provincial-${parts[1]}`;
    return "";
  }

  function seriesLabel(value) {
    if (value === "icpc") return "ICPC";
    if (value === "ccpc") return "CCPC";
    if (!value.startsWith("provincial-")) return value;
    const provinceId = value.slice("provincial-".length);
    const provinceNames = {
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
    return `${provinceNames[provinceId] || provinceId.toUpperCase()}`;
  }

  function signed(value) {
    return Number.isFinite(value) ? (value > 0 ? `+${value}` : `${value}`) : `${value}`;
  }
  function colorizeRating(rating, value) {
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
