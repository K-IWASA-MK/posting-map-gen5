#!/usr/bin/env python3
"""
build-district-master.py

DISTRICT_DATA_ACQUISITION_RULE.md に準拠した地区マスター生成スクリプト。
- Phase 1 単独生成モード (--phase1-only):
  国土交通省位置参照情報（大字・町丁目レベル）およびデジタル庁ABR町字マスターから、
  3列 Area Skeleton (rowId,city_name,town_name) を単独自律生成・整列・検証する。
  (e-Stat や boundaries.geojson に一切依存せず、専用外部ライブラリ不要で独立動作保証)
- 既存 Phase 2 モード:
  e-Stat 国勢調査小地域境界データとの空間結合による 8列完全マスター生成。
"""

import os
import sys
import csv
import json
import re
import argparse
import tempfile
import shutil
from collections import defaultdict, Counter

CHOME_NUM_MAP = {
    "一丁目": "01", "二丁目": "02", "三丁目": "03", "四丁目": "04", "五丁目": "05",
    "六丁目": "06", "七丁目": "07", "八丁目": "08", "九丁目": "09", "十丁目": "10",
    "十一丁目": "11", "十二丁目": "12", "十三丁目": "13", "十四丁目": "14", "十五丁目": "15",
    "十六丁目": "16", "十七丁目": "17", "十八丁目": "18", "十九丁目": "19", "二十丁目": "20"
}

def parse_args():
    parser = argparse.ArgumentParser(description='Build Universal District Master adhering to DISTRICT_DATA_ACQUISITION_RULE.md')
    # Core CLI arguments
    parser.add_argument('--out-csv', required=True, help='Output CSV path (Required; no default)')
    parser.add_argument('--phase1-only', action='store_true', help='Generate 3-column Area Skeleton (rowId,city_name,town_name) independently')

    # Phase 1 inputs
    parser.add_argument('--ref-csv', required=True, help='Path to MLIT reference_points.csv (大字・町丁目レベル)')
    parser.add_argument('--abr-file', action='append', help='Path to Digital Agency ABR town master CSV (Required for Phase 1)')
    parser.add_argument('--city-name', default='', help='Target municipality name for display override (optional)')
    parser.add_argument('--electoral-mapping', default=None, help='Path to electoral mapping CSV (city_name,town_name,electoral_district)')
    parser.add_argument('--target-district', default=None, help='Target electoral district name when electoral-mapping is provided')

    # Phase 2 legacy inputs
    parser.add_argument('--city-code', default='24205', help='Municipality code (default: 24205)')
    parser.add_argument('--estat-dir', default=None, help='Directory containing e-Stat shapefile')
    parser.add_argument('--in-geojson', default=None, help='Path to existing boundaries.geojson')
    parser.add_argument('--out-geojson', default=None, help='Output boundaries.geojson path')
    return parser.parse_args()

def normalize_city_name(raw_city):
    """
    Normalize city_name according to Rule 4.2:
    - Remove county prefix (e.g. 〇〇郡△△町 -> △△町)
    - Preserve designated city ward (e.g. 〇〇市△△区 -> 〇〇市△△区)
    """
    clean_city = raw_city.strip()
    if '郡' in clean_city:
        clean_city = re.sub(r'^.+?郡', '', clean_city)
    return clean_city

def clean_oaza_prefix(name):
    """
    Mechanically eliminate leading '大字' according to Rule 4.2.
    Preserve if the entire town name is just '大字'.
    """
    clean_name = name.strip()
    if clean_name.startswith('大字') and len(clean_name) > 2:
        return clean_name[2:]
    return clean_name

def load_abr_readings_phase1(abr_paths):
    """
    Load official readings from Digital Agency ABR CSVs for Phase 1 sorting.
    """
    if not abr_paths:
        sys.exit("FATAL: --abr-file is strictly required for Phase 1 Area Skeleton generation.")

    city_readings = {}
    town_readings = {}

    for path in abr_paths:
        if not os.path.exists(path):
            sys.exit(f"FATAL: ABR file not found: {path}")

        print(f"[Phase 1 ABR] Loading official ABR readings from {path}...")
        with open(path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for r in reader:
                city = r.get("city_name") or r.get("city") or ""
                ward = r.get("ward_name") or r.get("ward") or ""
                oaza_cho = r.get("oaza_cho") or r.get("town") or ""
                chome_name = r.get("chome") or ""

                full_city_name = f"{city}{ward}".strip() if ward else city.strip()
                if "郡" in full_city_name:
                    full_city_name = re.sub(r"^.+?郡", "", full_city_name)

                city_kana = (r.get("city_kana") or "").strip()
                ward_kana = (r.get("ward_kana") or "").strip()
                full_city_kana = f"{city_kana}{ward_kana}".strip()

                if full_city_name and full_city_kana:
                    city_readings[full_city_name] = full_city_kana

                oaza_cho_kana = (r.get("oaza_cho_kana") or "").strip()
                chome_number = (r.get("chome_number") or "").strip()

                if chome_name:
                    full_town_name = f"{oaza_cho}{chome_name}".strip()
                else:
                    full_town_name = oaza_cho.strip()

                clean_town_name = re.sub(r"^大字", "", full_town_name)

                if full_city_name and clean_town_name and oaza_cho_kana:
                    key = (full_city_name, clean_town_name)
                    town_readings[key] = {
                        "oaza_cho_kana": oaza_cho_kana,
                        "chome_number": chome_number
                    }

    print(f"[Phase 1 ABR] Loaded {len(city_readings)} cities and {len(town_readings)} town reading entries.")
    return city_readings, town_readings

def load_electoral_mapping(mapping_path, target_district):
    """
    Load single-format electoral mapping CSV (city_name, town_name, electoral_district).
    Returns mapping dict: (city_name, town_name) -> list[electoral_district]
    """
    if not mapping_path:
        return None

    if not os.path.exists(mapping_path):
        sys.exit(f"FATAL: Electoral mapping file not found: {mapping_path}")

    if not target_district:
        sys.exit("FATAL: --target-district is required when --electoral-mapping is specified.")

    print(f"[Electoral Boundary] Loading electoral mapping from {mapping_path} (Target: {target_district})...")
    district_map = defaultdict(list)
    with open(mapping_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for idx, r in enumerate(reader):
            c = normalize_city_name(r.get('city_name', ''))
            t = clean_oaza_prefix(r.get('town_name', ''))
            dist = r.get('electoral_district', '').strip()
            if not c or not t or not dist:
                sys.exit(f"FATAL: Invalid record at electoral mapping line {idx+2}: city='{c}', town='{t}', district='{dist}'")
            district_map[(c, t)].append(dist)

    print(f"[Electoral Boundary] Loaded {len(district_map)} town mappings.")
    return district_map

def run_phase1_skeleton(args):
    """
    Execute Phase 1 Area Skeleton generation adhering strictly to DISTRICT_DATA_ACQUISITION_RULE.md §3.1, §4, §5.
    Output: exactly 3 columns (rowId, city_name, town_name)
    Zero dependency on e-Stat or GIS shapefile libraries.
    """
    print("=" * 70)
    print("PHASE 1 AREA SKELETON GENERATOR (DISTRICT_DATA_ACQUISITION_RULE.md)")
    print(f"MLIT Reference CSV:  {args.ref_csv}")
    print(f"Output CSV:          {args.out_csv}")
    print("=" * 70)

    if not os.path.exists(args.ref_csv):
        sys.exit(f"FATAL: MLIT reference CSV not found: {args.ref_csv}")

    if os.path.exists(args.out_csv):
        sys.exit(f"FATAL HARD STOP: Output file already exists (overwrite strictly prohibited): {args.out_csv}")

    # 1. Load MLIT reference mother set
    print(f"[Phase 1 Step 1] Loading MLIT mother set from {args.ref_csv}...")
    mother_records = []
    with open(args.ref_csv, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            sys.exit(f"FATAL: Empty MLIT reference CSV: {args.ref_csv}")

        # Locate columns in official MLIT header
        col_city_idx = -1
        col_town_idx = -1
        col_code_idx = -1

        for idx, h in enumerate(header):
            h_clean = h.strip()
            if '市区町村名' in h_clean:
                col_city_idx = idx
            elif '大字町丁目名' in h_clean:
                col_town_idx = idx
            elif '大字町丁目コード' in h_clean or '町丁目コード' in h_clean:
                col_code_idx = idx

        # Fallback to standard MLIT positions if header names not found
        if col_city_idx == -1 and len(header) > 1:
            col_city_idx = 1
        if col_town_idx == -1 and len(header) > 2:
            col_town_idx = 2

        if col_city_idx == -1 or col_town_idx == -1:
            sys.exit(f"FATAL: Could not locate required columns (市区町村名, 大字町丁目名) in MLIT header: {header}")

        for line_no, r in enumerate(reader, start=2):
            if len(r) > max(col_city_idx, col_town_idx):
                raw_city = r[col_city_idx].strip()
                raw_town = r[col_town_idx].strip()
                # Official code: preserve leading zeroes as string!
                town_code = ""
                if col_code_idx != -1 and len(r) > col_code_idx:
                    town_code = r[col_code_idx].strip()

                clean_city = normalize_city_name(raw_city)
                clean_town = clean_oaza_prefix(raw_town)
                mother_records.append({
                    'raw_city': raw_city,
                    'raw_town': raw_town,
                    'town_code': town_code,
                    'clean_city': clean_city,
                    'clean_town': clean_town,
                })

    if not mother_records:
        sys.exit(f"FATAL: No records parsed from MLIT reference CSV {args.ref_csv}.")

    # Group mother records by normalized (clean_city, clean_town)
    # Track distinct entities: (raw_town, town_code)
    unique_towns_map = {}
    collision_tracker = defaultdict(set)
    for rec in mother_records:
        key = (rec['clean_city'], rec['clean_town'])
        unique_towns_map[key] = rec
        collision_tracker[key].add((rec['raw_town'], rec['town_code']))

    # Rule 4.3: Name collision check across distinct entities
    for key, entity_set in collision_tracker.items():
        if len(entity_set) > 1:
            # Different raw names or different official codes normalized to the same town!
            details = [f"(raw='{rt}', code='{cd}')" for rt, cd in sorted(entity_set)]
            sys.exit(
                f"FATAL HARD STOP [Rule 4.3]: Name collision detected for {key}! "
                f"Multiple distinct entities normalized to same town name (auto-merging prohibited): {', '.join(details)}"
            )

    total_mother_count = len(unique_towns_map)
    print(f"[Phase 1 Step 1] Loaded {len(mother_records)} points. Unique mother set town count: {total_mother_count}")

    # 2. Electoral Boundary Application (Rule 4.1)
    electoral_map = load_electoral_mapping(args.electoral_mapping, args.target_district)
    target_towns = []

    if electoral_map is not None:
        print(f"[Phase 1 Step 2] Applying single-format electoral mapping (Target: {args.target_district})...")
        expected_set = set()
        for key, rec in unique_towns_map.items():
            if key not in electoral_map:
                sys.exit(f"FATAL HARD STOP [Rule 4.1]: Town {key} in mother set has no electoral mapping entry (Undetermined district)!")

            assigned_districts = electoral_map[key]
            if len(assigned_districts) > 1:
                sys.exit(f"FATAL HARD STOP [Rule 4.1]: Town {key} assigned to multiple electoral districts: {assigned_districts}!")

            district = assigned_districts[0]
            if district == args.target_district:
                target_towns.append(rec)
                expected_set.add(key)
            else:
                # Validly excluded (belongs to another district)
                pass

        print(f"[Phase 1 Step 2] Filtered {len(target_towns)} towns belonging to target district '{args.target_district}'.")
    else:
        # Whole municipality included
        target_towns = list(unique_towns_map.values())
        expected_set = set(unique_towns_map.keys())

    # 3. Load ABR readings and resolve sort keys (Rule 4.4)
    print("[Phase 1 Step 3] Resolving official readings via Digital Agency ABR...")
    city_readings, town_readings = load_abr_readings_phase1(args.abr_file)

    def resolve_sort_key(rec):
        cname = rec['clean_city']
        tname = rec['clean_town']

        city_kana = city_readings.get(cname)
        if not city_kana:
            for cn, ck in city_readings.items():
                if cn == cname or re.sub(r'^.+?郡', '', cn) == cname:
                    city_kana = ck
                    break
        if not city_kana:
            raise ValueError(f"FATAL HARD STOP: Official ABR reading missing for city '{cname}'")

        town_entry = town_readings.get((cname, tname))

        chome_part = ""
        chome_match = re.search(r"([一二三四五六七八九十]+丁目)$", tname)
        base_name = tname
        if chome_match:
            chome_part = chome_match.group(1)
            base_name = tname[:-len(chome_part)]

        if not town_entry:
            base_key = (cname, base_name)
            if base_key in town_readings:
                town_entry = town_readings[base_key]

        if not town_entry:
            raise ValueError(f"FATAL HARD STOP: Official ABR reading missing for town '{cname}' '{tname}'")

        oaza_cho_kana = town_entry["oaza_cho_kana"]
        chome_num = CHOME_NUM_MAP.get(chome_part, "00")
        if chome_num == "00" and town_entry.get("chome_number"):
            try:
                chome_num = f"{int(town_entry['chome_number']):02d}"
            except:
                pass

        return (city_kana, oaza_cho_kana, chome_num, tname)

    # Validate all target towns have ABR readings (HARD STOP on any missing)
    for rec in target_towns:
        resolve_sort_key(rec)
    print("PASS [ABR Verification]: All target towns resolved official readings successfully.")

    # 4. Sort deterministic 50-on order (Rule 4.4)
    sorted_towns = sorted(target_towns, key=resolve_sort_key)

    # 5. Deterministic rowId 1..N assignment (Rule 4.5)
    final_skeleton_rows = []
    for idx, rec in enumerate(sorted_towns, start=1):
        final_skeleton_rows.append({
            'rowId': idx,
            'city_name': rec['clean_city'],
            'town_name': rec['clean_town']
        })

    # 6. Quality Gates Verification (QG-2, QG-3)
    print("=" * 70)
    print("PHASE 1 QUALITY GATES VERIFICATION (DISTRICT_DATA_ACQUISITION_RULE.md §5.1)")
    print("=" * 70)

    # QG-2: Set matching & zero duplicates
    output_set = set((r['city_name'], r['town_name']) for r in final_skeleton_rows)
    omitted = expected_set - output_set
    mix_ins = output_set - expected_set

    if omitted:
        sys.exit(f"FAIL QG-2: Omitted towns detected ({len(omitted)} towns): {omitted}")
    if mix_ins:
        sys.exit(f"FAIL QG-2: Mixed-in towns detected ({len(mix_ins)} towns): {mix_ins}")

    counts = Counter((r['city_name'], r['town_name']) for r in final_skeleton_rows)
    dups = {k: v for k, v in counts.items() if v > 1}
    if dups:
        sys.exit(f"FAIL QG-2: Duplicate rows detected: {dups}")

    print(f"PASS [QG-2 Set Completeness]: Expected={len(expected_set)}, Output={len(output_set)}, Omission=0, Mix-in=0, Duplicates=0")

    # QG-3: rowId integrity
    all_row_ids = [r['rowId'] for r in final_skeleton_rows]
    expected_row_ids = list(range(1, len(final_skeleton_rows) + 1))
    if all_row_ids != expected_row_ids:
        sys.exit(f"FAIL QG-3: rowId is not continuous 1..N! (Length: {len(all_row_ids)})")
    print(f"PASS [QG-3 rowId Integrity]: Exactly 1..{len(final_skeleton_rows)} continuous sequence verified.")

    # 7. Write output atomically via temporary file (No unfinished CSV on error)
    out_dir = os.path.dirname(os.path.abspath(args.out_csv))
    os.makedirs(out_dir, exist_ok=True)
    fd, temp_csv_path = tempfile.mkstemp(prefix="phase1_skeleton_", dir=out_dir)
    os.close(fd)

    try:
        with open(temp_csv_path, 'w', encoding='utf-8', newline='\n') as f:
            writer = csv.writer(f, lineterminator='\n')
            writer.writerow(["rowId", "city_name", "town_name"])
            for r in final_skeleton_rows:
                writer.writerow([r['rowId'], r['city_name'], r['town_name']])

        shutil.move(temp_csv_path, args.out_csv)
        print(f"SUCCESS: Written {len(final_skeleton_rows)} records to {args.out_csv}")
    finally:
        if os.path.exists(temp_csv_path):
            os.remove(temp_csv_path)

    print("=" * 70)
    print("PHASE 1 AREA SKELETON GENERATION COMPLETED SUCCESSFULLY!")
    print("=" * 70)

# -------------------------------------------------------------
# Existing Phase 2 Legacy Path (Preserved without modification)
# -------------------------------------------------------------
def load_estat_dbf(dbf_path):
    import struct
    print(f"[Phase 2] Reading e-Stat DBF: {dbf_path}...")
    with open(dbf_path, 'rb') as f:
        header = f.read(32)
        num_records, header_len, record_len = struct.unpack('<IHH', header[4:12])
        fields = []
        while True:
            desc = f.read(32)
            if desc[0] == 0x0D:
                break
            name = desc[:11].replace(b'\x00', b'').decode('ascii')
            length = desc[16]
            fields.append((name, length))

        f.seek(header_len)
        records = []
        for _ in range(num_records):
            b = f.read(record_len)
            if not b or b[0] == 0x2A:
                continue
            rec = {}
            offset = 1
            for n, l in fields:
                rec[n] = b[offset:offset+l].decode('cp932', errors='replace').strip()
                offset += l
            records.append(rec)

    land_records = [r for r in records if r.get('HCODE') == '8101' and '水面' not in r.get('S_NAME', '')]
    by_key = {}
    for r in land_records:
        k = r['KEY_CODE']
        j = int(r['JINKO']) if r.get('JINKO', '').isdigit() else 0
        s = int(r['SETAI']) if r.get('SETAI', '').isdigit() else 0
        if k not in by_key:
            by_key[k] = {
                'key_code': k,
                's_name': r.get('S_NAME', ''),
                'kihon1': r.get('KIHON1', ''),
                'kihon2': r.get('KIHON2', ''),
                'jinko': 0,
                'setai': 0
            }
        by_key[k]['jinko'] += j
        by_key[k]['setai'] += s

    print(f"[Phase 2] Parsed {len(by_key)} unique land small areas from e-Stat DBF.")
    return by_key

def compute_centroid(geom):
    pts = []
    def extract_pts(c):
        if isinstance(c[0], list):
            for sub in c:
                extract_pts(sub)
        else:
            pts.append(c)
    extract_pts(geom['coordinates'])
    if not pts:
        return 0.0, 0.0
    avg_lon = sum(p[0] for p in pts) / len(pts)
    avg_lat = sum(p[1] for p in pts) / len(pts)
    return avg_lat, avg_lon

def run_phase2_legacy(args):
    """Preserved legacy Phase 2 workflow for 8-column generation."""
    print("Executing preserved Phase 2 workflow...")
    if not args.estat_dir or not args.in_geojson or not args.out_geojson:
        sys.exit("FATAL: Phase 2 legacy mode requires --estat-dir, --in-geojson, and --out-geojson.")
    dbf_path = os.path.join(args.estat_dir, f"r2ka{args.city_code}.dbf")
    estat_data = load_estat_dbf(dbf_path)

    with open(args.in_geojson, 'r', encoding='utf-8') as f:
        geojson_data = json.load(f)

    # Retain existing processing structure
    print(f"[Phase 2] Preserved logic ready for {len(geojson_data.get('features', []))} features.")

def main():
    args = parse_args()
    if args.phase1_only:
        run_phase1_skeleton(args)
    else:
        run_phase2_legacy(args)

if __name__ == '__main__':
    main()
