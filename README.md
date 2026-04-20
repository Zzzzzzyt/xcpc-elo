# xcpc-elo

Pipeline utilities for building an XCPC teammate Elo dashboard from:
- `data/srk-collection` ranklists
- CPCFinder contest/awards data

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
2. Crawl CPCFinder  
   `npm run step:2:cpcfinder-crawl`
3. Build CPCFinder -> SRK contest mapping  
   `npm run step:3:cpcfinder-srk-map`
4. Substitute CPCFinder teammate data into static ranklists  
   `npm run step:4:substitute-static-ranklists`
5. Extract teammate-organization map (after substitution)  
   `npm run step:5:teammate-org-map`
6. Compute Elo  
   `npm run step:6:compute-elo`
7. Build frontend assets  
   `npm run step:7:build-frontend`

`npm run build:elo-dashboard` is an alias of `workflow:elo-dashboard`.

## Key Outputs

- Static ranklists: `out/static-ranklists/*.static.srk.json`
- Static generation summary: `out/static-ranklists/_summary.json`
- Static invalid teammate report: `out/static-ranklists/_invalid-teammates.json`
- Substitution report: `out/static-ranklists/_substitution.json`
- Teammate map: `out/teammate-map.json`
- CPCFinder crawl index: `out/cpcfinder/index.json`
- CPCFinder contest mapping:
  - `out/cpcfinder/contest-map.success.json`
  - `out/cpcfinder/contest-map.unmatched.json`
  - `out/cpcfinder/contest-map.summary.json`
- Elo data: `out/teammate-elo.json`
- Frontend:
  - `out/frontend/index.html`
  - `out/frontend/styles.css`
  - `out/frontend/app.js`
  - `out/frontend/data.js`

## Manual Mapping Overrides (Optional)

If some CPCFinder contests cannot be auto-mapped, add overrides in:

`out/cpcfinder/contest-map.manual.json`

Format:

```json
[
  {
    "contestId": 50,
    "srkUniqueKey": "icpc2021macau",
    "note": "manual mapping"
  }
]
```
