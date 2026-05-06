# Serendipity Research — Demographic Dashboard
**Version 2026.5.0**

### What's new in v2026.5.0
- **Field browser views** — FEATURED / CATEGORY (12 groups) / ★ PINNED tabs in Display Variable
- **Field pinning** — star any field to pin it for instant access
- **Percentile range slider** — dual-handle slider with BOT/TOP preset buttons replaces manual input
- **Active state summary bar** — shows geography, variable, filters, and feature count at a glance. RESET ALL clears everything.
- **Startup loading screen** — full-screen centered card with logo, progress bar, and 17-step live status list
- **LODES workforce data** — 2023 job counts by workplace location, aggregated to tract level (30+ fields)
- **Composite indices** — 5 pre-built audience profiles scored 0–100 (Economic Anxiety, Latino Engagement, Working Class, Professional Class, Senior Concentration)
- **Audience density tools** — minimum population threshold, minimum count filters, Audience Reach Panel
- **Performance** — AbortController cancels stale requests, debounced renders, threaded Flask, no-cache headers

A dark-terminal GIS dashboard for exploring Texas Census demographic data at the PUMA and Census Tract level, with multi-cycle election results (2020, 2022, 2024), swing analysis, political district overlays, county and district filtering, area-weighted demographic aggregation, percentile filtering, and data export.

---

## Quick Start

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:6001
```

On first start all data is preloaded in a background thread. A progress screen shows each loading step (~2–4 minutes). The dashboard becomes interactive once all steps complete.

---

## Project Structure

```
your-project/
├── app.py                            # Flask backend — all routes, startup, spatial logic
├── requirements.txt
├── README.md
├── CONTINUATION.md                   # Developer handoff document
├── USER_GUIDE.md                     # Strategic communications workflows
├── logo.png                          # Optional — place here to replace title bar text
├── templates/index.html              # Single-page HTML shell
├── static/
│   ├── css/dashboard.css             # Serendipity Research design system (~940 lines)
│   └── js/dashboard.js              # All client-side logic (~1,720 lines)
└── data/
    └── inputs/
        ├── tl_2025_48_puma20/        # Texas PUMA shapefile (217 features)
        ├── tl_2025_48_tract/         # Texas Census Tract shapefile (~6,900 features)
        ├── tl_2025_us_county/        # National county shapefile (filtered to TX=48)
        ├── tl_2025_48_cd119/         # US Congressional Districts 119th (38)
        ├── tl_2025_48_sldl/          # Texas State House Districts (150)
        ├── tl_2025_48_sldu/          # Texas State Senate Districts (31)
        ├── texas_puma_census_data.csv
        ├── texas_tract_census_data.csv
        └── elections/
            ├── 2020/general/
            │   ├── president.csv       # Biden/Trump + minor candidates by VTD
            │   ├── u.s. sen.csv        # Cornyn/Hegar + minor candidates by VTD
            │   └── voter data.csv      # Registration, turnout, Spanish surname by VTD
            ├── 2022/general/
            │   ├── governor.csv        # Abbott/O'Rourke + minor candidates by VTD
            │   └── voter data.csv
            └── 2024/general/
                ├── president.csv       # Harris/Trump + minor candidates by VTD
                ├── u.s. sen.csv        # Cruz/Allred + minor candidates by VTD
                └── voter data.csv
```

---

## Census Data Sources

### Shapefiles (TIGER/Line 2025)

**PUMA** — Public Use Microdata Areas. 100,000+ person geographies, used for ACS microdata. Do not respect county boundaries. Texas has 217.

**Tract** — Census Tracts. Small stable subdivisions of a county (1,200–8,000 people), entirely contained within counties. ~6,900 in Texas.

**County** — National shapefile filtered to Texas at runtime. Used for spatial filtering and as an administrative overlay. 254 counties.

**Congressional, House, Senate** — TIGER/Line 2025 political district boundaries.

### Demographic CSV Data (ACS 5-Year Estimates)

150+ variables across income, age, race/ethnicity, education, employment, occupation, housing, commute, transportation, vehicles, language. Census sentinel values (`-666666666`, `-999999999`, etc.) are replaced with NaN at load time.

### Data Join Logic

| Layer | Shapefile field | CSV field | Strategy |
|---|---|---|---|
| PUMA | `NAMELSAD20` | `NAME` | Strip `"; Texas"` suffix, exact match |
| Tract | `NAMELSAD` | `NAME` | Strip `"; <County>; Texas"` suffix, exact match |

---

## Election Data

### Coverage

| Year | Race | Candidates |
|---|---|---|
| 2024 | Presidential | Harris (D), Trump (R), Oliver (L), Stein (G) |
| 2024 | U.S. Senate | Allred (D), Cruz (R), Brown (L) |
| 2022 | Governor | O'Rourke (D), Abbott (R), Tippetts (L) |
| 2020 | Presidential | Biden (D), Trump (R), Jorgensen (L), Hawkins (G) |
| 2020 | U.S. Senate | Hegar (D), Cornyn (R), McKennon (L) |

All years also include: voter registration, turnout, Spanish surname voter registration, Spanish surname turnout.

### Join Key

All election CSVs join to the VTD shapefile on `VTDKEY` (numeric). All datasets have exactly 9,712 rows matching the VTD shapefile.

### Derived Fields

**Percentages** — computed for each candidate from raw vote totals.

**Margins** — R% minus D% for each race. Positive = Republican-leaning.

**Swing fields (most strategically valuable):**
- `pres_swing_24v20` — Presidential margin change 2020→2024 (positive = R gained)
- `sen_swing_24v20` — Senate margin change 2020→2024
- `gov_pres_22v24` — Governor 2022 → Presidential 2024 margin change
- `turnout_swing_24v20` / `turnout_swing_24v22` — Turnout % change
- `ss_turnout_swing_24v20` — Spanish surname turnout change
- `reg_change_24v20` / `reg_change_24v22` — Voter registration change (raw count)

---

## Features

### Census Layer
Toggle between **PUMA** and **Tract**. Defaults to Tract. Geometry simplified at 0.001° (~100m) for performance.

### Display Variable (Choropleth)
Select any demographic field to color the map. Directional color scales per field. Stats panel (lower-right) shows min, max, median, mean, color scale legend.

### Political / Administrative Overlays
Four types: **US Congress**, **TX House**, **TX Senate**, **County**. Selecting any overlay draws boundaries, enables feature search, filters census layer to features within the selected district/county, and zooms the map. Click any district/county for a full population-weighted demographic profile. District Choropleth mode colors districts by the active display variable.

### 2024 Election Results (VTD Layer)
Toggle **SHOW VTD LAYER** to render 9,712 precinct-level VTDs. Default coloring: Trump vs. Harris margin (red/blue). Select any of 50+ election display fields grouped into: Swing & Trends, Presidential 2024/2020, Senate 2024/2020, Governor 2022, Turnout 2024/2022/2020.

Hover tooltip (0.4s delay): Trump%, Harris%, margin, turnout%, registered voters.
Click: full detail panel with Presidential, Senate, and Turnout results for that VTD.

The election layer respects county and district filters from the overlay section.

### Percentile Filters
Add any field as BOTTOM X% or TOP X% filter chips. All combine with AND logic.

### Hover Tooltip
Census layer: 1 second delay. Shows active display variable as hero value, then top 5 marketing fields. Count fields show percentage-of-total in parentheses.

### Layer Stats Panel
Floating panel (bottom-right) showing features shown vs. total, and choropleth field statistics. Dismissible with ✕.

### Export
Downloads currently visible data (all active filters applied) as CSV or XLSX.

### Logo
Place `logo.png` in project root and restart. Falls back to text if absent.

---

## District Demographic Aggregation

Political district profiles use area-weighted aggregation of tract data. Each tract is intersected with the district polygon in UTM Zone 14N (EPSG:32614). Count fields summed with weights; rate/median fields use population-weighted averages. Precomputed at startup for all 4 overlay types and cached in memory.

---

## Percentage Display

Count fields show `(X%)` in dimmed text alongside raw values throughout the UI. Denominator mappings defined in `PCT_DENOMINATORS` in `dashboard.js`. Covers 23 fields across poverty, housing tenure, employment, education, race/ethnicity, transportation, occupation, and language.

---

## Customising

### Marketing Fields (popups + featured sidebar)
Edit `MARKETING_FIELDS` in `app.py`. Keys = CSV column names, values = display labels.

### Choropleth Color Scales
Edit `CHOROPLETH_SCALES` (census) and `ELECTION_CHOROPLETH_SCALES` (election) in `app.py`.

### Hover Tooltip Fields
Edit `HOVER_FIELDS` in `dashboard.js`.

### Percentage Denominators
Edit `PCT_DENOMINATORS` in `dashboard.js`.

---

## API Reference

| Endpoint | Description |
|---|---|
| `GET /api/startup_status` | Startup progress — steps, current, % complete |
| `GET /api/geojson/<layer>` | GeoJSON with `county`, `filters`, `choropleth_field`, `district_layer`, `district_id` params |
| `GET /api/fields/<layer>` | Field metadata and statistics |
| `GET /api/counties/<layer>` | All 254 Texas counties |
| `GET /api/overlay_names/<key>` | Searchable name list for a political overlay |
| `GET /api/county_bbox/<layer>/<county>` | WGS84 bounding box |
| `GET /api/district_bbox/<layer>/<id>` | WGS84 bounding box for a political district |
| `GET /api/feature/<layer>/<id>` | All fields for a single census feature |
| `GET /api/choropleth_scale/<layer>/<field>` | Color scale hex values |
| `GET /api/political/<key>` | GeoJSON for a political overlay (enriched with aggregated demographics) |
| `GET /api/district/<key>/<id>` | Full demographic profile for a single district |
| `GET /api/district_choropleth/<key>/<field>` | District GeoJSON colored by a field |
| `GET /api/election/fields` | Available election display fields with group labels |
| `GET /api/election/geojson` | VTD GeoJSON with election data (`field`, `county`, `district_layer`, `district_id` params) |
| `GET /api/election/choropleth_scale/<field>` | Election color scale hex values |
| `GET /api/export/<layer>` | Download filtered data (`?format=csv` or `?format=xlsx`) |
| `GET /api/debug/<layer>` | Join key diagnostics |
| `GET /api/overlap_debug/<county>` | PUMA spatial overlap percentages |
| `GET /api/csv_info/<path>` | CSV column/sample inspection |
| `GET /api/shapefile_info/<path>` | Shapefile column/sample inspection |
| `GET /logo.png` | Serves logo.png from project root |

---

## Dependencies

```
flask>=3.0.0
geopandas>=0.14.0
pandas>=2.0.0
numpy>=1.24.0
shapely>=2.0.0
pyproj>=3.6.0
fiona>=1.9.0
openpyxl>=3.1.0
```

Port: **6001**. Runs with `debug=False, use_reloader=False` — restart manually after editing `app.py`.