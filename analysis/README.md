# analysis

Python companions for the Elo pipeline. They read the generated data under
`out/` and never touch the Node build.

## Rank calibration

`rank_calibration.py` quantifies how well a team's pre-contest aggregate Elo
predicts its finishing rank, fits a probability law for the true rank, and checks
that the law transfers across contest series.

```bash
pip install -r analysis/requirements.txt   # numpy, pandas, scipy, matplotlib
python analysis/rank_calibration.py
```

Runtime is about two minutes: 157 contests, 60,469 team appearances, three
candidate laws fitted by maximum likelihood plus 5-fold cross-validation, a
per-contest noise fit, a rank-basis comparison and six figures.

**Outputs** (`out/calibration/`):

| File | Contents |
|---|---|
| `report.md` | generated report: fitted law, per-population tables, figures |
| `samples.csv` | one row per evaluated team appearance |
| `deciles.csv` | empirical distribution by predicted decile |
| `contest-classes.csv` | performance per contest population |
| `contest-noise.csv` | per-contest Spearman, noise multiplier, PIT |
| `rank-bases.csv` | rated-only vs all-team basis comparison |
| `summary.json` | Spearman, errors, transfer, noise correlation |
| `models.json` | fitted parameters, AIC/BIC, PIT, cross-validation |
| `fig1-calibration.png` | true vs predicted percentile |
| `fig2-pit.png` | probability integral transform |
| `fig3-rank-fan.png` | true rank vs predicted rank |
| `fig4-noise-vs-spearman.png` | contest noise vs contest Spearman |
| `fig5-class-calibration.png` | calibration per contest population |
| `fig6-unrated-share.png` | all-team-basis miscalibration vs unrated share |

**Method.** Teams are rebuilt from the player histories in
`out/teammate-elo.json`: a member is rated when it competed earlier, and its
pre-contest rating is the stored rating minus the applied delta. Both the
predicted and the true percentile are computed **among the rated teams of the
contest** — those with at least one member that competed before — so unrated teams
(which sit at the initial rating, a placeholder) do not distort the order.
Ties get midranks, and `p = (predRank - 0.5) / ratedCount` is matched against
`q = (trueRank - 0.5) / ratedCount`.

**Result.** With `logit` on the 0-1 percentile,

```
logit(q) ~ 0.0409 + 0.8114*logit(p) - 0.0266*logit(p)^2 + 0.8549 * t(6.57)
```

PIT KS 0.019, held-out log-likelihood 0.578 per sample. The slope below one is
shrinkage toward the middle of the field; the t tail covers teams whose rating is
less certain.

**Two findings beyond the plain fit.**

- *The law is universal across series once the basis is rated members.* Applied
  unchanged to special events (invitational, preliminary) it stays at mean PIT
  0.496, and on provincial contests at 0.499, with KS 0.023 and 0.042. Ranking
  among *every* team instead drops those to 0.421 and 0.316, tracking the share of
  the field with no prior rating (per-contest correlation -0.88).
- *Contest predictability and noise are almost perfectly linked.* Giving each
  contest a free multiplier on the noise scale, the multiplier correlates -0.955
  with the contest's own Spearman coefficient (partial -0.93 controlling field
  size), and it holds inside every series (-0.95 ICPC, -0.97 CCPC, -0.92
  provincial). A contest 0.1 Spearman worse carries ~1.19x the noise.

See `out/calibration/report.md` for the tables and caveats.

### `law.json`

The script also writes `analysis/law.json` — the fitted coefficients the
dashboard build injects into the prediction page. Because `out/` is gitignored
and the site is deployed by GitHub Actions from a fresh checkout, this one file
is **committed**: after refitting, review the diff and commit it. The build
(`node scripts/build-elo-frontend.cjs`) reads it from there by default and falls
back to empty probability columns if it is missing.
