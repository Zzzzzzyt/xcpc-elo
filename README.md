# xcpc-elo

Utilities to compute static ranklists from the srk-collection dataset.

## Setup

```bash
npm install
```

## Generate static ranklists

```bash
npm run compute:static-ranklists
```

Generated files are written to `out/static-ranklists`.

## Build teammate identity map

```bash
npm run build:teammate-map
```

Generated file: `out/teammate-map.json`.

## Compute teammate Elo (Codeforces-style)

```bash
npm run compute:teammate-elo
```

This reads:
- `out/static-ranklists/*.static.srk.json`
- `out/teammate-map.json`

Output:
- `out/teammate-elo.json`

Rating rule used for each contest:
- Team rank is `rows` index (1-based).
- Every teammate in the team receives the same contest rank and rating delta.

## Build frontend dashboard

```bash
npm run build:elo-frontend
```

Output:
- `out/frontend/index.html`
- `out/frontend/styles.css`
- `out/frontend/app.js`
- `out/frontend/data.js`

You can also run everything in sequence:

```bash
npm run build:elo-dashboard
```
