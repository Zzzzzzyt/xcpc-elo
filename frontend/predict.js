/**
 * Prediction page: reads a registration CSV and ranks the teams by the
 * aggregate Elo of their members, using the aggregation recorded in the data.
 */
(function () {
  const utils = window.xcpcFrontendUtils || {};
  const core = window.xcpcPredict;
  const data = window.__ELO_DATA__;
  const els = {
    subtitle: document.getElementById("subtitle"),
    input: document.getElementById("csvInput"),
    dropZone: document.getElementById("dropZone"),
    status: document.getElementById("status"),
    stats: document.getElementById("stats"),
    tableBody: document.getElementById("predictionBody"),
    tableHint: document.getElementById("resultHint"),
    download: document.getElementById("downloadButton"),
    lawNote: document.getElementById("lawNote"),
  };

  const calcEls = {
    total: document.getElementById("calcTotal"),
    rank: document.getElementById("calcRank"),
    result: document.getElementById("calcResult"),
    hint: document.getElementById("calcHint"),
  };

  const BUCKET_LABELS = { gold: "金", silver: "银", bronze: "铜", iron: "铁" };
  const AWARD_LABELS = { gold: "金牌", silver: "银牌", bronze: "铜牌", iron: "无奖牌" };

  const config = (data && data.config) || {};
  const initialRating = Number.isFinite(config.initialRating) ? config.initialRating : 1400;
  const scale = Number.isFinite(config.eloScale) ? config.eloScale : 400;
  const aggregation = config.teamRatingAggregation || "log-power-mean";
  const scoreColumn = `predicted_${aggregation.replace(/-/g, "_")}`;
  const law = window.__RANK_LAW__ || null;
  const bucketNames = law ? law.buckets.map(([name]) => name) : [];

  let ratingIndex = new Map();
  let playerByKey = new Map();
  let lastResult = null;

  /**
   * Finds a player's current rating: the last rated contest, as the dashboard does.
   *
   * @param {object} player Player data.
   * @returns {number} Latest rated rating, or the initial rating.
   */
  function currentRating(player) {
    const history = player.history || [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const value = history[index][3];
      if (value !== null && value !== undefined) return value;
    }
    return initialRating;
  }

  /**
   * Indexes every known teammate by organization and name.
   */
  function buildRatingIndex() {
    const players = (data && data.players) || [];
    const index = new Map();
    const byKey = new Map();
    for (const player of players) {
      const key = core.lookupKey(player.organization, player.name);
      index.set(key, currentRating(player));
      byKey.set(key, player);
    }
    ratingIndex = index;
    playerByKey = byKey;
  }

  /**
   * Decodes a file buffer as UTF-8, falling back to GB18030 like the CLI did.
   *
   * @param {ArrayBuffer} buffer File bytes.
   * @returns {{text: string, encoding: string, bom: boolean}} Decoded text.
   */
  function decodeBuffer(buffer) {
    let text = "";
    let encoding = "UTF-8";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      text = new TextDecoder("gb18030").decode(buffer);
      encoding = "GB18030";
    }
    const bom = text.charCodeAt(0) === 0xfeff;
    if (bom) text = text.slice(1);
    return { text, encoding, bom };
  }

  /**
   * Renders one teammate cell, linking the names that matched a rated player and
   * striking through the rest.
   *
   * @param {object} team Predicted team.
   * @returns {string} HTML fragment.
   */
  function teammateCell(team) {
    const escape = utils.escapeHtml || ((value) => `${value}`);
    return team.teammateNames
      .map((name) => {
        const player = playerByKey.get(core.lookupKey(team.organization, name));
        if (!player) return `<span class="unmatched">${escape(name)}</span>`;
        return (
          `<a href="./index.html?player=${encodeURIComponent(player.id)}" target="_blank" rel="noopener noreferrer">` +
          `${escape(player.name || name)}</a>`
        );
      })
      .join("、");
  }

  /**
   * Renders the statistic cards above the table.
   *
   * @param {object[]} predicted Predicted teams.
   * @param {string} encoding Detected encoding label.
   */
  function renderStats(predicted, encoding) {
    const known = predicted.reduce((total, team) => total + team.knownMembers, 0);
    const unknown = predicted.reduce((total, team) => total + team.unknownMembers, 0);
    const escaped = utils.escapeHtml || ((value) => `${value}`);
    els.stats.innerHTML = [
      ["队伍数", predicted.length],
      ["命中队员", known],
      ["未命中队员", unknown],
      ["编码 / 评分方式", `${encoding} · ${escaped(aggregation)}`],
    ]
      .map(
        ([label, value]) =>
          `<div class="statistic-card"><span>${escaped(label)}</span><strong>${escaped(value)}</strong></div>`,
      )
      .join("");
  }

  /**
   * Renders the probability cells of one team.
   *
   * @param {object} team Predicted team.
   * @returns {string} Four table cells.
   */
  function bucketCells(team) {
    return bucketNames
      .map((name, index) => {
        const value = team.bucketPercents ? `${team.bucketPercents[index]}%` : "—";
        return `<td class="bucket bucket-${name}">${value}</td>`;
      })
      .join("");
  }

  /**
   * Renders the predicted ranking table.
   *
   * @param {object[]} predicted Predicted teams.
   */
  function renderTable(predicted) {
    const escape = utils.escapeHtml || ((value) => `${value}`);
    const colorize = utils.colorizeRating || ((rating, value) => value);
    els.tableBody.innerHTML = predicted
      .map(
        (team) => `<tr>
          <td class="rank rank-${core.awardForRank(team.predictedRank, predicted.length)}">${team.predictedRank}</td>
          <td>${escape(team.organization)}</td>
          <td>${teammateCell(team)}</td>
          <td>${team.knownMembers}/${team.teammateNames.length}</td>
          <td class="mono">${colorize(team.ratingScore, Math.round(team.ratingScore))}</td>
          ${bucketCells(team)}
        </tr>`,
      )
      .join("");
  }

  /**
   * Runs the prediction for one decoded CSV file.
   *
   * @param {string} text Decoded CSV text.
   * @param {string} encoding Encoding label for display.
   * @param {string} filename Input file name.
   */
  function predictCsv(text, encoding, filename) {
    const parsed = core.parseCsv(text);
    if (!parsed.headers.length) throw new Error("CSV 没有内容。");

    const columns = core.detectColumns(parsed.headers);
    if (!columns.teammateIndexes.length) {
      throw new Error("没有找到队员列。表头需包含 /teammate|队员|member/i。");
    }
    if (columns.organizationIndex < 0) {
      throw new Error("没有找到学校列。表头需包含 /school|university|学校|院校|organization/i。");
    }

    const teams = core.buildTeams(parsed, columns.teammateIndexes, columns.organizationIndex);
    const predicted = core.predict(teams, ratingIndex, { aggregation, scale, law });

    lastResult = { predicted, headers: parsed.headers, filename };

    const teammateColumns = columns.teammateIndexes.map((index) => parsed.headers[index]).join("、");
    const organizationColumn = parsed.headers[columns.organizationIndex];
    const matched = predicted.filter((team) => team.knownMembers > 0).length;
    const bucketHint = law
      ? ` 金/银/铜/铁 概率按有评分队员的队伍（${matched} 支）的预测分位计算。` +
        (matched < 30 ? " 队伍较少时，百分位分档较粗，概率仅供参考。" : "")
      : " 未找到分布参数（analysis/law.json），概率列留空。";

    renderStats(predicted, encoding);
    renderTable(predicted);
    els.download.disabled = false;
    els.status.textContent = `已解析 ${predicted.length} 支队伍。`;
    els.tableHint.textContent =
      `学校列: ${organizationColumn}; 队员列: ${teammateColumns}; ` +
      `至少命中一名队员的队伍: ${matched}/${predicted.length}。` +
      `评分按 ${aggregation} 聚合，与 Elo 计算一致。${bucketHint}`;
  }

  /**
   * Handles a selected or dropped file.
   *
   * @param {File} file Uploaded file.
   */
  async function handleFile(file) {
    if (!file) return;
    els.status.textContent = "正在读取文件...";
    els.tableHint.textContent = "";
    try {
      const buffer = await file.arrayBuffer();
      const { text, encoding } = decodeBuffer(buffer);
      predictCsv(text, encoding, file.name);
    } catch (error) {
      lastResult = null;
      els.download.disabled = true;
      els.stats.innerHTML = "";
      els.tableBody.innerHTML = "";
      els.status.textContent = `无法处理该文件: ${error.message || error}`;
    }
  }

  /**
   * Downloads the predicted CSV, encoded as UTF-8 with a BOM.
   */
  function downloadCsv() {
    if (!lastResult) return;
    const output = core.buildOutput(lastResult.predicted, lastResult.headers, scoreColumn, Boolean(law));
    const text = `\uFEFF${core.serializeCsv(output.headers, output.rows)}\n`;
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${lastResult.filename.replace(/\.csv$/i, "")}.predicted.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  /**
   * Renders the standalone calculator from the field size and predicted rank.
   */
  function renderCalculator() {
    if (!calcEls.result) return;
    const total = Number.parseInt(calcEls.total ? calcEls.total.value : "", 10);
    const rank = Number.parseInt(calcEls.rank ? calcEls.rank.value : "", 10);

    if (!Number.isFinite(total) || !Number.isFinite(rank) || total < 2 || rank < 1) {
      calcEls.result.innerHTML = "";
      return;
    }
    if (!law) {
      calcEls.result.innerHTML = "";
      return;
    }

    const effectiveRank = Math.min(rank, total);
    const percentile = (effectiveRank - 0.5) / total;
    const buckets = core.bucketProbabilities(percentile, law);
    const percents = core.percentBuckets(buckets);

    calcEls.result.innerHTML = buckets
      .map(
        (bucket, index) =>
          `<div class="statistic-card bucket-${bucket.name}">` +
          `<span>${BUCKET_LABELS[bucket.name] || bucket.name}</span><strong>${percents[index]}%</strong></div>`,
      )
      .join("");

    const award = core.awardForRank(effectiveRank, total);
    const overflow = rank > total ? " 名次超过队伍总数，按最后一名计算。" : "";
  }

  /**
   * Wires file selection, drag and drop, and the download button.
   */
  function bindEvents() {
    els.input.addEventListener("change", () => handleFile(els.input.files && els.input.files[0]));
    els.dropZone.addEventListener("click", () => els.input.click());
    for (const type of ["dragenter", "dragover"]) {
      els.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        els.dropZone.classList.add("is-active");
      });
    }
    for (const type of ["dragleave", "drop"]) {
      els.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        els.dropZone.classList.remove("is-active");
      });
    }
    els.dropZone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      handleFile(file);
    });
    els.download.addEventListener("click", downloadCsv);
    for (const input of [calcEls.total, calcEls.rank]) {
      if (input) input.addEventListener("input", renderCalculator);
    }
  }

  /**
   * Renders the model formula and coefficients in the page footer.
   */
  function renderLawNote() {
    if (!els.lawNote) return;
    if (!law) {
      els.lawNote.textContent =
        "概率模型不可用：缺少 analysis/law.json。名次颜色仍按 ICPC 奖牌规则（名额向上取整）计算。";
      return;
    }
    const { a, b, c } = law.params;
    const scale = Math.exp(law.params.logScale);
    const nu = Math.exp(law.params.logNu);
    const trained = law.trained || {};
    const appearances = Number.isFinite(trained.appearances) ? trained.appearances.toLocaleString() : "—";
    const sign = c < 0 ? "−" : "+";
    els.lawNote.innerHTML =
      `概率模型：设预测分位为 p、真实分位为 q，则 logit(q) = ${a.toFixed(4)} + ${b.toFixed(4)}·logit(p) ` +
      `${sign} ${Math.abs(c).toFixed(4)}·logit(p)² + ${scale.toFixed(4)}·t(ν)，其中 t(ν) 为自由度 ν = ${nu.toFixed(2)} 的 Student-t 分布。<br />` +
      `金 / 银 / 铜 / 铁 = P(q ≤ 10%) / P(10% &lt; q ≤ 30%) / P(30% &lt; q ≤ 60%) / P(60% &lt; q ≤ 100%)；` +
      `名次颜色按 ICPC 奖牌规则取 ceil(10% / 30% / 60% × 队伍数)。<br />` +
      `拟合数据：${law.model}，${trained.contests ?? "—"} 场 ${trained.population || "—"}、` +
      `${appearances} 个队伍出场，${law.basis || "rated"} 名次基准，${law.aggregation || "—"} 聚合。`;
  }

  /**
   * Initializes the page.
   */
  function init() {
    if (!core) {
      els.status.textContent = "预测模块加载失败。";
      return;
    }
    if (!data) {
      els.subtitle.textContent = "数据加载失败，请先运行 npm run step:4:build-frontend。";
      return;
    }
    buildRatingIndex();
    renderLawNote();
    renderCalculator();
    els.subtitle.textContent =
      `已载入 ${ratingIndex.size} 名队员的 Elo 数据; 初始分: ${initialRating}, 缩放系数: ${scale}, ` +
      `评分方式: ${aggregation}` +
      (law ? `; 概率模型: ${law.model}` : "");
    bindEvents();
  }

  init();
})();
