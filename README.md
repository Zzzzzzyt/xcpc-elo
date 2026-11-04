# xcpc-elo

Pipeline utilities for building an XCPC teammate Elo dashboard from [algoux/srk-collection](https://github.com/algoux/srk-collection) ranklists

## Setup

```bash
npm install
```

## Canonical Workflow

```bash
npm run workflow:elo-dashboard
```

This runs the full workflow in order:

1. SRK source -> static ranklists  
   `npm run step:1:static-ranklists`
2. Extract teammate-organization map  
   `npm run step:2:teammate-org-map`
3. Compute Elo  
   `npm run step:3:compute-elo`
4. Build frontend assets  
   `npm run step:4:build-frontend`

`npm run workflow:recompute-elo` is equivalent to steps 3 & 4.

## Predict Registration Ranking

`frontend/predict.html` (built to `out/frontend/predict.html`) ranks a
registration CSV by the current Elo of its teammates. Open the page from the
built dashboard, drop a CSV in, and download the ranked result; everything runs
in the browser against the local `data.js`, with no server.

The CSV needs:

- a school column: `school|university|学校|院校|organization`
- at least one teammate column: `[teammate|队员|member]<1|2|3>`

Teammate cells split on `, ; ， 、 / |` and whitespace, so a single cell can hold a
whole team. Names that match no rated teammate are ignored; a team with no match
scores `0` and falls to the bottom of the ranking.

The team rating always uses the aggregation recorded in `out/teammate-elo.json`
(`log-power-mean` for the current data) — the same method the Elo itself is built
with, so there is no mode switch. Ties break on the number of matched teammates
and then on CSV row order.

The download contains `predicted_rank`, the score column
(`predicted_<aggregation>`), and the original columns, encoded as UTF-8 with a
BOM. Input is decoded as UTF-8 with a GB18030 fallback. Matched teammate names
link to their player page (`index.html?player=...`); unmatched names are shown
struck through.

### Finish-band probabilities

A calculator panel at the top of the page takes a field size and one predicted
rank and returns the same four probabilities, so a single team can be estimated
without a registration CSV.

When `analysis/law.json` exists — a committed artifact written by
`python analysis/rank_calibration.py` — the table also estimates each team's
chance of finishing gold (top 10%), silver (10–30%), bronze (30–60%) and iron
(60–100%). The columns are percentages that sum to 100, and the download gains
`p_gold_pct`, `p_silver_pct`, `p_bronze_pct`, `p_iron_pct`.

They come from the fitted distribution of the true percentile given the predicted
percentile, `logit(q) ~ t-logit-quadratic(p)`, evaluated over the matched teams
(the basis the law was estimated on), so a team with no matched member shows
`—`. Fields much smaller than a real contest give coarse percentiles; the page
warns when fewer than 30 teams are rated. Without `law.json` the columns stay
empty, and rebuilding is still `npm run step:4:build-frontend`.

The rank number itself is tinted by the medal band of that rank under the ICPC
rule, where the number of places is rounded up: gold up to `ceil(10%)` of the
field, silver up to `ceil(30%)`, bronze up to `ceil(60%)`, iron beyond. This is
a property of the rank, not of the model — a team predicted 13th of 120 is
silver-coloured while its own gold probability may still be a few percent.

`analysis/law.json` is committed on purpose: Pages builds from a clean checkout
where `out/` does not exist, so the coefficients have to travel with the repo.
When the Elo data changes materially, re-run the analysis and commit the new law.

The page footer prints the formula, the band definitions and the coefficients,
all read from that file so the text cannot drift from the numbers actually used.

## Rank Calibration Study

How good is a prior-Elo rank prediction, and what is the distribution of a
team's true rank? The Python analysis in `analysis/` answers this with a fitted
distribution, estimated on 55 core ICPC/CCPC contests from 2022 onward and then
transfer-tested on 43 special events and 59 provincial contests.

```bash
pip install -r analysis/requirements.txt
python analysis/rank_calibration.py
```

It writes `out/calibration/report.md` plus samples, per-contest tables and six
figures. Percentiles are taken among the rated teams of each contest, which makes
the law transfer across every series:

- PIT KS 0.019 on core ICPC/CCPC, 0.023 on special events and 0.042 on provincial
  contests, with mean PIT 0.50 in all three. Ranking among every team instead
  collapses to 0.42 and 0.32, driven by the share of teams with no prior rating.
- A contest's predictability and its noise term are almost perfectly linked: a
  free per-contest noise multiplier correlates -0.955 with the contest's Spearman
  coefficient, and the relation holds inside every series.

See `analysis/README.md` for the method and `out/calibration/report.md` for the
tables.

## Key Outputs

- Invalid teammate report: `out/_invalid-teammates.json`
- Teammate map: `out/teammate-map.json`
- Elo data: `out/teammate-elo.json`
- Rank calibration study: `out/calibration/report.md`
- Frontend: `out/frontend/*` (dashboard, contests, and `predict.html`)
