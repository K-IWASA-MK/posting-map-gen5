#!/usr/bin/env python3
"""
generate-boundaries-geojson.py

e-Stat 小地域境界Shapefile原本と address_master.csv を名寄せ・集約結合し、
正確な境界ジオメトリ、人口(population)、世帯数(households)を保持する
boundaries.geojson を構築する汎用境界ETLスクリプト。

自治体構成および地区固有の表記揺れ・集約ルールは、
外部データ（municipality_master.csv, 必要に応じてtown_aliases.json）から動的に解決します。
"""

import os
import sys
import csv
import json
import argparse
import shapefile
from collections import defaultdict
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union

def parse_args():
    parser = argparse.ArgumentParser(description='Generate boundaries.geojson from e-Stat raw shapefiles and address_master.csv')
    parser.add_argument('--master', default='data/address_master.csv', help='Path to address_master.csv')
    parser.add_argument('--muni-master', default='data/municipality_master.csv', help='Path to municipality_master.csv')
    parser.add_argument('--aliases', default=None, help='Path to town_aliases.json (optional, default: None)')
    parser.add_argument('--raw-dir', default='data/raw_estat_r2', help='Directory containing raw e-Stat shapefiles')
    parser.add_argument('--output', default='scratch/candidate_boundaries.geojson', help='Output GeoJSON path')
    parser.add_argument('--audit-output', default='scratch/boundary_audit_table.json', help='Audit table JSON path')
    parser.add_argument('--city-codes', default=None, help='Comma-separated city codes and names (e.g. "CODE:NAME,CODE:NAME")')
    return parser.parse_args()

def round_coords(geom_dict, precision=6):
    """Recursively round coordinates to avoid excessive decimals."""
    if isinstance(geom_dict, dict):
        return {k: round_coords(v, precision) for k, v in geom_dict.items()}
    elif isinstance(geom_dict, list):
        if len(geom_dict) > 0 and isinstance(geom_dict[0], (int, float)):
            return [round(c, precision) for c in geom_dict]
        return [round_coords(item, precision) for item in geom_dict]
    return geom_dict

def load_city_codes(args):
    """Resolve municipality codes and names from CLI args or municipality_master.csv."""
    city_codes = []
    if args.city_codes:
        for pair in args.city_codes.split(','):
            pair = pair.strip()
            if not pair:
                continue
            if ':' in pair:
                code, cname = pair.split(':', 1)
                city_codes.append((code.strip(), cname.strip()))
            else:
                city_codes.append((pair, pair))
        if not city_codes:
            sys.exit("FATAL: --city-codes specified but no valid code:name pairs parsed.")
        print(f"[Boundary ETL] Resolved {len(city_codes)} municipalities from CLI --city-codes.")
        return city_codes

    if os.path.exists(args.muni_master):
        with open(args.muni_master, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for r in reader:
                code = (r.get('city_code') or r.get('municipality_code') or '').strip()
                cname = (r.get('city_name') or r.get('municipality_name') or '').strip()
                if code and cname:
                    city_codes.append((code, cname))
        if not city_codes:
            sys.exit(f"FATAL: No valid municipality records found in {args.muni_master}.")
        print(f"[Boundary ETL] Resolved {len(city_codes)} municipalities from {args.muni_master}.")
        return city_codes

    sys.exit(f"FATAL: Municipalities cannot be resolved. Specify --city-codes or ensure {args.muni_master} exists.")

def load_alias_rules(aliases_path):
    """Load town alias and aggregation rules from town_aliases.json if specified."""
    if not aliases_path:
        print("[Boundary ETL] No alias file specified. Running with zero aliases.")
        return {}, {}, set()

    if not os.path.exists(aliases_path):
        print(f"[Boundary ETL] Specified alias file not found at {aliases_path}. Running with zero aliases.")
        return {}, {}, set()

    with open(aliases_path, 'r', encoding='utf-8') as f:
        rules = json.load(f)

    if not isinstance(rules, list):
        sys.exit(f"FATAL: Invalid town_aliases schema. Expected JSON list, got {type(rules).__name__}.")

    exact_aliases = {}
    prefix_rules = {}
    muni_prefix_aggr = set()

    for idx, r in enumerate(rules):
        cname = (r.get('municipality_name') or r.get('city_name') or '').strip()
        mtype = r.get('match_type', 'exact')
        reason = r.get('reason', '')

        if not cname:
            sys.exit(f"FATAL: Alias rule at index {idx} missing municipality_name.")

        if mtype == 'exact':
            src = r.get('source_name', '').strip()
            tgt = (r.get('target_name') or r.get('normalized_name') or '').strip()
            if not src or not tgt:
                sys.exit(f"FATAL: Exact rule at index {idx} requires source_name and target_name.")
            exact_aliases[(cname, src)] = (tgt, reason)

        elif mtype == 'prefix':
            src = r.get('source_name', '').strip()
            pattern = (r.get('prefix_pattern') or r.get('target_prefix') or src).strip()
            if not src or not pattern:
                sys.exit(f"FATAL: Prefix rule at index {idx} requires source_name and prefix_pattern.")
            prefix_rules[(cname, src)] = (pattern, reason)

        elif mtype == 'municipality_prefix_aggregation':
            muni_prefix_aggr.add(cname)

        else:
            sys.exit(f"FATAL: Unsupported match_type '{mtype}' in rule at index {idx}.")

    print(f"[Boundary ETL] Loaded alias rules: {len(exact_aliases)} exact, {len(prefix_rules)} prefix, {len(muni_prefix_aggr)} muni-wide prefix.")
    return exact_aliases, prefix_rules, muni_prefix_aggr

def main():
    args = parse_args()

    # 1. Load address_master.csv
    if not os.path.exists(args.master):
        sys.exit(f"FATAL: Address master not found: {args.master}")

    with open(args.master, 'r', encoding='utf-8') as f:
        master_rows = list(csv.DictReader(f))
    print(f"[Boundary ETL] Loaded address master: {len(master_rows)} items from {args.master}")

    # 2. Resolve municipality codes and alias rules
    city_codes = load_city_codes(args)
    exact_aliases, prefix_rules, muni_prefix_aggr = load_alias_rules(args.aliases)

    # 3. Load e-Stat raw shapefiles
    estat_raw_by_city = {}
    total_raw_features = 0
    for code, cname in city_codes:
        shp_path = os.path.join(args.raw_dir, code, f"r2ka{code}.shp")
        if not os.path.exists(shp_path):
            sys.exit(f"FATAL: Raw shapefile not found: {shp_path}")
        sf = shapefile.Reader(shp_path, encoding='cp932')
        records_list = []
        for idx, sr in enumerate(sf.shapeRecords()):
            r = sr.record
            records_list.append({
                'idx': idx,
                'key_code': str(r.KEY_CODE).strip(),
                's_name': str(r.S_NAME or '').strip(),
                'jinko': int(r.JINKO or 0),
                'setai': int(r.SETAI or 0),
                'shape': sr.shape
            })
        estat_raw_by_city[cname] = records_list
        total_raw_features += len(records_list)
        print(f"[Boundary ETL] Loaded {cname} ({code}): {len(records_list)} features")

    print(f"[Boundary ETL] Total raw e-Stat features: {total_raw_features}")

    # 4. Perform matching, aggregation, and geometry union
    output_features = []
    audit_table = []
    mapped_indices = {cname: set() for _, cname in city_codes}
    unmatched_master_items = []

    for row in master_rows:
        row_id = int(row['rowId'])
        cname = row['city_name']
        town = row['town_name']

        city_estat = estat_raw_by_city.get(cname, [])
        assigned_estat = []
        match_level = ""
        match_reason = ""

        # Case 0: Direct e_stat_code (KEY_CODE) match if present in address master (Small Area Mode)
        estat_code = (row.get('e_stat_code') or '').strip()
        if estat_code:
            assigned_estat = [e for e in city_estat if e['key_code'] == estat_code]
            if assigned_estat:
                match_level = "LEVEL 0"
                match_reason = "e-Stat KEY_CODE小地域完全一致"


        # Case A: Municipality-wide prefix aggregation policy
        if not assigned_estat and cname in muni_prefix_aggr:

            for e in city_estat:
                if e['s_name'] == town or e['s_name'].startswith(town):
                    assigned_estat.append(e)
            if assigned_estat:
                match_level = "LEVEL 3"
                match_reason = "自治体全域親大字集約（小字統合）"

        # Case B: Specific town prefix aggregation rule
        elif not assigned_estat and (cname, town) in prefix_rules:
            prefix_pattern, reason = prefix_rules[(cname, town)]
            for e in city_estat:
                if e['s_name'] == prefix_pattern or e['s_name'].startswith(prefix_pattern):
                    assigned_estat.append(e)
            if assigned_estat:
                match_level = "LEVEL 3"
                match_reason = reason or f"個別親大字集約 (接頭辞: {prefix_pattern})"

        # Case C: Standard exact match or exact normalization alias
        elif not assigned_estat:

            # 1. Direct exact match
            for e in city_estat:
                if e['s_name'] == town:
                    assigned_estat.append(e)
            if assigned_estat:
                match_level = "LEVEL 1"
                match_reason = "完全一致"
            else:
                # 2. Exact alias / normalization lookup
                if (cname, town) in exact_aliases:
                    target_name, reason = exact_aliases[(cname, town)]
                    assigned_estat = [e for e in city_estat if e['s_name'] == target_name]
                    if assigned_estat:
                        match_level = "LEVEL 2"
                        match_reason = reason or f"表記正規化 ({town} <-> {target_name})"

        # Strict validation: unmatched address record is FATAL
        if not assigned_estat:
            unmatched_master_items.append({
                "rowId": row_id,
                "city_name": cname,
                "town_name": town
            })
            continue

        for e in assigned_estat:
            mapped_indices[cname].add(e['idx'])

        # Population and Households summation
        pop = sum(e['jinko'] for e in assigned_estat)
        hh = sum(e['setai'] for e in assigned_estat)

        # Geometry processing: union all assigned shapes
        shapely_geoms = []
        for e in assigned_estat:
            sh = e['shape']
            if len(sh.points) > 0:
                g = shape(sh.__geo_interface__)
                if not g.is_valid:
                    g = g.buffer(0) # repair self-intersections
                shapely_geoms.append(g)

        if len(shapely_geoms) == 1:
            union_geom = shapely_geoms[0]
        else:
            union_geom = unary_union(shapely_geoms)
            if not union_geom.is_valid:
                union_geom = union_geom.buffer(0)

        geom_type = union_geom.geom_type
        geom_dict = round_coords(mapping(union_geom), precision=6)

        feature = {
            "type": "Feature",
            "properties": {
                "rowId": row_id,
                "city_name": cname,
                "town_name": town,
                "households": hh,
                "population": pop,
                "e_stat_code": estat_code or (assigned_estat[0]['key_code'] if assigned_estat else "")
            },
            "geometry": geom_dict
        }

        output_features.append(feature)

        audit_table.append({
            "rowId": row_id,
            "city_name": cname,
            "town_name": town,
            "match_level": match_level,
            "match_reason": match_reason,
            "source_features_count": len(assigned_estat),
            "source_key_codes": [e['key_code'] for e in assigned_estat],
            "source_s_names": [e['s_name'] for e in assigned_estat],
            "population": pop,
            "households": hh,
            "geometry_type": geom_type,
            "judgment": "PASS"
        })

    # If any address master record failed to match, report all and abort
    if unmatched_master_items:
        print(f"\n❌ FATAL: {len(unmatched_master_items)} address master records failed to match any e-Stat feature:")
        for item in unmatched_master_items:
            print(f"   - rowId={item['rowId']}: {item['city_name']} {item['town_name']}")
        sys.exit(1)

    # 5. Verify coverage and unmapped features (WARNING / AUDIT log)
    total_unmapped = 0
    unmapped_details = []
    for _, cname in city_codes:
        city_raw = estat_raw_by_city.get(cname, [])
        unmapped = [e for e in city_raw if e['idx'] not in mapped_indices[cname]]
        total_unmapped += len(unmapped)
        for u in unmapped:
            unmapped_details.append({
                "city_name": cname,
                "key_code": u['key_code'],
                "s_name": u['s_name'],
                "jinko": u['jinko'],
                "setai": u['setai']
            })

    print(f"\n[Boundary ETL] Matching complete: {len(output_features)} boundary features generated.")
    if total_unmapped > 0:
        print(f"[Boundary ETL] WARNING: {total_unmapped} e-Stat raw features were unmapped (recorded in audit table).")
        for u in unmapped_details[:10]:
            print(f"   - Unmapped: {u['city_name']} {u['s_name']} (KEY: {u['key_code']}, Pop: {u['jinko']}, HH: {u['setai']})")
        if len(unmapped_details) > 10:
            print(f"   ... and {len(unmapped_details) - 10} more unmapped features.")
    else:
        print("[Boundary ETL] 100% e-Stat features mapped.")

    # 6. Output GeoJSON
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    geojson_data = {
        "type": "FeatureCollection",
        "name": "boundaries",
        "crs": {
            "type": "name",
            "properties": {
                "name": "urn:ogc:def:crs:OGC:1.3:CRS84"
            }
        },
        "features": output_features
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(geojson_data, f, ensure_ascii=False)
    print(f"[Boundary ETL] Successfully written {len(output_features)} features to {args.output}")

    # 7. Output Audit Table JSON
    os.makedirs(os.path.dirname(args.audit_output), exist_ok=True)
    with open(args.audit_output, 'w', encoding='utf-8') as f:
        json.dump({
            "total_ssot": len(master_rows),
            "total_raw": total_raw_features,
            "total_mapped_raw": total_raw_features - total_unmapped,
            "total_unmapped_raw": total_unmapped,
            "unmapped_details": unmapped_details,
            "total_population": sum(f['properties']['population'] for f in output_features),
            "total_households": sum(f['properties']['households'] for f in output_features),
            "rows": audit_table
        }, f, ensure_ascii=False, indent=2)
    print(f"[Boundary ETL] Audit table saved to {args.audit_output}")

if __name__ == '__main__':
    main()

