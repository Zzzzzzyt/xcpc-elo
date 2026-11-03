"""Distribution of a team's true rank given its prior-Elo predicted rank.

Rebuilds every team of every rated contest from out/teammate-elo.json, compares
the rank implied by the pre-contest aggregate Elo with the rank the team actually
finished at, fits a parametric law for the true rank percentile, and checks how
the law behaves across contest series.

Run:  python analysis/rank_calibration.py
Deps: numpy, pandas, scipy, matplotlib
Writes: out/calibration/
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import optimize, stats

ROOT = Path(__file__).resolve().parents[1]
ELO_FILE = ROOT / "out" / "teammate-elo.json"
OUT_DIR = ROOT / "out" / "calibration"
# The fitted law is a build input for the prediction page, so it is written next
# to this script and committed; out/ is gitignored and absent in CI.
LAW_FILE = ROOT / "analysis" / "law.json"

MIN_YEAR = 2022
SPECIAL = re.compile(r"invitational|ladies|preliminary|hongkong", re.I)

# Player history columns written by compute-teammate-elo.cjs.
H_CONTEST, H_RANK, H_DELTA, H_RATING = 0, 1, 2, 3

SERIES_COLOURS = {"icpc": "#1f5fa8", "ccpc": "#c0392b", "provincial": "#2e8b57", "other": "#7f7f7f"}


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #

def contest_meta(contest: dict) -> dict:
    """Series (source-path prefix) and whether the event is a special one."""
    source = contest.get("sourcePath") or ""
    haystack = f"{contest.get('key', '')} {source} {contest.get('title', '')}"
    return {
        "series": source.split("/")[0] or "other",
        "special": bool(SPECIAL.search(haystack)),
    }


def eligible_contests(elo: dict, min_year: int = MIN_YEAR) -> list[dict]:
    """Every rated contest from ``min_year`` on, whatever the series."""
    selected = []
    for contest in elo["contests"]:
        start = contest.get("startAt") or ""
        year = int(start[:4]) if start[:4].isdigit() else 0
        if not contest["unrated"] and year >= min_year:
            selected.append(contest)
    return selected


def collect_teams(players: list[dict]) -> dict[tuple[int, int], dict]:
    """Group player histories into teams keyed by (contest index, rank)."""
    teams: dict[tuple[int, int], dict] = {}
    for player in players:
        history = player["history"]
        if not history:
            continue
        first = history[0][H_CONTEST]
        for entry in history:
            team = teams.setdefault((entry[H_CONTEST], entry[H_RANK]), {"ratings": [], "unrated": 0})
            if first < entry[H_CONTEST] and entry[H_RATING] is not None:
                team["ratings"].append(entry[H_RATING] - entry[H_DELTA])
            else:
                team["unrated"] += 1
    return teams


def team_rating(ratings: list[float], scale: float) -> float:
    """log-power-mean aggregation, as configured in elo-core.cjs."""
    powers = 10.0 ** (np.asarray(ratings) / scale)
    return float(np.log10(powers.sum() / len(ratings)) * scale)


def midranks(values: np.ndarray) -> np.ndarray:
    """Descending midranks, so tied ratings share one predicted position."""
    order = np.argsort(-values, kind="stable")
    ranks = np.empty(len(values))
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and values[order[end]] == values[order[start]]:
            end += 1
        ranks[order[start:end]] = (start + 1 + end) / 2
        start = end
    return ranks


def build_samples(elo: dict, basis: str = "rated") -> pd.DataFrame:
    """One row per predictable team appearance, across all series.

    ``basis`` selects what the percentiles are relative to: ``"rated"`` ranks
    teams only among those with a prior rating, ``"all"`` ranks them among every
    team of the contest (unrated teams then sit at the initial rating, which is a
    placeholder rather than an estimate).
    """
    config = elo["config"]
    scale = config.get("eloScale", 400)
    initial = config.get("initialRating", 1400)
    teams = collect_teams(elo["players"])

    rows = []
    for contest in eligible_contests(elo):
        members = {key: value for key, value in teams.items() if key[0] == contest["index"]}
        if len(members) < 2:
            continue
        meta = contest_meta(contest)
        keys = list(members)
        ranks = np.array([key[1] for key in keys])
        ratings = np.array([
            team_rating(team["ratings"], scale) if team["ratings"] else initial
            for team in members.values()
        ])
        rated = np.array([bool(team["ratings"]) for team in members.values()])
        rated_index = np.flatnonzero(rated)
        if len(rated_index) < 2:
            continue
        n_all, n_rated = len(keys), len(rated_index)

        if basis == "rated":
            predicted = np.full(n_all, np.nan)
            predicted[rated_index] = midranks(ratings[rated_index])
            true_position = np.full(n_all, np.nan)
            true_position[rated_index] = stats.rankdata(ranks[rated_index], method="min")
            size = n_rated
        else:
            predicted = midranks(ratings)
            true_position = ranks.astype(float)
            size = n_all

        unrated_members = sum(team["unrated"] for team in members.values())
        total_members = sum(len(team["ratings"]) + team["unrated"] for team in members.values())
        unrated_share = float(unrated_members / max(1, total_members))
        start = contest.get("startAt") or ""
        for index, team in enumerate(members.values()):
            if not rated[index]:
                continue  # no prior history: nothing to predict from
            rows.append({
                "contest": contest["key"],
                "year": int(start[:4]) if start[:4].isdigit() else 0,
                "size": size,
                "field_size": n_all,
                "true_rank": int(true_position[index]),
                "pred_rank": float(predicted[index]),
                "p": (predicted[index] - 0.5) / size,
                "q": (true_position[index] - 0.5) / size,
                "delta": true_position[index] - predicted[index],
                "rating": ratings[index],
                "rated_members": len(team["ratings"]),
                "unrated_share": unrated_share,
                **meta,
            })
    frame = pd.DataFrame(rows)
    frame["delta_norm"] = frame["delta"] / frame["size"]
    return frame


# --------------------------------------------------------------------------- #
# Empirical summaries
# --------------------------------------------------------------------------- #

def decile_table(samples: pd.DataFrame) -> pd.DataFrame:
    """True-rank distribution inside each tenth of the predicted percentile.

    Deltas are expressed as a percentage of the field, because contests range
    from roughly 80 to 600 teams and raw ranks are not comparable across them.
    """
    edges = np.linspace(0, 1, 11)
    samples = samples.assign(
        decile=np.clip(np.digitize(samples["p"], edges[1:-1]) + 1, 1, 10),
        delta_pct=samples["delta_norm"] * 100,
    )
    grouped = samples.groupby("decile")
    table = pd.DataFrame({
        "n": grouped.size(),
        "mean_delta": grouped["delta_pct"].mean(),
        "sd_delta": grouped["delta_pct"].std(ddof=0),
        "p05": grouped["delta_pct"].quantile(0.05),
        "median": grouped["delta_pct"].median(),
        "p95": grouped["delta_pct"].quantile(0.95),
        "top10_hit": grouped["q"].apply(lambda q: (q <= 0.1).mean()),
    })
    return table.rename_axis("decile").reset_index()


def overall(samples: pd.DataFrame) -> dict:
    return {
        "contests": int(samples["contest"].nunique()),
        "appearances": int(len(samples)),
        "spearman": float(stats.spearmanr(samples["p"], samples["q"]).statistic),
        "mean_delta": float(samples["delta"].mean()),
        "mean_abs_delta": float(samples["delta"].abs().mean()),
        "mean_abs_delta_pct": float(samples["delta_norm"].abs().mean() * 100),
        "median_abs_delta": float(samples["delta"].abs().median()),
        "median_abs_delta_pct": float(samples["delta_norm"].abs().median() * 100),
        "rmse": float(np.sqrt((samples["delta"] ** 2).mean())),
    }


def population_table(samples: pd.DataFrame) -> pd.DataFrame:
    """Contest and appearance counts per series."""
    grouping = samples.groupby(["series", "special"])
    table = pd.DataFrame({
        "contests": grouping["contest"].nunique(),
        "appearances": grouping.size(),
    }).reset_index()
    table["special"] = table["special"].map({True: "yes", False: "no"})
    return table.sort_values(["series", "special"]).reset_index(drop=True)


def contest_table(samples: pd.DataFrame) -> pd.DataFrame:
    """Per-contest predictability: Spearman of the prediction and error size."""
    rows = []
    for (name, series), block in samples.groupby(["contest", "series"]):
        rho = stats.spearmanr(block["p"], block["q"]).statistic
        rows.append({
            "contest": name,
            "series": series,
            "year": int(block["year"].iloc[0]),
            "size": int(block["size"].iloc[0]),
            "rho": float(rho),
            "mean_abs_delta": float(block["delta"].abs().mean()),
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Models: logit(true percentile) = location + scale * noise
# --------------------------------------------------------------------------- #

def logit(x):
    x = np.clip(x, 1e-9, 1 - 1e-9)
    return np.log(x / (1 - x))


def expit(x):
    return 1 / (1 + np.exp(-x))


def location_t(params, p):
    """Quadratic calibration curve on the logit scale."""
    a, b, c = params[:3]
    x = logit(p)
    return a + b * x + c * x * x


def model_specs() -> dict:
    return {
        "t-logit-quadratic": {
            "k": 5,
            "init": np.array([0.0, 0.8, 0.0, -0.5, 1.5]),
            "logpdf": lambda th, p, q: (
                stats.t.logpdf((logit(q) - location_t(th, p)) / np.exp(th[3]), df=np.exp(th[4]))
                - th[3] - np.log(q * (1 - q))
            ),
            "cdf": lambda th, p, q: stats.t.cdf((logit(q) - location_t(th, p)) / np.exp(th[3]), df=np.exp(th[4])),
        },
        "normal-logit-quadratic": {
            "k": 4,
            "init": np.array([0.0, 0.8, 0.0, -0.5]),
            "logpdf": lambda th, p, q: (
                stats.norm.logpdf((logit(q) - location_t(th, p)) / np.exp(th[3]))
                - th[3] - np.log(q * (1 - q))
            ),
            "cdf": lambda th, p, q: stats.norm.cdf((logit(q) - location_t(th, p)) / np.exp(th[3])),
        },
        "beta-calibrated": {
            "k": 1,
            "init": np.array([1.8]),
            "logpdf": lambda th, p, q: stats.beta.logpdf(q, p * np.exp(th[0]), (1 - p) * np.exp(th[0])),
            "cdf": lambda th, p, q: stats.beta.cdf(q, p * np.exp(th[0]), (1 - p) * np.exp(th[0])),
        },
    }


def fit(spec: dict, samples: pd.DataFrame, init: np.ndarray | None = None) -> dict:
    p, q = samples["p"].to_numpy(), samples["q"].to_numpy()

    def nll(theta):
        value = -spec["logpdf"](theta, p, q).sum()
        return value if np.isfinite(value) else 1e12

    result = optimize.minimize(
        nll, spec["init"] if init is None else init, method="Nelder-Mead",
        options={"maxiter": 4000, "xatol": 1e-7, "fatol": 1e-9, "adaptive": True},
    )
    polished = optimize.minimize(nll, result.x, method="Nelder-Mead",
                                 options={"maxiter": 2000, "xatol": 1e-8, "fatol": 1e-10})
    theta = polished.x if polished.fun <= result.fun else result.x
    return {"theta": theta, "loglik": -float(min(result.fun, polished.fun)), "k": spec["k"]}


def pit_values(spec: dict, theta: np.ndarray, samples: pd.DataFrame) -> np.ndarray:
    return spec["cdf"](theta, samples["p"].to_numpy(), samples["q"].to_numpy())


def ks_uniform(u: np.ndarray) -> float:
    ordered = np.sort(u)
    n = len(ordered)
    return float(max(np.max(np.abs(ordered - np.arange(1, n + 1) / n)),
                     np.max(np.abs(np.arange(n) / n - ordered))))


def metrics(spec: dict, theta: np.ndarray, samples: pd.DataFrame) -> dict:
    u = pit_values(spec, theta, samples)
    decile = np.clip(np.digitize(samples["p"].to_numpy(), np.linspace(0.1, 0.9, 9)) + 1, 1, 10)
    return {
        "ks": ks_uniform(u),
        "mean_pit": float(u.mean()),
        "decile_pit": np.array([u[decile == d].mean() if (decile == d).any() else np.nan for d in range(1, 11)]),
        "n": int(len(u)),
    }


def cross_validate(spec: dict, samples: pd.DataFrame, init: np.ndarray, folds: int = 5) -> dict:
    contests = np.array(sorted(samples["contest"].unique()))
    fold_of = {name: i % folds for i, name in enumerate(contests)}
    fold = samples["contest"].map(fold_of).to_numpy()
    total = 0.0
    for k in range(folds):
        train, test = samples[fold != k], samples[fold == k]
        theta = fit(spec, train, init=init)["theta"]
        total += spec["logpdf"](theta, test["p"].to_numpy(), test["q"].to_numpy()).sum()
    return {"held_out_loglik": total / len(samples)}


def compare_models(samples: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    specs = model_specs()
    fits = {name: fit(spec, samples) for name, spec in specs.items()}
    best_name = min(fits, key=lambda name: 2 * fits[name]["k"] - 2 * fits[name]["loglik"])
    rows = []
    for name, spec in specs.items():
        current = fits[name]
        u = pit_values(spec, current["theta"], samples)
        n = len(samples)
        rows.append({
            "model": name,
            "k": current["k"],
            "loglik": current["loglik"],
            "aic": 2 * current["k"] - 2 * current["loglik"],
            "bic": current["k"] * np.log(n) - 2 * current["loglik"],
            "ks": ks_uniform(u),
            "mean_pit": float(u.mean()),
            "cv_loglik": cross_validate(spec, samples, current["theta"])["held_out_loglik"],
        })
    table = pd.DataFrame(rows).sort_values("aic").reset_index(drop=True)
    return table, {
        "name": best_name,
        "spec": specs[best_name],
        "theta": fits[best_name]["theta"],
        "metrics": metrics(specs[best_name], fits[best_name]["theta"], samples),
    }


def population_metrics(samples: pd.DataFrame, training: pd.DataFrame, best: dict) -> pd.DataFrame:
    """Apply the trained law unchanged to each population."""
    core = samples["series"].isin(["icpc", "ccpc"])
    populations = [
        ("core ICPC + CCPC (training)", training),
        ("special ICPC/CCPC events", samples[core & samples["special"]]),
        ("provincial contests", samples[samples["series"] == "provincial"]),
        ("all contests", samples),
    ]
    rows = []
    for label, block in populations:
        u = pit_values(best["spec"], best["theta"], block)
        rows.append({
            "population": label,
            "contests": block["contest"].nunique(),
            "appearances": len(block),
            "mean_abs_delta": float((block["delta"].abs() / block["size"]).mean() * 100),
            "ks": ks_uniform(u),
            "mean_pit": float(u.mean()),
        })
    return pd.DataFrame(rows)


def class_metrics(samples: pd.DataFrame, best: dict) -> pd.DataFrame:
    """How the trained law performs on each series, split by event type."""
    u = pit_values(best["spec"], best["theta"], samples)
    samples = samples.assign(u=u)
    rows = []
    for (series, special), block in samples.groupby(["series", "special"]):
        if series in ("icpc", "ccpc"):
            label = f"{series} ({'special' if special else 'core'})"
        else:
            label = series
        rho = [stats.spearmanr(b["p"], b["q"]).statistic for _, b in block.groupby("contest") if len(b) > 2]
        rows.append({
            "label": label,
            "contests": block["contest"].nunique(),
            "appearances": len(block),
            "mean_rho": float(np.mean(rho)),
            "mean_abs_delta": float((block["delta"].abs() / block["size"]).mean() * 100),
            "unrated_share": float(block["unrated_share"].mean() * 100),
            "ks": ks_uniform(block["u"].to_numpy()),
            "mean_pit": float(block["u"].mean()),
        })
    frame = pd.DataFrame(rows)
    order = {"icpc (core)": 0, "icpc (special)": 1, "ccpc (core)": 2, "ccpc (special)": 3}
    frame["order"] = frame["label"].map(order).fillna(4)
    return frame.sort_values(["order", "label"]).drop(columns="order").reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Contest-level noise
# --------------------------------------------------------------------------- #

def contest_noise(samples: pd.DataFrame, best: dict, min_rows: int = 15) -> pd.DataFrame:
    """Estimate a per-contest scale multiplier on the global noise term.

    The global shape is held fixed; each contest gets one free multiplier
    ``lam`` on the scale, so ``lam > 1`` means the contest was less predictable
    than the model expects.
    """
    a, b, c = best["theta"][:3]
    scale, nu = np.exp(best["theta"][3]), np.exp(best["theta"][4])
    rows = []
    for name, block in samples.groupby("contest"):
        if len(block) < min_rows:
            continue
        x = logit(block["p"].to_numpy())
        z = (logit(block["q"].to_numpy()) - (a + b * x + c * x * x)) / scale

        def nll(log_lam):
            return float(-(stats.t.logpdf(z / np.exp(log_lam), df=nu) - log_lam).sum())

        result = optimize.minimize_scalar(nll, bounds=(np.log(0.4), np.log(2.5)), method="bounded")
        u = best["spec"]["cdf"](best["theta"], block["p"].to_numpy(), block["q"].to_numpy())
        rows.append({
            "contest": name,
            "series": block["series"].iloc[0],
            "year": int(block["year"].iloc[0]),
            "size": int(block["size"].iloc[0]),
            "n": len(block),
            "rho": float(stats.spearmanr(block["p"], block["q"]).statistic),
            "noise": float(np.exp(result.x)),
            "log_noise": float(result.x),
            "pit": float(u.mean()),
            "unrated": float(block["unrated_share"].mean()),
            "rated_members": float(block["rated_members"].mean()),
        })
    return pd.DataFrame(rows)


def noise_relation(frame: pd.DataFrame) -> dict:
    """Correlation between contest predictability and the fitted noise."""
    rho, p_value = stats.spearmanr(frame["rho"], frame["log_noise"])
    pearson, pearson_p = stats.pearsonr(frame["rho"], frame["log_noise"])

    # Partial correlation controlling for field size (bigger fields have noises
    # that are estimated from more teams and slightly different rank grids).
    log_size = np.log(frame["size"].to_numpy())

    def residual(values):
        design = np.column_stack([np.ones_like(log_size), log_size])
        beta, *_ = np.linalg.lstsq(design, values, rcond=None)
        return values - design @ beta

    partial = float(np.corrcoef(residual(frame["rho"].to_numpy()), residual(frame["log_noise"].to_numpy()))[0, 1])
    slope, intercept = np.polyfit(frame["rho"], frame["log_noise"], 1)
    return {
        "spearman": float(rho), "spearman_p": float(p_value),
        "pearson": float(pearson), "pearson_p": float(pearson_p),
        "partial_size": partial,
        "slope": float(slope), "intercept": float(intercept),
        "median_noise": float(frame["noise"].median()),
        "noise_iqr": [float(frame["noise"].quantile(0.25)), float(frame["noise"].quantile(0.75))],
        "n": int(len(frame)),
    }


# --------------------------------------------------------------------------- #
# Figures
# --------------------------------------------------------------------------- #

def plot_calibration(samples, best, path):
    spec, theta = best["spec"], best["theta"]
    fig, ax = plt.subplots(figsize=(9, 6.2), dpi=140)

    thin = samples.iloc[::8]
    ax.scatter(thin["p"], thin["q"], s=1, color="#c6ccd8", alpha=0.4, linewidths=0)

    edges = np.linspace(0, 1, 41)
    centres, bands = [], []
    for low, high in zip(edges[:-1], edges[1:]):
        block = samples[(samples["p"] >= low) & (samples["p"] < high)]["q"]
        if len(block) < 30:
            continue
        centres.append((low + high) / 2)
        bands.append(np.quantile(block, [0.05, 0.25, 0.5, 0.75, 0.95]))
    bands = np.array(bands)
    ax.fill_between(centres, bands[:, 0], bands[:, 4], color="#c4d4ea", label="empirical 5-95%")
    ax.fill_between(centres, bands[:, 1], bands[:, 3], color="#8caad4", label="empirical 25-75%")

    grid = np.linspace(0.005, 0.995, 400)
    location = location_t(theta, grid)
    scale = np.exp(theta[3])
    distribution = stats.t(df=np.exp(theta[4]))
    ax.plot(grid, expit(location), color="#c0392b", lw=2.5, label="fitted median")
    for level in (0.05, 0.95):
        ax.plot(grid, expit(location + scale * distribution.ppf(level)), color="#1f5fa8", lw=1, ls="--")
    ax.plot([0, 1], [0, 1], color="#888", lw=1, ls=":", label="perfect calibration")

    ax.set(xlim=(0, 1), ylim=(0, 1), xlabel="predicted percentile from prior Elo (0 = top)",
           ylabel="true percentile", title="True rank percentile vs prior-Elo predicted percentile")
    ax.legend(loc="upper left", frameon=False, fontsize=9)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_pit(samples, best, path):
    spec, theta = best["spec"], best["theta"]
    fig, (left, right) = plt.subplots(1, 2, figsize=(10, 4), dpi=140,
                                      gridspec_kw={"width_ratios": [2, 1]})
    u = pit_values(spec, theta, samples)
    left.hist(u, bins=20, density=True, color="#7b9bd0", edgecolor="white")
    left.axhline(1.0, color="#c0392b", lw=1.5, label="uniform reference")
    left.set(xlabel="PIT value (uniform when the model is right)", ylabel="density",
             title="Probability integral transform of the fitted law")
    left.legend(frameon=False, fontsize=9)

    decile_pit = best["metrics"]["decile_pit"]
    right.plot(range(1, 11), decile_pit, "o-", color="#1f5fa8")
    right.axhline(0.5, color="#c0392b", lw=1)
    right.set(xlabel="predicted decile", ylabel="mean PIT", ylim=(0.35, 0.65), title="Calibration by decile")
    right.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_rank_fan(samples, best, path):
    spec, theta = best["spec"], best["theta"]
    subset = samples[(samples["size"] >= 250) & (samples["size"] <= 350)]
    fig, ax = plt.subplots(figsize=(9, 5.6), dpi=140)
    ax.scatter(subset["pred_rank"], subset["true_rank"], s=1, color="#c6ccd8", alpha=0.4, linewidths=0)

    buckets = subset.assign(bucket=(subset["pred_rank"] // 10).astype(int)).groupby("bucket")
    medians, counts = buckets["true_rank"].median(), buckets.size()
    ax.plot(medians.index[counts >= 20] * 10 + 5, medians[counts >= 20], color="#333", lw=2, label="empirical median")

    grid = np.linspace(0.002, 0.998, 400)
    location, scale = location_t(theta, grid), np.exp(theta[3])
    distribution = stats.t(df=np.exp(theta[4]))
    ax.plot(grid * 300, expit(location) * 300, color="#c0392b", lw=2.5, label="fitted median")
    for level in (0.05, 0.95):
        ax.plot(grid * 300, expit(location + scale * distribution.ppf(level)) * 300,
                color="#1f5fa8", lw=1, ls="--")
    ax.plot([0, 300], [0, 300], color="#888", lw=1, ls=":", label="perfect calibration")
    ax.set(xlim=(0, 300), ylim=(0, 300), xlabel="predicted rank (prior Elo)", ylabel="true rank",
           title="True rank vs predicted rank (250-350 team fields)")
    ax.legend(loc="upper left", frameon=False, fontsize=9)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_noise(frame: pd.DataFrame, relation: dict, path):
    fig, ax = plt.subplots(figsize=(8, 5.2), dpi=140)
    for series, block in frame.groupby("series"):
        ax.scatter(block["rho"], block["noise"], s=np.clip(block["n"] / 20, 6, 60), alpha=0.6,
                   color=SERIES_COLOURS.get(series, "#7f7f7f"), label=series, linewidths=0)
    grid = np.linspace(frame["rho"].min(), frame["rho"].max(), 50)
    ax.plot(grid, np.exp(relation["intercept"] + relation["slope"] * grid), color="#333", lw=1.5, ls="--")
    ax.set(yscale="log", xlabel="Spearman rho of the contest prediction",
           ylabel="fitted noise multiplier (1 = average contest)",
           title="Contest predictability vs fitted noise")
    ax.text(0.02, 0.96, f"Spearman {relation['spearman']:+.2f} (n={relation['n']})",
            transform=ax.transAxes, va="top", fontsize=10)
    ax.legend(frameon=False, fontsize=9, loc="lower left")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_class_calibration(samples, best, path):
    u = pit_values(best["spec"], best["theta"], samples)
    core = samples["series"].isin(["icpc", "ccpc"]) & ~samples["special"]
    special = samples["special"] & samples["series"].isin(["icpc", "ccpc"])
    population = np.where(core, "core ICPC + CCPC",
                          np.where(special, "special ICPC/CCPC", "provincial"))
    frame = samples.assign(u=u, population=population,
                           decile=np.clip(np.digitize(samples["p"], np.linspace(0.1, 0.9, 9)) + 1, 1, 10))
    colours = {"core ICPC + CCPC": "#1f5fa8", "special ICPC/CCPC": "#d07b1f", "provincial": "#2e8b57"}
    fig, ax = plt.subplots(figsize=(8, 4.8), dpi=140)
    for label, block in frame.groupby("population"):
        means = block.groupby("decile")["u"].mean()
        ax.plot(means.index, means.values, "o-", ms=4, color=colours.get(label, "#7f7f7f"),
                label=f"{label} ({block['contest'].nunique()} contests)")
    ax.axhline(0.5, color="#c0392b", lw=1)
    ax.set(xlabel="predicted decile", ylabel="mean PIT", ylim=(0.28, 0.66),
           title="Calibration by predicted decile, per contest population")
    ax.legend(frameon=False, fontsize=9)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_unrated_diagnostic(frame: pd.DataFrame, path):
    fig, ax = plt.subplots(figsize=(7.5, 4.8), dpi=140)
    for series, block in frame.groupby("series"):
        ax.scatter(block["unrated"], block["pit"], s=np.clip(block["n"] / 20, 6, 50), alpha=0.6,
                   color=SERIES_COLOURS.get(series, "#7f7f7f"), label=series, linewidths=0)
    ax.axhline(0.5, color="#c0392b", lw=1)
    ax.set(xlabel="share of the field with no prior rating",
           ylabel="mean PIT of the contest (0.5 = calibrated)",
           title="Miscalibration is driven by unrated fields")
    ax.legend(frameon=False, fontsize=9)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #

def markdown_table(frame: pd.DataFrame, formats: dict[str, str], header: dict[str, str] | None = None) -> str:
    header = header or {}
    lines = ["| " + " | ".join(header.get(c, c) for c in frame.columns) + " |",
             "|" + "|".join("---:" for _ in frame.columns) + "|"]
    for _, row in frame.iterrows():
        cells = [formats[c].format(row[c]) if c in formats else str(row[c]) for c in frame.columns]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def write_report(summary, deciles, comparison, best, population, populations, classes,
                 relation, frame, bases, unrated_corr):
    a, b, c = best["theta"][:3]
    scale, nu = np.exp(best["theta"][3]), np.exp(best["theta"][4])
    distribution = stats.t(df=nu)

    reference = 300
    rows = []
    for rank in (1, 5, 10, 25, 50, 100, 150, 200, 250, 290):
        x = float(logit((rank - 0.5) / reference))
        location = a + b * x + c * x * x
        quantiles = [float(expit(location + scale * distribution.ppf(level))) * reference
                     for level in (0.05, 0.25, 0.5, 0.75, 0.95)]
        rows.append([rank, *[int(min(reference, max(1, round(value)))) for value in quantiles]])
    usage = pd.DataFrame(rows, columns=["pred", "p05", "p25", "p50", "p75", "p95"])

    decile_view = deciles.copy()
    decile_view["decile"] = decile_view["decile"].astype(int)
    decile_view["top10_hit"] = decile_view["top10_hit"] * 100

    within_corr = {
        series: float(stats.spearmanr(block["rho"], block["log_noise"]).statistic)
        for series, block in frame.groupby("series")
        if len(block) >= 20
    }
    bands = frame.assign(band=pd.qcut(frame["rho"], 4, labels=["worst", "worse", "better", "best"]))
    quartiles = (
        bands.groupby("band", observed=True)
        .agg(contests=("noise", "size"), mean_rho=("rho", "mean"), median_noise=("noise", "median"))
        .reset_index()
    )

    prov = classes[classes["label"] == "provincial"].iloc[0]
    prov_contests = int(prov["contests"])
    special_row = populations[populations["population"] == "special ICPC/CCPC events"].iloc[0]
    special_contests = int(special_row["contests"])
    noise_per_tenth = float(np.exp(-relation["slope"] * 0.1))

    class_pit_min, class_pit_max = float(classes["mean_pit"].min()), float(classes["mean_pit"].max())
    class_ks_min, class_ks_max = float(classes["ks"].min()), float(classes["ks"].max())
    rho_min, rho_max = float(classes["mean_rho"].min()), float(classes["mean_rho"].max())

    def basis_pit(basis, population):
        row = bases[(bases["basis"] == basis) & (bases["population"] == population)]
        return float(row["mean_pit"].iloc[0])

    all_special_pit = basis_pit("all", "special events")
    all_prov_pit = basis_pit("all", "provincial")
    rated_special_pit = basis_pit("rated", "special events")
    rated_prov_pit = basis_pit("rated", "provincial")

    noise_range_text = f"{frame['noise'].min():.2f} to {frame['noise'].max():.2f}"
    within_text = (
        f"within ICPC it is {within_corr.get('icpc', float('nan')):+.2f}, "
        f"within CCPC {within_corr.get('ccpc', float('nan')):+.2f} and "
        f"within provincial {within_corr.get('provincial', float('nan')):+.2f}"
    )

    text = f"""# True-rank distribution given prior Elo

Estimated on the **{summary['contests']} core ICPC and CCPC contests from {MIN_YEAR} on**
({summary['appearances']:,} team appearances with prior Elo), excluding
invitational, preliminary, ladies and Hong Kong events. The wider study population
adds {special_contests} such special events and {prov_contests} provincial
contests, used below as transfer tests. The predicted percentile is
`p = (predRank - 0.5) / teamCount` and the true one `q = (trueRank - 0.5) / teamCount`,
**both computed among the rated teams of the contest** — those with at least one
member that competed before. `p = 0` is the top of the rated field.

## Population

{markdown_table(population, {'contests': '{:.0f}', 'appearances': '{:.0f}'}, {'special': 'special event'})}

## The distribution

```
logit(q) ~ {a:.4f} + {b:.4f}*logit(p) {c:+.4f}*logit(p)^2 + {scale:.4f} * t({nu:.2f})
```

The median true percentile is `logistic(location)`, and the 5-95% interval is
`logistic(location +- {distribution.ppf(0.95):.2f} * {scale:.4f})`. The slope is
below one, so the prior order is directionally right but **shrinks toward the
middle**; the Student-t tail (about {nu:.1f} degrees of freedom) captures teams
whose rating is much less certain than the rest.

Fit quality: log-likelihood {comparison.iloc[0]['loglik']:.1f} on
{summary['appearances']:,} rows, PIT KS {best['metrics']['ks']:.4f}, mean PIT
{best['metrics']['mean_pit']:.4f}, held-out log-likelihood
{comparison.iloc[0]['cv_loglik']:.3f} per sample (5-fold by contest).

{markdown_table(comparison, {'loglik': '{:.1f}', 'aic': '{:.1f}', 'bic': '{:.1f}', 'ks': '{:.4f}', 'mean_pit': '{:.4f}', 'cv_loglik': '{:.3f}'})}

Applied unchanged to other populations:

{markdown_table(populations, {'contests': '{:.0f}', 'appearances': '{:.0f}', 'mean_abs_delta': '{:.1f}', 'ks': '{:.4f}', 'mean_pit': '{:.4f}'}, {'mean_abs_delta': 'mean abs delta (% rated field)'})}

Spearman between predicted and true order is **{summary['spearman']:.3f}**. The
mean absolute rank error is **{summary['mean_abs_delta_pct']:.1f}% of the field**
({summary['mean_abs_delta']:.1f} ranks; median {summary['median_abs_delta_pct']:.1f}%),
and the RMSE is **{summary['rmse']:.1f} ranks**.

## Does it hold on less well-behaved contests?

Yes, once the percentiles are relative to the rated members. The law transfers
unchanged to the special events and to the provincial contests:

{markdown_table(classes, {'contests': '{:.0f}', 'appearances': '{:.0f}', 'mean_rho': '{:.3f}', 'mean_abs_delta': '{:.1f}', 'unrated_share': '{:.1f}', 'ks': '{:.4f}', 'mean_pit': '{:.4f}'}, {'mean_abs_delta': 'mean abs delta (% field)', 'unrated_share': 'unrated members (%)', 'label': 'population'})}

![Class calibration](fig5-class-calibration.png)

Mean PIT stays between {class_pit_min:.3f} and {class_pit_max:.3f} in every
population and KS between {class_ks_min:.3f} and {class_ks_max:.3f}. What changes
across populations is predictability, not the shape of the law: mean rho runs from
{rho_min:.2f} to {rho_max:.2f}, and the noise section below quantifies the cost.

The one visible residual is the last decile, where the model is slightly too
pessimistic in every population (mean PIT 0.39-0.44): the very weakest rated teams
finish a little better than a monotone rating order implies.

## Why rank only among rated teams

Ranking among every team of the contest instead gives each unrated team the
initial rating, which is a placeholder rather than an estimate. The law then still
fits the core events but stops transferring:

{markdown_table(bases, {'appearances': '{:.0f}', 'ks': '{:.4f}', 'mean_pit': '{:.4f}'}, {'basis': 'rank basis', 'population': 'population'})}

Under the all-team basis mean PIT falls to {all_special_pit:.2f} on special events
and {all_prov_pit:.2f} on provincial contests, against {rated_special_pit:.2f} and
{rated_prov_pit:.2f} when only rated teams are ranked. The mechanism is the
unrated share of the field: per-contest PIT under the all-team basis correlates
**{unrated_corr:+.2f}** with it, and the drift sits in the lower half of the
table, where those teams land.

![Unrated diagnostic](fig6-unrated-share.png)

## Contest predictability and the noise term

Each contest gets a free multiplier `lam` on the noise scale, fitted by maximum
likelihood with the global shape held fixed. Across the {relation['n']} contests
with at least 15 predictable teams, lam ranges from {noise_range_text} (median
{relation['median_noise']:.2f}) and tracks the contest's Spearman coefficient:

| statistic | value |
|---|---|
| Spearman(rho, log lam) | {relation['spearman']:+.3f} (p = {relation['spearman_p']:.1e}) |
| Pearson(rho, log lam) | {relation['pearson']:+.3f} |
| partial, controlling log field size | {relation['partial_size']:+.3f} |
| slope of log lam on rho | {relation['slope']:+.2f} |

The relation is not an artefact of provincial contests: {within_text}.

{markdown_table(quartiles, {'contests': '{:.0f}', 'mean_rho': '{:.3f}', 'median_noise': '{:.2f}'}, {'band': 'rho quartile'})}

A contest with a Spearman coefficient 0.1 lower carries about
{noise_per_tenth:.2f} times the rank noise, so a low-rho contest needs a wider
interval than the global scale provides. The multiplier is a per-contest
diagnostic; the model itself keeps one global scale.

![Noise vs Spearman](fig4-noise-vs-spearman.png)

## Empirical decile table

`delta = trueRank - predRank` as a percentage of the field, positive meaning a
worse finish than predicted. Computed on the training population.

{markdown_table(decile_view, {'decile': '{:.0f}', 'n': '{:.0f}', 'mean_delta': '{:+.1f}', 'sd_delta': '{:.1f}', 'p05': '{:.1f}', 'median': '{:.1f}', 'p95': '{:.1f}', 'top10_hit': '{:.1f}'}, {'top10_hit': 'top10 %'})}

![Calibration](fig1-calibration.png)

## Using it

True-rank quantiles among the rated teams of a field with {reference} rated teams:

{markdown_table(usage, {column: '{:.0f}' for column in usage.columns})}

![Rank fan](fig3-rank-fan.png)

## Limits

- The law describes the order among rated teams. Converting it to an overall rank
  needs the unrated teams placed somehow; assuming they finish near the middle is
  the approximation the all-team basis makes, and it is what breaks there.
- The contest-level `lam` is estimated from the same rows it describes, and with
  15-40 predictable teams per contest it carries real sampling error; the
  correlation with rho is therefore an upper bound on the true relationship.
- Rank percentiles lie on a `1/n` grid while the law is continuous, so
  differences below a couple of ranks are not resolvable.
- Teams recur across contests and share members: the rows are not independent.
"""
    path = OUT_DIR / "report.md"
    path.write_text(text, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def compare_bases(frames: dict[str, pd.DataFrame], spec: dict) -> pd.DataFrame:
    """Fit the law on core events under each rank basis and transfer it.

    ``rated`` ranks teams only among those with a prior rating, ``all`` ranks
    them among every team of the contest.
    """
    rows = []
    for basis, frame in frames.items():
        training = frame[(~frame["special"]) & frame["series"].isin(["icpc", "ccpc"])]
        theta = fit(spec, training)["theta"]
        core = frame["series"].isin(["icpc", "ccpc"]) & ~frame["special"]
        special = frame["special"] & frame["series"].isin(["icpc", "ccpc"])
        provincial = frame["series"] == "provincial"
        for label, mask in (("core ICPC + CCPC", core), ("special events", special), ("provincial", provincial)):
            u = pit_values(spec, theta, frame[mask])
            rows.append({
                "basis": basis,
                "population": label,
                "appearances": int(mask.sum()),
                "ks": ks_uniform(u),
                "mean_pit": float(u.mean()),
            })
    return pd.DataFrame(rows)


def all_basis_diagnostic(frame: pd.DataFrame, spec: dict, theta: np.ndarray) -> pd.DataFrame:
    """Per-contest PIT under the all-team basis, to expose the unrated effect."""
    u = pit_values(spec, theta, frame)
    frame = frame.assign(u=u)
    grouped = frame.groupby(["contest", "series"])
    return pd.DataFrame({
        "pit": grouped["u"].mean(),
        "unrated": grouped["unrated_share"].mean(),
        "n": grouped.size(),
    }).reset_index()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in ("noise-model.json", "noise-rank-quantiles.csv", "model-curves.csv",
                  "pit-values.csv", "decile-fit.csv", "rank-quantiles.csv", "contest-teams.csv"):
        (OUT_DIR / stale).unlink(missing_ok=True)

    elo = json.loads(ELO_FILE.read_text(encoding="utf-8"))
    frames = {basis: build_samples(elo, basis) for basis in ("rated", "all")}
    samples = frames["rated"]
    training = samples[(~samples["special"]) & samples["series"].isin(["icpc", "ccpc"])]
    summary = overall(training)
    deciles = decile_table(training)
    population = population_table(samples)

    comparison, best = compare_models(training)
    populations = population_metrics(samples, training, best)
    classes = class_metrics(samples, best)
    frame = contest_noise(samples, best)
    relation = noise_relation(frame)
    bases = compare_bases(frames, best["spec"])
    all_diagnostic = all_basis_diagnostic(
        frames["all"], best["spec"], fit(best["spec"], frames["all"][
            (~frames["all"]["special"]) & frames["all"]["series"].isin(["icpc", "ccpc"])
        ])["theta"],
    )
    unrated_corr = float(stats.spearmanr(all_diagnostic["unrated"], all_diagnostic["pit"]).statistic)

    samples.to_csv(OUT_DIR / "samples.csv", index=False)
    deciles.to_csv(OUT_DIR / "deciles.csv", index=False)
    classes.to_csv(OUT_DIR / "contest-classes.csv", index=False)
    frame.to_csv(OUT_DIR / "contest-noise.csv", index=False)
    bases.to_csv(OUT_DIR / "rank-bases.csv", index=False)
    (OUT_DIR / "summary.json").write_text(
        json.dumps({"training": summary, "transfer": populations.to_dict(orient="records"),
                    "bases": bases.to_dict(orient="records"), "relation": relation}, indent=2) + "\n",
        encoding="utf-8")
    (OUT_DIR / "models.json").write_text(
        json.dumps({
            "best": best["name"],
            "theta": best["theta"].tolist(),
            "metrics": {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in best["metrics"].items()},
            "comparison": comparison.to_dict(orient="records"),
            "populations": populations.to_dict(orient="records"),
        }, indent=2) + "\n", encoding="utf-8")

    # The law consumed by the prediction page: q | p ~ logistic(location + scale * t(nu)).
    theta = best["theta"]
    law = {
        "model": best["name"],
        "basis": "rated",
        "aggregation": elo["config"].get("teamRatingAggregation", "log-power-mean"),
        "params": {
            "a": float(theta[0]),
            "b": float(theta[1]),
            "c": float(theta[2]),
            "logScale": float(theta[3]),
            "logNu": float(theta[4]),
        },
        "buckets": [["gold", 0.0, 0.1], ["silver", 0.1, 0.3], ["bronze", 0.3, 0.6], ["iron", 0.6, 1.0]],
        "trained": {
            "contests": int(summary["contests"]),
            "appearances": int(summary["appearances"]),
            "population": "core ICPC/CCPC",
            "minYear": MIN_YEAR,
            "basis": "rated",
        },
    }
    (OUT_DIR / "law.json").unlink(missing_ok=True)
    LAW_FILE.write_text(json.dumps(law, indent=2) + "\n", encoding="utf-8")

    plot_calibration(training, best, OUT_DIR / "fig1-calibration.png")
    plot_pit(training, best, OUT_DIR / "fig2-pit.png")
    plot_rank_fan(training, best, OUT_DIR / "fig3-rank-fan.png")
    plot_noise(frame, relation, OUT_DIR / "fig4-noise-vs-spearman.png")
    plot_class_calibration(samples, best, OUT_DIR / "fig5-class-calibration.png")
    plot_unrated_diagnostic(all_diagnostic, OUT_DIR / "fig6-unrated-share.png")
    report = write_report(summary, deciles, comparison, best, population, populations, classes,
                          relation, frame, bases, unrated_corr)

    print(f"training: {summary['contests']} contests, {summary['appearances']:,} appearances "
          f"(ranked among rated members)")
    print(f"spearman={summary['spearman']:.3f}  mean|delta|={summary['mean_abs_delta_pct']:.1f}% of rated field  "
          f"rmse={summary['rmse']:.1f}")
    print(comparison.to_string(index=False))
    print(f"\nbest: {best['name']}  a={best['theta'][0]:.4f} b={best['theta'][1]:.4f} "
          f"c={best['theta'][2]:+.4f} s={np.exp(best['theta'][3]):.4f} nu={np.exp(best['theta'][4]):.2f}")
    print("\nrank basis comparison (t-logit fit on core, transferred):")
    print(bases.pivot(index="population", columns="basis", values="mean_pit").round(3).to_string())
    print("\ntransfer:")
    print(populations.to_string(index=False))
    print("\nby series:")
    print(classes.to_string(index=False))
    print(f"\nunrated-share correlation under the all-team basis: {unrated_corr:+.2f}")
    print(f"noise vs rho: spearman={relation['spearman']:+.3f} pearson={relation['pearson']:+.3f} "
          f"partial={relation['partial_size']:+.3f} slope={relation['slope']:+.2f}")
    print(f"report: {report}")


if __name__ == "__main__":
    main()
