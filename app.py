"""
Serendipity Research — GIS Demographic Dashboard
Flask backend: preloads all data at startup, area-weighted district aggregation,
demographic profiles for political districts, choropleth, percentile filters.
"""

import os, json, time, threading
import numpy as np
import pandas as pd
import geopandas as gpd
from flask import Flask, jsonify, request, render_template, send_file
from shapely.ops import unary_union

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data", "inputs")

LAYERS = {
    "puma": {
        "shp":           os.path.join(DATA_DIR, "tl_2025_48_puma20", "tl_2025_48_puma20.shp"),
        "csv":           os.path.join(DATA_DIR, "texas_puma_census_data.csv"),
        "shp_join_field":"NAMELSAD20",
        "csv_join_field":"NAME",
        "id_field":      "GEOID20",
        "label":         "PUMA",
    },
    "tract": {
        "shp":           os.path.join(DATA_DIR, "tl_2025_48_tract", "tl_2025_48_tract.shp"),
        "csv":           os.path.join(DATA_DIR, "texas_tract_census_data.csv"),
        "shp_join_field":"NAMELSAD",
        "csv_join_field":"NAME",
        "id_field":      "GEOID",
        "label":         "Census Tract",
    },
}

COUNTY_SHP    = os.path.join(DATA_DIR, "tl_2025_us_county", "tl_2025_us_county.shp")
TEXAS_STATEFP = "48"

POLITICAL_LAYERS = {
    "cd119":   {"shp": os.path.join(DATA_DIR,"tl_2025_48_cd119","tl_2025_48_cd119.shp"),
                "id_field":"GEOID","num_field":"CD119FP","label":"Congressional District","short":"CD"},
    "sldl":    {"shp": os.path.join(DATA_DIR,"tl_2025_48_sldl","tl_2025_48_sldl.shp"),
                "id_field":"GEOID","num_field":"SLDLST","label":"State House District","short":"HD"},
    "sldu":    {"shp": os.path.join(DATA_DIR,"tl_2025_48_sldu","tl_2025_48_sldu.shp"),
                "id_field":"GEOID","num_field":"SLDUST","label":"State Senate District","short":"SD"},
    "county":  {"shp": COUNTY_SHP,
                "id_field":"GEOID","num_field":"COUNTYFP","label":"County","short":"CO",
                "name_field":"NAMELSAD","filter_statefp":"48"},
}

# ---------------------------------------------------------------------------
# Election data — multi-cycle (2020, 2022, 2024 General Elections)
# ---------------------------------------------------------------------------
ELECTION_BASE = os.path.join(DATA_DIR, "elections")
ELECTION_DIR  = os.path.join(ELECTION_BASE, "2024", "general")
ELECTION_2020 = os.path.join(ELECTION_BASE, "2020", "general")
ELECTION_2022 = os.path.join(ELECTION_BASE, "2022", "general")

ELECTION_LAYERS = {
    "vtd": {
        "shp":   os.path.join(ELECTION_DIR, "vtds_24pg", "VTDs_24PG.shp"),
        "label": "VTD (Voting Tabulation District)",
        "short": "VTD",
        "id_field": "VTDKEY",
    }
}

# Derived fields computed from raw vote counts
# Swing/trend fields are computed in _load_election_data after all years are joined
ELECTION_DERIVED = {
    # 2024 Presidential
    "pres_trump_pct":  ("TrumpR_24G_President",  ["TrumpR_24G_President","HarrisD_24G_President","OliverL_24G_President","SteinG_24G_President","Write-InW_24G_President"], "Trump % (Pres 2024)"),
    "pres_harris_pct": ("HarrisD_24G_President", ["TrumpR_24G_President","HarrisD_24G_President","OliverL_24G_President","SteinG_24G_President","Write-InW_24G_President"], "Harris % (Pres 2024)"),
    "pres_margin":     (None, None, "R−D Margin (Pres 2024)"),
    # 2024 Senate
    "sen_cruz_pct":   ("CruzR_24G_U.S. Sen",   ["CruzR_24G_U.S. Sen","AllredD_24G_U.S. Sen","BrownL_24G_U.S. Sen","AndrusW_24G_U.S. Sen","RocheW_24G_U.S. Sen"], "Cruz % (Senate 2024)"),
    "sen_allred_pct": ("AllredD_24G_U.S. Sen", ["CruzR_24G_U.S. Sen","AllredD_24G_U.S. Sen","BrownL_24G_U.S. Sen","AndrusW_24G_U.S. Sen","RocheW_24G_U.S. Sen"], "Allred % (Senate 2024)"),
    "sen_margin":     (None, None, "R−D Margin (Senate 2024)"),
    # 2024 Turnout
    "turnout_pct":         ("Turnout",  ["Voter_Registration"], "Voter Turnout % (2024)"),
    "ss_registration_pct": ("Spanish_Surname_Voter_Registration", ["Voter_Registration"], "Spanish Surname Reg % (2024)"),
    # 2020 Presidential
    "pres20_trump_pct":  ("TrumpR_20G_President",  ["TrumpR_20G_President","BidenD_20G_President","JorgensenL_20G_President","HawkinsG_20G_President","Write-InW_20G_President"], "Trump % (Pres 2020)"),
    "pres20_biden_pct":  ("BidenD_20G_President",  ["TrumpR_20G_President","BidenD_20G_President","JorgensenL_20G_President","HawkinsG_20G_President","Write-InW_20G_President"], "Biden % (Pres 2020)"),
    "pres20_margin":     (None, None, "R−D Margin (Pres 2020)"),
    # 2020 Senate
    "sen20_cornyn_pct": ("CornynR_20G_U.S. Sen", ["CornynR_20G_U.S. Sen","HegarD_20G_U.S. Sen","McKennonL_20G_U.S. Sen","CollinsG_20G_U.S. Sen"], "Cornyn % (Senate 2020)"),
    "sen20_hegar_pct":  ("HegarD_20G_U.S. Sen",  ["CornynR_20G_U.S. Sen","HegarD_20G_U.S. Sen","McKennonL_20G_U.S. Sen","CollinsG_20G_U.S. Sen"], "Hegar % (Senate 2020)"),
    "sen20_margin":     (None, None, "R−D Margin (Senate 2020)"),
    # 2020 Turnout
    "turnout20_pct":        ("Turnout_20",  ["Voter_Registration_20"], "Voter Turnout % (2020)"),
    "ss_reg20_pct":         ("Spanish_Surname_Voter_Registration_20", ["Voter_Registration_20"], "Spanish Surname Reg % (2020)"),
    # 2022 Governor
    "gov22_abbott_pct":  ("AbbottR_22G_Governor",     ["AbbottR_22G_Governor","O'RourkeD_22G_Governor","TippettsL_22G_Governor","BarriosG_22G_Governor","Write-InW_22G_Governor"], "Abbott % (Gov 2022)"),
    "gov22_orourke_pct": ("O'RourkeD_22G_Governor",   ["AbbottR_22G_Governor","O'RourkeD_22G_Governor","TippettsL_22G_Governor","BarriosG_22G_Governor","Write-InW_22G_Governor"], "O'Rourke % (Gov 2022)"),
    "gov22_margin":      (None, None, "R−D Margin (Gov 2022)"),
    # 2022 Turnout
    "turnout22_pct":        ("Turnout_22",  ["Voter_Registration_22"], "Voter Turnout % (2022)"),
    "ss_reg22_pct":         ("Spanish_Surname_Voter_Registration_22", ["Voter_Registration_22"], "Spanish Surname Reg % (2022)"),
    # Swing fields — computed as differences (positive = R gained, negative = D gained)
    "pres_swing_24v20":  (None, None, "Pres Swing R 2020→2024"),   # pres_margin - pres20_margin
    "sen_swing_24v20":   (None, None, "Senate Swing R 2020→2024"),  # sen_margin - sen20_margin
    "gov_pres_22v24":    (None, None, "Gov→Pres Swing R 2022→2024"),# pres_margin - gov22_margin
    # Turnout swing
    "turnout_swing_24v20": (None, None, "Turnout Change 2020→2024"),# turnout_pct - turnout20_pct
    "turnout_swing_24v22": (None, None, "Turnout Change 2022→2024"),# turnout_pct - turnout22_pct
    "ss_turnout_swing_24v20": (None, None, "SS Turnout Change 2020→2024"),
    # Registration change
    "reg_change_24v20":  (None, None, "Registration Change 2020→2024"),# Voter_Registration - Voter_Registration_20
    "reg_change_24v22":  (None, None, "Registration Change 2022→2024"),
}

_election_cache = {}   # "vtd" → GeoDataFrame with all election fields

MARKETING_FIELDS = {
    "median_hh_income":"Median Household Income","per_capita_income":"Per Capita Income",
    "poverty_below":"People Below Poverty","median_home_value":"Median Home Value",
    "median_gross_rent":"Median Gross Rent","total_population":"Total Population",
    "median_age":"Median Age","avg_household_size":"Avg Household Size",
    "race_white":"White (alone)","race_black":"Black / African American",
    "race_asian":"Asian","hispanic":"Hispanic / Latino",
    "edu_bachelors":"Bachelor's Degree","edu_masters":"Master's Degree",
    "edu_professional":"Professional Degree","edu_doctorate":"Doctorate",
    "employed":"Employed","unemployed":"Unemployed","in_labor_force":"In Labor Force",
    "owner_occupied":"Owner-Occupied Units","renter_occupied":"Renter-Occupied Units",
    "housing_units_total":"Total Housing Units","transport_car_alone":"Drive Alone to Work",
    "transport_public_transit":"Public Transit","transport_wfh":"Work From Home",
    "occ_mgmt_business":"Management / Business","occ_service":"Service Occupations",
    "occ_production":"Production / Manufacturing",
    "lang_english_only":"English Only","lang_spanish":"Spanish",
}

SUM_FIELDS = {
    "total_population","poverty_below","employed","unemployed","in_labor_force",
    "civilian_labor_force","not_in_labor_force","owner_occupied","renter_occupied",
    "housing_units_total","occupied_units_total","households_total","family_households",
    "nonfamily_households","race_white","race_black","race_aian","race_asian","race_nhpi",
    "race_other","race_two_plus","hispanic","not_hispanic","lang_english_only","lang_spanish",
    "lang_french_creole","lang_german","lang_russian","lang_other_indoeuro","lang_korean",
    "lang_chinese","lang_vietnamese","lang_tagalog","lang_arabic","lang_other_asian","lang_other",
    "edu_bachelors","edu_masters","edu_professional","edu_doctorate",
    "transport_car_alone","transport_carpool","transport_public_transit","transport_wfh",
    "transport_walked","transport_other","occ_mgmt_business","occ_service","occ_sales_office",
    "occ_construction","occ_production",
}

CHOROPLETH_SCALES = {
    "median_hh_income":["#cc2200","#2255cc"],"per_capita_income":["#cc2200","#2255cc"],
    "poverty_below":["#2255cc","#cc2200"],"median_home_value":["#cc2200","#2255cc"],
    "total_population":["#1a3a1a","#4a9a4a"],"median_age":["#1a2a4a","#4477dd"],
    "unemployed":["#2255cc","#cc2200"],"owner_occupied":["#cc2200","#2255cc"],
    "renter_occupied":["#2255cc","#cc2200"],"hispanic":["#1a1a3a","#7755cc"],
    "race_white":["#1a2a4a","#4477dd"],"race_black":["#1a2a1a","#44aa88"],
    "race_asian":["#1a1a2a","#6677dd"],
}

# Startup progress
_startup_status = {"ready":False,"error":None,"steps":[],"current":None,"pct":0}

def _step(label, action="start", note=""):
    if action == "start":
        _startup_status["current"] = label
        for s in _startup_status["steps"]:
            if s["label"] == label: s["status"] = "running"
        print(f"[STARTUP] {label}...")
    elif action == "done":
        for s in _startup_status["steps"]:
            if s["label"] == label:
                s["status"] = "done"
                if note: s["note"] = note
        done  = sum(1 for s in _startup_status["steps"] if s["status"]=="done")
        total = len(_startup_status["steps"])
        _startup_status["pct"] = int(done/total*100)
        print(f"[STARTUP] ✓ {label}" + (f" — {note}" if note else ""))
    elif action == "error":
        for s in _startup_status["steps"]:
            if s["label"] == label:
                s["status"] = "error"
                s["note"]   = note
        _startup_status["error"] = f"{label}: {note}"
        print(f"[STARTUP] ✗ {label}: {note}")

# Data stores
_cache            = {}
_county_cache     = {}
_political_cache  = {}
_district_agg     = {}
_district_geojson = {}

def _gdf_to_geojson(gdf, simplify_tolerance=None):
    """Fast GeoDataFrame → GeoJSON dict. Optionally simplifies geometry to reduce payload."""
    sub = gdf.copy()
    if simplify_tolerance:
        sub["geometry"] = sub.geometry.simplify(simplify_tolerance, preserve_topology=True)
    non_geom = [c for c in sub.columns if c != "geometry"]
    num_cols  = [c for c in non_geom if pd.api.types.is_numeric_dtype(sub[c])]
    str_cols  = [c for c in non_geom if c not in num_cols]
    if num_cols:
        sub[num_cols] = sub[num_cols].astype(object).where(sub[num_cols].notna(), other=None)
    if str_cols:
        sub[str_cols] = sub[str_cols].astype(object).where(sub[str_cols].notna(), other=None)
    return json.loads(sub.to_json())

# Census Bureau sentinel values indicating suppressed / unavailable data
CENSUS_SENTINELS = {-666666666, -999999999, -333333333, -222222222}

def _clean_sentinels(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Replace Census null sentinel values with NaN so they don't corrupt stats."""
    num_cols = [c for c in gdf.columns if c != "geometry" and pd.api.types.is_numeric_dtype(gdf[c])]
    for col in num_cols:
        mask = gdf[col].isin(CENSUS_SENTINELS)
        if mask.any():
            gdf[col] = gdf[col].where(~mask, other=np.nan)
    return gdf

def _join_layer(gdf, df, cfg):
    gdf[cfg["shp_join_field"]] = gdf[cfg["shp_join_field"]].astype(str).str.strip()
    df[cfg["csv_join_field"]]  = df[cfg["csv_join_field"]].astype(str).str.strip()
    df["_join_key"] = df[cfg["csv_join_field"]].str.replace(r";.*$","",regex=True).str.strip()
    df["_county"]   = df[cfg["csv_join_field"]].str.extract(r";\s*([^;]+);",expand=False).str.strip()
    gdf = gdf.merge(df, left_on=cfg["shp_join_field"], right_on="_join_key", how="left")
    if "_join_key" in gdf.columns: gdf = gdf.drop(columns=["_join_key"])
    # Remove Census sentinel values (suppressed/unavailable data flags)
    gdf = _clean_sentinels(gdf)
    return gdf

def aggregate_tracts_to_districts(tract_gdf, district_gdf, id_field, name_field="NAMELSAD"):
    t_proj = tract_gdf.to_crs(epsg=32614).copy()
    d_proj = district_gdf.to_crs(epsg=32614).copy()
    num_cols  = [c for c in t_proj.columns if c!="geometry" and pd.api.types.is_numeric_dtype(t_proj[c])]
    sum_fields= [c for c in num_cols if c in SUM_FIELDS]
    avg_fields= [c for c in num_cols if c not in SUM_FIELDS and c!="total_population"]
    results   = {}
    total     = len(d_proj)
    for i, (_, dist_row) in enumerate(d_proj.iterrows(), 1):
        dist_id   = str(dist_row[id_field])
        dist_name = str(dist_row.get(name_field, dist_id))
        dist_poly = dist_row.geometry
        # Progress note every 10 districts
        if i % 10 == 0 or i == total:
            _startup_status["current"] = f"Aggregating {i}/{total} districts"
        candidates = t_proj[t_proj.geometry.intersects(dist_poly)]
        if candidates.empty: continue
        clipped = candidates.copy()
        clipped["_inter"] = clipped.geometry.intersection(dist_poly)
        clipped = clipped[~clipped["_inter"].is_empty]
        if clipped.empty: continue
        clipped["_w"] = (clipped["_inter"].area / clipped.geometry.area.replace(0, np.nan)).fillna(0)
        agg = {"_name": dist_name, "_district_id": dist_id}
        for f in sum_fields:
            agg[f] = float((clipped[f].fillna(0) * clipped["_w"]).sum())
        pop = clipped.get("total_population", pd.Series(np.ones(len(clipped)))).fillna(0)
        wpop = (pop * clipped["_w"]).fillna(0)
        twpop = wpop.sum()
        for f in avg_fields:
            col = clipped[f].fillna(0)
            agg[f] = float((col * wpop).sum() / twpop) if twpop > 0 else float(col.mean()) if len(col) else 0.0
        results[dist_id] = agg
    return results

STARTUP_STEPS = [
    "Load county boundaries",
    "Load PUMA shapefile","Load PUMA demographics","Join PUMA data",
    "Load tract shapefile","Load tract demographics","Join tract data",
    "Load congressional districts","Load state house districts","Load state senate districts",
    "Aggregate tracts → congressional districts",
    "Aggregate tracts → state house districts",
    "Aggregate tracts → state senate districts",
    "Aggregate tracts → counties",
    "Build district GeoJSON",
    "Load election data",
    "Ready",
]

def _load_election_data():
    """Load VTD shapefile and join all election CSVs (2020, 2022, 2024), compute derived and swing fields."""
    cfg = ELECTION_LAYERS["vtd"]
    if not os.path.exists(cfg["shp"]):
        print("[STARTUP] Election shapefile not found, skipping.")
        return

    gdf = gpd.read_file(cfg["shp"]).to_crs(epsg=4326)

    def safe_div(num, denom):
        return np.where(denom > 0, num / denom * 100, np.nan)

    def load_csvs(base_dir, suffix="", rename_voter=False):
        """Load all CSVs from an election directory, merging onto gdf."""
        nonlocal gdf
        files = {
            "president":  os.path.join(base_dir, "president.csv"),
            "senate":     os.path.join(base_dir, "u.s. sen.csv"),
            "governor":   os.path.join(base_dir, "governor.csv"),
            "voter_data": os.path.join(base_dir, "voter data.csv"),
        }
        for name, path in files.items():
            if not os.path.exists(path):
                continue
            df = pd.read_csv(path)
            df = df.drop(columns=[c for c in ["CNTYVTD"] if c in df.columns])
            # Rename voter data columns to avoid collision across years
            if name == "voter_data" and suffix:
                rename = {
                    "Voter_Registration":                f"Voter_Registration{suffix}",
                    "Turnout":                           f"Turnout{suffix}",
                    "Spanish_Surname_Voter_Registration":f"Spanish_Surname_Voter_Registration{suffix}",
                    "Spanish_Surname_Turnout":           f"Spanish_Surname_Turnout{suffix}",
                }
                df = df.rename(columns=rename)
            gdf = gdf.merge(df, on="VTDKEY", how="left")

    # Load all years (2024 voter data keeps original names for backward compat)
    load_csvs(ELECTION_DIR,  suffix="")    # 2024
    load_csvs(ELECTION_2020, suffix="_20") # 2020
    load_csvs(ELECTION_2022, suffix="_22") # 2022

    # ── Compute percentage fields ─────────────────────────────────────────
    for fname, (num_col, denom_cols, label) in ELECTION_DERIVED.items():
        if num_col is None or denom_cols is None:
            continue  # swing/margin fields computed below
        if num_col not in gdf.columns:
            continue
        denom_present = [c for c in denom_cols if c in gdf.columns]
        if denom_present:
            denom = gdf[denom_present].sum(axis=1)
            gdf[fname] = safe_div(gdf[num_col].fillna(0), denom)

    # ── Margin fields (R% - D%) ───────────────────────────────────────────
    margin_pairs = [
        ("pres_margin",    "pres_trump_pct",   "pres_harris_pct"),
        ("pres20_margin",  "pres20_trump_pct",  "pres20_biden_pct"),
        ("sen_margin",     "sen_cruz_pct",      "sen_allred_pct"),
        ("sen20_margin",   "sen20_cornyn_pct",  "sen20_hegar_pct"),
        ("gov22_margin",   "gov22_abbott_pct",  "gov22_orourke_pct"),
    ]
    for out, r_col, d_col in margin_pairs:
        if r_col in gdf.columns and d_col in gdf.columns:
            gdf[out] = gdf[r_col] - gdf[d_col]

    # ── Swing fields (2024 margin minus earlier margin) ───────────────────
    # Positive = R gained ground; Negative = D gained ground
    swing_pairs = [
        ("pres_swing_24v20",    "pres_margin",   "pres20_margin"),
        ("sen_swing_24v20",     "sen_margin",    "sen20_margin"),
        ("gov_pres_22v24",      "pres_margin",   "gov22_margin"),
    ]
    for out, new_col, old_col in swing_pairs:
        if new_col in gdf.columns and old_col in gdf.columns:
            gdf[out] = gdf[new_col] - gdf[old_col]

    # ── Turnout swing ─────────────────────────────────────────────────────
    if "turnout_pct" in gdf.columns and "turnout20_pct" in gdf.columns:
        gdf["turnout_swing_24v20"] = gdf["turnout_pct"] - gdf["turnout20_pct"]
    if "turnout_pct" in gdf.columns and "turnout22_pct" in gdf.columns:
        gdf["turnout_swing_24v24"] = gdf["turnout_pct"] - gdf["turnout22_pct"]

    # ── Spanish surname turnout swing ─────────────────────────────────────
    if "ss_turnout_pct" in gdf.columns and "Spanish_Surname_Turnout_20" in gdf.columns:
        gdf["ss_turnout_swing_24v20"] = gdf["ss_turnout_pct"] - (gdf["Spanish_Surname_Turnout_20"] * 100)

    # ── Total votes ───────────────────────────────────────────────────────
    for year, tag in [("24", "pres_total_votes"), ("20", "pres20_total_votes"), ("22", "gov22_total_votes")]:
        cols = [c for c in gdf.columns if f"{year}G_" in c and ("President" in c or "Governor" in c)]
        if cols:
            gdf[tag] = gdf[cols].sum(axis=1)
    for year, tag in [("24", "sen_total_votes"), ("20", "sen20_total_votes")]:
        cols = [c for c in gdf.columns if f"{year}G_U.S." in c]
        if cols:
            gdf[tag] = gdf[cols].sum(axis=1)

    # ── Registration change ───────────────────────────────────────────────
    if "Voter_Registration" in gdf.columns and "Voter_Registration_20" in gdf.columns:
        gdf["reg_change_24v20"] = gdf["Voter_Registration"] - gdf["Voter_Registration_20"]
    if "Voter_Registration" in gdf.columns and "Voter_Registration_22" in gdf.columns:
        gdf["reg_change_24v22"] = gdf["Voter_Registration"] - gdf["Voter_Registration_22"]

    # ── Spanish surname turnout pct (2024) ────────────────────────────────
    if "Spanish_Surname_Turnout" in gdf.columns:
        gdf["ss_turnout_pct"] = gdf["Spanish_Surname_Turnout"] * 100

    _election_cache["vtd"] = gdf
    print(f"[STARTUP] Election data: {len(gdf)} VTDs, {len(gdf.columns)} fields loaded across 2020/2022/2024")


def _run_startup():
    _startup_status["steps"] = [{"label":s,"status":"pending"} for s in STARTUP_STEPS]
    try:
        _step("Load county boundaries")
        cgdf = gpd.read_file(COUNTY_SHP)
        cgdf = cgdf[cgdf["STATEFP"]==TEXAS_STATEFP].to_crs(epsg=32614)
        cgdf["_county_name"] = cgdf["NAMELSAD"].str.strip()
        _county_cache["_all_counties_gdf"] = cgdf
        _step("Load county boundaries","done",f"{len(cgdf)} counties")

        # PUMA
        _step("Load PUMA shapefile")
        cfg = LAYERS["puma"]
        puma_shp = gpd.read_file(cfg["shp"]).to_crs(epsg=4326)
        _step("Load PUMA shapefile","done",f"{len(puma_shp)} features")

        _step("Load PUMA demographics")
        puma_df = pd.read_csv(cfg["csv"])
        _step("Load PUMA demographics","done",f"{len(puma_df)} rows")

        _step("Join PUMA data")
        puma_gdf = _join_layer(puma_shp, puma_df, cfg)
        _cache["puma"] = puma_gdf
        matched = puma_gdf[list(MARKETING_FIELDS)[0]].notna().sum()
        _step("Join PUMA data","done",f"{matched}/{len(puma_gdf)} matched")

        # Tract
        _step("Load tract shapefile")
        cfg = LAYERS["tract"]
        tract_shp = gpd.read_file(cfg["shp"]).to_crs(epsg=4326)
        _step("Load tract shapefile","done",f"{len(tract_shp)} features")

        _step("Load tract demographics")
        tract_df = pd.read_csv(cfg["csv"])
        _step("Load tract demographics","done",f"{len(tract_df)} rows")

        _step("Join tract data")
        tract_gdf = _join_layer(tract_shp, tract_df, cfg)
        _cache["tract"] = tract_gdf
        matched = tract_gdf[list(MARKETING_FIELDS)[0]].notna().sum()
        _step("Join tract data","done",f"{matched}/{len(tract_gdf)} matched")

        # Political shapefiles
        for key, label in [("cd119","Load congressional districts"),
                            ("sldl","Load state house districts"),
                            ("sldu","Load state senate districts")]:
            _step(label)
            pcfg = POLITICAL_LAYERS[key]
            pgdf = gpd.read_file(pcfg["shp"]).to_crs(epsg=4326)
            keep = [f for f in ["geometry",pcfg["id_field"],pcfg["num_field"],"NAMELSAD"] if f in pgdf.columns]
            _political_cache[key] = {"gdf": pgdf[keep].copy()}
            _step(label,"done",f"{len(pgdf)} districts")

        # County overlay — reuse already-loaded county GDF from _county_cache
        _step("Load county boundaries","done")   # already done — just wire it up
        cgdf_4326 = _county_cache["_all_counties_gdf"].to_crs(epsg=4326).copy()
        keep = [f for f in ["geometry","GEOID","COUNTYFP","NAMELSAD","NAMELSAD"] if f in cgdf_4326.columns]
        # NAMELSAD for counties is e.g. "Bexar County" — perfect display name
        _political_cache["county"] = {"gdf": cgdf_4326[list(dict.fromkeys(
            [f for f in ["geometry","GEOID","COUNTYFP","NAMELSAD"] if f in cgdf_4326.columns]
        ))].copy()}

        # Aggregations
        for key, label in [("cd119","Aggregate tracts → congressional districts"),
                            ("sldl","Aggregate tracts → state house districts"),
                            ("sldu","Aggregate tracts → state senate districts"),
                            ("county","Aggregate tracts → counties")]:
            _step(label)
            pcfg = POLITICAL_LAYERS[key]
            pgdf = _political_cache[key]["gdf"]
            t0   = time.time()
            agg  = aggregate_tracts_to_districts(
                tract_gdf=_cache["tract"], district_gdf=pgdf,
                id_field=pcfg["id_field"], name_field="NAMELSAD")
            _district_agg[key] = agg
            _step(label,"done",f"{len(agg)} districts in {time.time()-t0:.1f}s")

        # Build enriched GeoJSON
        _step("Build district GeoJSON")
        for key, pcfg in POLITICAL_LAYERS.items():
            pgdf = _political_cache[key]["gdf"].copy()
            agg  = _district_agg.get(key,{})
            id_f = pcfg["id_field"]
            for mf in MARKETING_FIELDS:
                pgdf[mf] = pgdf[id_f].astype(str).map(lambda i,mf=mf: agg.get(i,{}).get(mf))
            for mf in MARKETING_FIELDS:
                col = pgdf[mf]
                if pd.api.types.is_numeric_dtype(col) and col.notna().any():
                    pgdf[f"__pct_{mf}"] = col.rank(pct=True)*100
            _district_geojson[key] = _gdf_to_geojson(pgdf)
        _step("Build district GeoJSON","done")

        # Election data
        _step("Load election data")
        _load_election_data()
        _step("Load election data","done","VTDs with election results")

        _step("Ready")
        _step("Ready","done","all data preloaded")
        _startup_status["ready"] = True
        _startup_status["pct"]   = 100

    except Exception as e:
        import traceback
        tb  = traceback.format_exc()
        cur = _startup_status.get("current","unknown")
        _step(cur,"error",str(e))
        print(f"[STARTUP FATAL]\n{tb}")

# ── Helpers ────────────────────────────────────────────────────────────────────

def load_layer(name):
    if name not in _cache: raise RuntimeError(f"Layer '{name}' not loaded")
    return _cache[name]

def load_county_polygon(county_name):
    if county_name in _county_cache: return _county_cache[county_name]
    cgdf = _county_cache.get("_all_counties_gdf")
    if cgdf is None: return None
    row  = cgdf[cgdf["_county_name"]==county_name]
    poly = row.geometry.union_all() if not row.empty else None
    _county_cache[county_name] = poly
    return poly

def _require_ready():
    if not _startup_status["ready"]:
        msg = _startup_status.get("error") or "Server is still initializing"
        return jsonify({"error": msg, "ready": False}), 503
    return None

def compute_percentiles(gdf, field):
    return gdf[field].rank(pct=True)*100

def get_numeric_fields(layer_name):
    gdf = load_layer(layer_name)
    return [c for c in gdf.columns if c!="geometry" and pd.api.types.is_numeric_dtype(gdf[c])]

def gdf_to_geojson(gdf, fields=None, simplify_tolerance=None):
    if fields:
        keep = ["geometry"] + [f for f in fields if f in gdf.columns]
        sub  = gdf[keep].copy()
    else:
        sub = gdf.copy()
    return _gdf_to_geojson(sub, simplify_tolerance=simplify_tolerance)

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index(): return render_template("index.html")

@app.route("/logo.png")
def logo():
    """Serve logo.png from project root if it exists, else 404."""
    import flask
    logo_path = os.path.join(BASE_DIR, "logo.png")
    if os.path.exists(logo_path):
        return flask.send_file(logo_path, mimetype="image/png")
    return flask.abort(404)

@app.route("/api/startup_status")
def api_startup_status():
    return jsonify({
        "ready":   _startup_status["ready"],
        "error":   _startup_status["error"],
        "steps":   _startup_status["steps"],
        "current": _startup_status["current"],
        "pct":     _startup_status["pct"],
    })

@app.route("/api/fields/<layer_name>")
def api_fields(layer_name):
    if (e:=_require_ready()): return e
    if layer_name not in LAYERS: return jsonify({"error":"unknown layer"}),400
    gdf = load_layer(layer_name)
    all_n = get_numeric_fields(layer_name)
    mkt   = [{"field":k,"label":v,"featured":True} for k,v in MARKETING_FIELDS.items() if k in gdf.columns]
    fk    = {m["field"] for m in mkt}
    ext   = [{"field":f,"label":f.replace("_"," ").title(),"featured":False} for f in all_n if f not in fk]
    stats = {}
    for f in all_n:
        s = gdf[f].dropna()
        if len(s): stats[f]={"min":float(s.min()),"max":float(s.max()),"mean":float(s.mean()),
                              "p25":float(s.quantile(.25)),"p50":float(s.quantile(.50)),"p75":float(s.quantile(.75))}
    return jsonify({"marketing_fields":mkt,"extended_fields":ext,"stats":stats})

@app.route("/api/geojson/<layer_name>")
def api_geojson(layer_name):
    if (e:=_require_ready()): return e
    if layer_name not in LAYERS: return jsonify({"error":"unknown layer"}),400
    gdf = load_layer(layer_name).copy()
    cfg = LAYERS[layer_name]

    filters_raw = request.args.get("filters")
    if filters_raw:
        try: filters=json.loads(filters_raw)
        except: filters=[]
        for f in filters:
            field=f.get("field"); op=f.get("operator","lte")
            try: val=float(f.get("value",50))
            except: continue
            if not (1<=val<=100) or field not in gdf.columns: continue
            pct = compute_percentiles(gdf,field)
            gdf = gdf[pct<=val] if op=="lte" else gdf[pct>=(100-val)]

    county = request.args.get("county")
    if county:
        if layer_name=="puma":
            cp = load_county_polygon(county)
            if cp is not None:
                pp = gdf.to_crs(epsg=32614)
                ov = pp.geometry.apply(lambda g: g.intersection(cp).area/g.area if g.area else 0)
                gdf = gdf[ov>=0.10]
        elif "_county" in gdf.columns:
            gdf = gdf[gdf["_county"]==county]

    # --- District filter (congressional / state house / senate) ---
    district_layer = request.args.get("district_layer")
    district_id    = request.args.get("district_id")
    if district_layer and district_id and district_layer in POLITICAL_LAYERS:
        pcfg = POLITICAL_LAYERS[district_layer]
        pgdf = _political_cache.get(district_layer, {}).get("gdf")
        if pgdf is not None:
            dist_row = pgdf[pgdf[pcfg["id_field"]].astype(str) == str(district_id)]
            if not dist_row.empty:
                dist_poly_proj = dist_row.to_crs(epsg=32614).geometry.union_all()
                layer_proj = gdf.to_crs(epsg=32614)
                # Use centroid for tracts (fast, accurate enough for district containment)
                # Use area overlap for PUMAs (they straddle boundaries)
                if layer_name == "tract":
                    centroids = layer_proj.geometry.centroid
                    mask = centroids.within(dist_poly_proj)
                else:
                    mask = layer_proj.geometry.apply(
                        lambda g: g.intersection(dist_poly_proj).area / g.area >= 0.10
                        if g.area else False
                    )
                gdf = gdf[mask]

    cf = request.args.get("choropleth_field")
    if cf and cf in gdf.columns:
        rank_map = compute_percentiles(load_layer(layer_name), cf)
        gdf[f"__pct_{cf}"] = gdf.index.map(rank_map)

    inc = [cfg["id_field"],cfg["shp_join_field"]]+[k for k in MARKETING_FIELDS if k in gdf.columns]
    if cf and cf in gdf.columns: inc+=[cf,f"__pct_{cf}"]
    # Simplify tract geometry to cut payload ~70% with no visible quality loss at TX zoom
    tol = 0.001 if layer_name == "tract" else None
    return jsonify(gdf_to_geojson(gdf, list(dict.fromkeys(inc)), simplify_tolerance=tol))

@app.route("/api/feature/<layer_name>/<feature_id>")
def api_feature(layer_name, feature_id):
    if (e:=_require_ready()): return e
    if layer_name not in LAYERS: return jsonify({"error":"unknown layer"}),400
    cfg = LAYERS[layer_name]; gdf = load_layer(layer_name)
    row = gdf[gdf[cfg["id_field"]].astype(str)==str(feature_id)]
    if row.empty: return jsonify({"error":"not found"}),404
    row = row.iloc[0]
    data={}
    for col in gdf.columns:
        if col=="geometry": continue
        val=row[col]
        try:
            if pd.isna(val): data[col]=None; continue
        except: pass
        data[col]=int(val) if isinstance(val,np.integer) else float(val) if isinstance(val,np.floating) else val
    return jsonify({"id":feature_id,"marketing":{k:data.get(k) for k in MARKETING_FIELDS if k in data},
                    "all_fields":data,"labels":MARKETING_FIELDS})

@app.route("/api/counties/<layer_name>")
def api_counties(layer_name):
    """County names for the overlay selector — always from real county shapefile."""
    if (e:=_require_ready()): return e
    cgdf = _county_cache.get("_all_counties_gdf")
    if cgdf is not None:
        return jsonify({"counties":sorted(cgdf["_county_name"].dropna().unique().tolist())})
    gdf = load_layer("tract")
    return jsonify({"counties":sorted(gdf["_county"].dropna().unique().tolist()) if "_county" in gdf.columns else []})

@app.route("/api/overlay_names/<layer_key>")
def api_overlay_names(layer_key):
    """
    Return searchable names for a political/administrative overlay layer.
    Used to populate the unified overlay search dropdown.
    """
    if (e:=_require_ready()): return e
    if layer_key not in POLITICAL_LAYERS: return jsonify({"error":"unknown layer"}),400
    agg = _district_agg.get(layer_key, {})
    names = sorted([v.get("_name","") for v in agg.values() if v.get("_name")])
    # For county, also return the GEOID→name map for filtering
    id_map = {did: v.get("_name","") for did, v in agg.items()}
    return jsonify({"names": names, "id_map": id_map})

@app.route("/api/district_bbox/<political_layer>/<district_id>")
def api_district_bbox(political_layer, district_id):
    """Return WGS84 bounding box for a specific political district."""
    if (e:=_require_ready()): return e
    if political_layer not in POLITICAL_LAYERS: return jsonify({"error":"unknown layer"}),400
    pcfg = POLITICAL_LAYERS[political_layer]
    pgdf = _political_cache.get(political_layer,{}).get("gdf")
    if pgdf is None: return jsonify({"error":"layer not loaded"}),500
    row = pgdf[pgdf[pcfg["id_field"]].astype(str)==str(district_id)]
    if row.empty: return jsonify({"error":"district not found"}),404
    b = row.total_bounds  # [minx, miny, maxx, maxy] in WGS84
    return jsonify({"south":float(b[1]),"west":float(b[0]),"north":float(b[3]),"east":float(b[2])})


@app.route("/api/county_bbox/<layer_name>/<path:county>")
def api_county_bbox(layer_name, county):
    if (e:=_require_ready()): return e
    cp = load_county_polygon(county)
    if cp is not None:
        import pyproj
        tr = pyproj.Transformer.from_crs("EPSG:32614","EPSG:4326",always_xy=True)
        x0,y0,x1,y1 = cp.bounds
        w,s = tr.transform(x0,y0); e2,n = tr.transform(x1,y1)
        return jsonify({"south":s,"west":w,"north":n,"east":e2})
    gdf = load_layer(layer_name)
    sub = gdf[gdf["_county"]==county] if "_county" in gdf.columns else gdf.iloc[0:0]
    if sub.empty: return jsonify({"error":"not found"}),404
    b = sub.total_bounds
    return jsonify({"south":float(b[1]),"west":float(b[0]),"north":float(b[3]),"east":float(b[2])})

@app.route("/api/choropleth_scale/<layer_name>/<field>")
def api_choropleth_scale(layer_name, field):
    s = CHOROPLETH_SCALES.get(field,["#1a3060","#4477dd"])
    return jsonify({"low":s[0],"high":s[1]})

@app.route("/api/political/<layer_key>")
def api_political(layer_key):
    if (e:=_require_ready()): return e
    if layer_key not in POLITICAL_LAYERS: return jsonify({"error":"unknown layer"}),400
    return jsonify(_district_geojson[layer_key])

@app.route("/api/political_info")
def api_political_info():
    return jsonify({k:{"label":v["label"],"short":v["short"]} for k,v in POLITICAL_LAYERS.items()})

@app.route("/api/district/<layer_key>/<district_id>")
def api_district(layer_key, district_id):
    if (e:=_require_ready()): return e
    if layer_key not in POLITICAL_LAYERS: return jsonify({"error":"unknown layer"}),400
    row = _district_agg.get(layer_key,{}).get(district_id)
    if row is None: return jsonify({"error":"district not found"}),404
    return jsonify({
        "district_id": district_id,
        "name":        row.get("_name",district_id),
        "layer":       layer_key,
        "label":       POLITICAL_LAYERS[layer_key]["label"],
        "marketing":   {k:row.get(k) for k in MARKETING_FIELDS if k in row},
        "all_fields":  {k:v for k,v in row.items() if not k.startswith("_")},
        "labels":      MARKETING_FIELDS,
    })

@app.route("/api/district_choropleth/<layer_key>/<field>")
def api_district_choropleth(layer_key, field):
    if (e:=_require_ready()): return e
    if layer_key not in POLITICAL_LAYERS: return jsonify({"error":"unknown layer"}),400
    pgdf = _political_cache[layer_key]["gdf"].copy()
    agg  = _district_agg.get(layer_key,{})
    id_f = POLITICAL_LAYERS[layer_key]["id_field"]
    pgdf[field]  = pd.to_numeric(pgdf[id_f].astype(str).map(lambda i: agg.get(i,{}).get(field)), errors="coerce")
    pgdf[f"__pct_{field}"] = pgdf[field].rank(pct=True)*100
    pgdf["_name"] = pgdf[id_f].astype(str).map(lambda i: agg.get(i,{}).get("_name",i))
    keep = [c for c in ["geometry",id_f,"NAMELSAD","_name",field,f"__pct_{field}"] if c in pgdf.columns]
    return jsonify(_gdf_to_geojson(pgdf[keep]))

@app.route("/api/export/<layer_name>")
def api_export(layer_name):
    if (e:=_require_ready()): return e
    if layer_name not in LAYERS: return jsonify({"error":"unknown layer"}),400
    import io
    gdf = load_layer(layer_name).copy(); cfg = LAYERS[layer_name]
    filters_raw = request.args.get("filters")
    if filters_raw:
        try: filters=json.loads(filters_raw)
        except: filters=[]
        for f in filters:
            field=f.get("field"); op=f.get("operator","lte")
            try: val=float(f.get("value",50))
            except: continue
            if not (1<=val<=100) or field not in gdf.columns: continue
            pct=compute_percentiles(gdf,field)
            gdf=gdf[pct<=val] if op=="lte" else gdf[pct>=(100-val)]
    county=request.args.get("county")
    if county:
        if layer_name=="puma":
            cp=load_county_polygon(county)
            if cp is not None:
                pp=gdf.to_crs(epsg=32614)
                ov=pp.geometry.apply(lambda g: g.intersection(cp).area/g.area if g.area else 0)
                gdf=gdf[ov>=0.10]
        elif "_county" in gdf.columns: gdf=gdf[gdf["_county"]==county]
    df=pd.DataFrame(gdf.drop(columns=["geometry"],errors="ignore"))
    df=df.drop(columns=[c for c in df.columns if c.startswith("__pct_")],errors="ignore")
    fmt=request.args.get("format","csv")
    if fmt=="xlsx":
        buf=io.BytesIO()
        with pd.ExcelWriter(buf,engine="openpyxl") as w: df.to_excel(w,index=False,sheet_name=layer_name.upper())
        buf.seek(0)
        return send_file(buf,mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         as_attachment=True,download_name=f"{layer_name}_export.xlsx")
    buf=io.StringIO(); df.to_csv(buf,index=False)
    return send_file(io.BytesIO(buf.getvalue().encode()),mimetype="text/csv",
                     as_attachment=True,download_name=f"{layer_name}_export.csv")

@app.route("/api/csv_info/<path:rel>")
def api_csv_info(rel):
    """Inspect columns and sample rows of any CSV under data/inputs."""
    path = os.path.join(DATA_DIR, rel)
    if not os.path.exists(path):
        return jsonify({"error": f"Not found: {path}"}), 404
    df = pd.read_csv(path, nrows=5)
    full_len = sum(1 for _ in open(path)) - 1
    return jsonify({
        "columns": list(df.columns),
        "row_count": full_len,
        "samples": df.head(3).to_dict(orient="records"),
    })

#
# @app.route("/api/csv_info/<path:rel>")
# def api_csv_info(rel):
#     """Inspect columns and sample rows of any CSV under data/inputs."""
#     path = os.path.join(DATA_DIR, rel)
#     if not os.path.exists(path):
#         return jsonify({"error": f"Not found: {path}"}), 404
#     df = pd.read_csv(path, nrows=5)
#     full_len = sum(1 for _ in open(path)) - 1
#     return jsonify({
#         "columns": list(df.columns),
#         "row_count": full_len,
#         "samples": df.head(3).to_dict(orient="records"),
#     })

#
# @app.route("/api/shapefile_info/<path:rel>")
# def api_shapefile_info(rel):
#     p=os.path.join(DATA_DIR,rel)
#     if not os.path.exists(p): return jsonify({"error":"not found"}),404
#     gdf=gpd.read_file(p)
#     rows=[{k:str(v) for k,v in r.items() if k!="geometry"} for _,r in gdf.head(5).iterrows()]
#     return jsonify({"columns":list(gdf.columns),"feature_count":len(gdf),"samples":rows})

# ── Election routes ────────────────────────────────────────────────────────────

# Election display fields for UI — ordered by analytical usefulness
ELECTION_DISPLAY_FIELDS = [
    # ── Swing / Trend (most strategically useful — shown first) ──────────
    {"field": "pres_swing_24v20",      "label": "Pres Swing R 2020→2024",       "group": "Swing & Trends"},
    {"field": "sen_swing_24v20",       "label": "Senate Swing R 2020→2024",     "group": "Swing & Trends"},
    {"field": "gov_pres_22v24",        "label": "Gov→Pres Swing R 2022→2024",   "group": "Swing & Trends"},
    {"field": "turnout_swing_24v20",   "label": "Turnout Change 2020→2024",     "group": "Swing & Trends"},
    {"field": "turnout_swing_24v24",   "label": "Turnout Change 2022→2024",     "group": "Swing & Trends"},
    {"field": "ss_turnout_swing_24v20","label": "SS Turnout Change 2020→2024",  "group": "Swing & Trends"},
    {"field": "reg_change_24v20",      "label": "Registration Change 2020→2024","group": "Swing & Trends"},
    {"field": "reg_change_24v22",      "label": "Registration Change 2022→2024","group": "Swing & Trends"},
    # ── Presidential 2024 ────────────────────────────────────────────────
    {"field": "pres_trump_pct",        "label": "Trump % (Pres 2024)",          "group": "Presidential 2024"},
    {"field": "pres_harris_pct",       "label": "Harris % (Pres 2024)",         "group": "Presidential 2024"},
    {"field": "pres_margin",           "label": "R−D Margin (Pres 2024)",       "group": "Presidential 2024"},
    {"field": "pres_total_votes",      "label": "Total Votes (Pres 2024)",      "group": "Presidential 2024"},
    {"field": "TrumpR_24G_President",  "label": "Trump Votes (2024)",           "group": "Presidential 2024"},
    {"field": "HarrisD_24G_President", "label": "Harris Votes (2024)",          "group": "Presidential 2024"},
    # ── Presidential 2020 ────────────────────────────────────────────────
    {"field": "pres20_trump_pct",      "label": "Trump % (Pres 2020)",          "group": "Presidential 2020"},
    {"field": "pres20_biden_pct",      "label": "Biden % (Pres 2020)",          "group": "Presidential 2020"},
    {"field": "pres20_margin",         "label": "R−D Margin (Pres 2020)",       "group": "Presidential 2020"},
    {"field": "pres20_total_votes",    "label": "Total Votes (Pres 2020)",      "group": "Presidential 2020"},
    {"field": "TrumpR_20G_President",  "label": "Trump Votes (2020)",           "group": "Presidential 2020"},
    {"field": "BidenD_20G_President",  "label": "Biden Votes (2020)",           "group": "Presidential 2020"},
    # ── Senate 2024 ──────────────────────────────────────────────────────
    {"field": "sen_cruz_pct",          "label": "Cruz % (Senate 2024)",         "group": "Senate 2024"},
    {"field": "sen_allred_pct",        "label": "Allred % (Senate 2024)",       "group": "Senate 2024"},
    {"field": "sen_margin",            "label": "R−D Margin (Senate 2024)",     "group": "Senate 2024"},
    {"field": "sen_total_votes",       "label": "Total Votes (Senate 2024)",    "group": "Senate 2024"},
    {"field": "CruzR_24G_U.S. Sen",   "label": "Cruz Votes (2024)",            "group": "Senate 2024"},
    {"field": "AllredD_24G_U.S. Sen",  "label": "Allred Votes (2024)",          "group": "Senate 2024"},
    # ── Senate 2020 ──────────────────────────────────────────────────────
    {"field": "sen20_cornyn_pct",      "label": "Cornyn % (Senate 2020)",       "group": "Senate 2020"},
    {"field": "sen20_hegar_pct",       "label": "Hegar % (Senate 2020)",        "group": "Senate 2020"},
    {"field": "sen20_margin",          "label": "R−D Margin (Senate 2020)",     "group": "Senate 2020"},
    {"field": "sen20_total_votes",     "label": "Total Votes (Senate 2020)",    "group": "Senate 2020"},
    # ── Governor 2022 ────────────────────────────────────────────────────
    {"field": "gov22_abbott_pct",      "label": "Abbott % (Gov 2022)",          "group": "Governor 2022"},
    {"field": "gov22_orourke_pct",     "label": "O'Rourke % (Gov 2022)",        "group": "Governor 2022"},
    {"field": "gov22_margin",          "label": "R−D Margin (Gov 2022)",        "group": "Governor 2022"},
    {"field": "gov22_total_votes",     "label": "Total Votes (Gov 2022)",       "group": "Governor 2022"},
    {"field": "AbbottR_22G_Governor",  "label": "Abbott Votes (2022)",          "group": "Governor 2022"},
    {"field": "O'RourkeD_22G_Governor","label": "O'Rourke Votes (2022)",        "group": "Governor 2022"},
    # ── Turnout 2024 ─────────────────────────────────────────────────────
    {"field": "turnout_pct",           "label": "Voter Turnout % (2024)",       "group": "Turnout 2024"},
    {"field": "Turnout",               "label": "Votes Cast (2024)",            "group": "Turnout 2024"},
    {"field": "Voter_Registration",    "label": "Registered Voters (2024)",     "group": "Turnout 2024"},
    {"field": "ss_registration_pct",   "label": "Spanish Surname Reg % (2024)", "group": "Turnout 2024"},
    {"field": "ss_turnout_pct",        "label": "Spanish Surname Turnout % (2024)", "group": "Turnout 2024"},
    # ── Turnout 2022 ─────────────────────────────────────────────────────
    {"field": "turnout22_pct",         "label": "Voter Turnout % (2022)",       "group": "Turnout 2022"},
    {"field": "Turnout_22",            "label": "Votes Cast (2022)",            "group": "Turnout 2022"},
    {"field": "Voter_Registration_22", "label": "Registered Voters (2022)",     "group": "Turnout 2022"},
    {"field": "ss_reg22_pct",          "label": "Spanish Surname Reg % (2022)", "group": "Turnout 2022"},
    # ── Turnout 2020 ─────────────────────────────────────────────────────
    {"field": "turnout20_pct",         "label": "Voter Turnout % (2020)",       "group": "Turnout 2020"},
    {"field": "Turnout_20",            "label": "Votes Cast (2020)",            "group": "Turnout 2020"},
    {"field": "Voter_Registration_20", "label": "Registered Voters (2020)",     "group": "Turnout 2020"},
    {"field": "ss_reg20_pct",          "label": "Spanish Surname Reg % (2020)", "group": "Turnout 2020"},
]

# Choropleth scales for election fields
# R-leaning fields: blue=low R, red=high R
# D-leaning fields: red=low D, blue=high D
# Swing fields: blue=D gained, red=R gained (centered at 0)
# Turnout/registration: dark=low, bright green=high
_R_SCALE = ["#2255cc", "#cc2200"]
_D_SCALE = ["#cc2200", "#2255cc"]
_SWING   = ["#2255cc", "#cc2200"]   # positive swing = R gained = red
_TURNOUT = ["#1a2a1a", "#4a9a4a"]
_SPANISH = ["#1a1a3a", "#7755cc"]
_NEUTRAL = ["#1a2a4a", "#4477dd"]

ELECTION_CHOROPLETH_SCALES = {
    # 2024
    "pres_trump_pct": _R_SCALE, "pres_harris_pct": _D_SCALE,
    "pres_margin": _R_SCALE,
    "sen_cruz_pct": _R_SCALE,   "sen_allred_pct": _D_SCALE,
    "sen_margin": _R_SCALE,
    # 2020
    "pres20_trump_pct": _R_SCALE, "pres20_biden_pct": _D_SCALE,
    "pres20_margin": _R_SCALE,
    "sen20_cornyn_pct": _R_SCALE, "sen20_hegar_pct": _D_SCALE,
    "sen20_margin": _R_SCALE,
    # 2022
    "gov22_abbott_pct": _R_SCALE, "gov22_orourke_pct": _D_SCALE,
    "gov22_margin": _R_SCALE,
    # Swing — red = R gained, blue = D gained
    "pres_swing_24v20": _SWING,  "sen_swing_24v20": _SWING,
    "gov_pres_22v24": _SWING,
    # Turnout
    "turnout_pct": _TURNOUT,     "turnout20_pct": _TURNOUT,
    "turnout22_pct": _TURNOUT,   "turnout_swing_24v20": _SWING,
    "turnout_swing_24v24": _SWING,
    # Spanish surname
    "ss_registration_pct": _SPANISH, "ss_reg20_pct": _SPANISH,
    "ss_reg22_pct": _SPANISH,    "ss_turnout_pct": _SPANISH,
    "ss_turnout_swing_24v20": _SWING,
    # Registration change
    "reg_change_24v20": _NEUTRAL, "reg_change_24v22": _NEUTRAL,
}


@app.route("/api/election/fields")
def api_election_fields():
    """Return available election display fields with group labels."""
    if (e:=_require_ready()): return e
    gdf = _election_cache.get("vtd")
    if gdf is None: return jsonify({"error":"election data not loaded"}), 503
    available = [f for f in ELECTION_DISPLAY_FIELDS if f["field"] in gdf.columns]
    return jsonify({"fields": available})


@app.route("/api/election/geojson")
def api_election_geojson():
    """
    Return VTD GeoJSON with election data.
    Params:
      field         — field to include percentile rank for choropleth
      county        — filter to a county name
      district_layer / district_id — filter to a political district
    """
    if (e:=_require_ready()): return e
    gdf = _election_cache.get("vtd")
    if gdf is None: return jsonify({"error":"election data not loaded"}), 503
    gdf = gdf.copy()

    # County filter
    county = request.args.get("county")
    if county:
        cp = load_county_polygon(county)
        if cp is not None:
            proj = gdf.to_crs(epsg=32614)
            centroids = proj.geometry.centroid
            mask = centroids.within(cp)
            gdf = gdf[mask]

    # District filter
    district_layer = request.args.get("district_layer")
    district_id    = request.args.get("district_id")
    if district_layer and district_id and district_layer in POLITICAL_LAYERS:
        pcfg = POLITICAL_LAYERS[district_layer]
        pgdf = _political_cache.get(district_layer, {}).get("gdf")
        if pgdf is not None:
            dist_row = pgdf[pgdf[pcfg["id_field"]].astype(str) == str(district_id)]
            if not dist_row.empty:
                dp = dist_row.to_crs(epsg=32614).geometry.union_all()
                ep = gdf.to_crs(epsg=32614)
                mask = ep.geometry.centroid.within(dp)
                gdf = gdf[mask]

    # Choropleth field
    field = request.args.get("field")
    keep_fields = ["VTDKEY", "CNTYVTD", "VTD", "CNTY", "geometry"]
    if field and field in gdf.columns:
        gdf[f"__pct_{field}"] = gdf[field].rank(pct=True) * 100
        keep_fields += [field, f"__pct_{field}"]
    # Always include a small core set for tooltip
    for f in ["pres_trump_pct","pres_harris_pct","pres_margin",
              "turnout_pct","Voter_Registration","Turnout"]:
        if f in gdf.columns and f not in keep_fields:
            keep_fields.append(f)

    keep_fields = [f for f in keep_fields if f in gdf.columns]
    sub = gdf[list(dict.fromkeys(keep_fields))].copy()

    # Simplify for performance
    sub["geometry"] = sub.geometry.simplify(0.0005, preserve_topology=True)
    return jsonify(_gdf_to_geojson(sub))


@app.route("/api/election/choropleth_scale/<field>")
def api_election_choropleth_scale(field):
    scale = ELECTION_CHOROPLETH_SCALES.get(field, ["#1a2a1a", "#4477dd"])
    return jsonify({"low": scale[0], "high": scale[1]})


@app.route("/api/debug/<layer_name>")
def api_debug(layer_name):
    if layer_name not in LAYERS: return jsonify({"error":"unknown layer"}),400
    cfg=LAYERS[layer_name]; gdf=gpd.read_file(cfg["shp"]); df=pd.read_csv(cfg["csv"])
    sf,cf=cfg["shp_join_field"],cfg["csv_join_field"]
    ss=set(gdf[sf].astype(str).str.strip())
    cs=set(df[cf].astype(str).str.strip().str.replace(r";.*$","",regex=True).str.strip())
    return jsonify({"shp_field":sf,"shp_samples":gdf[sf].head(10).tolist(),"shp_columns":list(gdf.columns),
                    "csv_field":cf,"csv_samples":df[cf].head(10).tolist(),"csv_columns":list(df.columns),
                    "match_count":len(ss&cs),"match_examples":list(ss&cs)[:5],
                    "shp_total":len(gdf),"csv_total":len(df)})

@app.route("/api/overlap_debug/<county>")
def api_overlap_debug(county):
    if (e:=_require_ready()): return e
    import pyproj; from shapely.ops import transform as st
    cp=load_county_polygon(county)
    if cp is None: return jsonify({"error":"county not found"}),404
    proj=pyproj.Transformer.from_crs("EPSG:4326","EPSG:32614",always_xy=True).transform
    rows=[]
    for _,row in load_layer("puma").iterrows():
        pp=st(proj,row.geometry); inter=pp.intersection(cp)
        if inter.is_empty: continue
        rows.append({"name":row.get("NAMELSAD20",""),"pct_of_county":round(inter.area/cp.area*100,4),
                     "pct_of_puma":round(inter.area/pp.area*100,4) if pp.area else 0})
    return jsonify(sorted(rows,key=lambda r:-r["pct_of_puma"]))

if __name__ == "__main__":
    t = threading.Thread(target=_run_startup, daemon=True)
    t.start()
    app.run(debug=False, port=6001, use_reloader=False)