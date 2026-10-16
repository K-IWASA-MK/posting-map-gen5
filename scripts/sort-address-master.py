#!/usr/bin/env python3
"""
sort-address-master.py

address_master.csv（または Phase 1 Area Skeleton CSV）の各レコードを、
デジタル庁 アドレス・ベース・レジストリ（ABR）町字マスターの公式読み仮名に基づき、
日本語の読み順（五十音順・丁目の数値順）に厳格整列する Universal スクリプト。

準拠規程: docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md §4.4, §4.5

【絶対順守規則】
1. 表示値（city_name, town_name 等の全カラム）は1文字も改変しない。
2. 読み順はデジタル庁ABR町字マスター（city_kana, ward_kana, oaza_cho_kana）の公式入力に統一。
3. 地区専用のハードコード辞書・任意推測マップは永久禁止。
4. 読み仮名が欠損しているレコードが1件でも検知された場合は即時 HARD STOP。
5. 出力先は必須指定とし、既存ファイルの上書きを禁止。異常終了時は未完成ファイルを残さない。
"""

import os
import sys
import re
import csv
import argparse
import tempfile
import shutil

CHOME_NUM_MAP = {
    "一丁目": "01", "二丁目": "02", "三丁目": "03", "四丁目": "04", "五丁目": "05",
    "六丁目": "06", "七丁目": "07", "八丁目": "08", "九丁目": "09", "十丁目": "10",
    "十一丁目": "11", "十二丁目": "12", "十三丁目": "13", "十四丁目": "14", "十五丁目": "15",
    "十六丁目": "16", "十七丁目": "17", "十八丁目": "18", "十九丁目": "19", "二十丁目": "20"
}

def parse_args():
    parser = argparse.ArgumentParser(description="Universal Address Master Sorter adhering to DISTRICT_DATA_ACQUISITION_RULE.md §4.4")
    parser.add_argument("--input", required=True, help="Input CSV path (Required; no default)")
    parser.add_argument("--output", required=True, help="Output CSV path (Required; no default)")
    parser.add_argument("--abr-file", required=True, action='append', help="Path to Digital Agency ABR town master CSV (Required; can be specified multiple times for multiple files)")
    return parser.parse_args()

def load_abr_readings(abr_paths):
    """
    Load official readings from Digital Agency ABR town master CSV files.
    Returns:
      city_readings: dict[(pref_name, city_name)] -> city_kana
      town_readings: dict[(city_name, normalized_town_name)] -> (oaza_cho_kana, chome_num)
    """
    city_readings = {}
    town_readings = {}

    for path in abr_paths:
        if not os.path.exists(path):
            sys.exit(f"FATAL: Specified ABR file not found: {path}")

        print(f"[ABR Loader] Reading official ABR town master: {path}...")
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            fields = reader.fieldnames or []

            # Check expected columns
            # mt_town columns typically include: city_name, ward_name, oaza_cho, chome, city_kana, ward_kana, oaza_cho_kana, chome_number
            # If headers are different, handle common ABR naming
            for r in reader:
                city = r.get("city_name") or r.get("city") or r.get("市区町村名") or ""
                ward = r.get("ward_name") or r.get("ward") or r.get("郡区名") or ""
                oaza_cho = r.get("oaza_cho") or r.get("town") or r.get("町字名") or r.get("大字町名") or r.get("大字町丁目名") or ""
                chome_name = r.get("chome") or r.get("丁目名") or ""

                # city_name in our schema preserves ward: '〇〇市△△区' or '〇〇市'
                full_city_name = f"{city}{ward}".strip() if ward else city.strip()
                # Clean up county name if present in ABR city column (e.g. 〇〇郡△△町 -> △△町)
                if full_city_name and "郡" in full_city_name:
                    full_city_name = re.sub(r"^.+?郡", "", full_city_name)

                city_kana = (r.get("city_kana") or r.get("市区町村名_カナ") or r.get("市区町村名_よみ") or "").strip()
                ward_kana = (r.get("ward_kana") or r.get("郡区名_カナ") or "").strip()
                full_city_kana = f"{city_kana}{ward_kana}".strip()

                if full_city_name and full_city_kana:
                    city_readings[full_city_name] = full_city_kana

                oaza_cho_kana = (r.get("oaza_cho_kana") or r.get("町字名_カナ") or r.get("町字名_よみ") or r.get("大字町名_カナ") or "").strip()
                chome_number = (r.get("chome_number") or r.get("丁目数字") or "").strip()

                # Full town name matching address_master representation: e.g. "△△町一丁目" or "△△町"
                if chome_name:
                    full_town_name = f"{oaza_cho}{chome_name}".strip()
                else:
                    full_town_name = oaza_cho.strip()

                # Also strip leading 大字 if present in ABR to match normalized town_name
                clean_town_name = re.sub(r"^大字", "", full_town_name)

                if full_city_name and clean_town_name and oaza_cho_kana:
                    key = (full_city_name, clean_town_name)
                    town_readings[key] = {
                        "oaza_cho_kana": oaza_cho_kana,
                        "chome_number": chome_number
                    }

    print(f"[ABR Loader] Loaded readings: {len(city_readings)} cities/wards, {len(town_readings)} town entries.")
    return city_readings, town_readings

def resolve_sort_key_universal(row, city_readings, town_readings):
    """
    Derive deterministic sort key adhering to DISTRICT_DATA_ACQUISITION_RULE.md §4.4.
    Keys:
      1. city_kana (50-on order)
      2. oaza_cho_kana (50-on order)
      3. chome_num (numeric 00..99)
      4. rowId (preserved tie-breaker)
    """
    city_name = (row.get("city_name") or "").strip()
    town_name = (row.get("town_name") or "").strip()
    row_id = int(row.get("rowId") or 0)

    # 1. City kana resolution
    city_kana = city_readings.get(city_name)
    if not city_kana:
        # Fallback for city if county was stripped: match on bare city_name
        for cname, ckana in city_readings.items():
            if cname == city_name or re.sub(r"^.+?郡", "", cname) == city_name:
                city_kana = ckana
                break

    if not city_kana:
        raise ValueError(f"FATAL: Unresolved city reading in official ABR data for city_name='{city_name}'")

    # 2. Town kana resolution
    # Strip leading 大字 if present
    clean_town = re.sub(r"^大字", "", town_name)
    lookup_key = (city_name, clean_town)

    town_entry = town_readings.get(lookup_key)

    chome_part = ""
    chome_match = re.search(r"([一二三四五六七八九十]+丁目)$", clean_town)
    base_name = clean_town
    if chome_match:
        chome_part = chome_match.group(1)
        base_name = clean_town[:-len(chome_part)]

    if not town_entry:
        # Try matching base town without chome in ABR
        base_key = (city_name, base_name)
        if base_key in town_readings:
            town_entry = town_readings[base_key]

    if not town_entry:
        raise ValueError(f"FATAL: Unresolved town reading in official ABR data for city='{city_name}', town='{town_name}' (clean='{clean_town}')")

    oaza_cho_kana = town_entry["oaza_cho_kana"]

    # 3. Chome numerical sorting
    chome_num = CHOME_NUM_MAP.get(chome_part, "00")
    if chome_num == "00" and town_entry.get("chome_number"):
        try:
            chome_num = f"{int(town_entry['chome_number']):02d}"
        except:
            pass

    return (city_kana, oaza_cho_kana, chome_num, row_id)

def main():
    args = parse_args()
    print("=" * 70)
    print("UNIVERSAL ADDRESS MASTER SORTER (DISTRICT_DATA_ACQUISITION_RULE.md §4.4)")
    print(f"Input:  {args.input}")
    print(f"Output: {args.output}")
    print("=" * 70)

    if not os.path.exists(args.input):
        sys.exit(f"FATAL: Input file not found: {args.input}")

    if os.path.exists(args.output):
        sys.exit(f"FATAL HARD STOP: Output file already exists (overwrite strictly prohibited): {args.output}")

    city_readings, town_readings = load_abr_readings(args.abr_file)

    with open(args.input, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        original_header = reader.fieldnames
        original_rows = list(reader)

    original_count = len(original_rows)
    print(f"[Sorter] Loaded {original_count} records from {args.input}")

    # Test and resolve sort keys for all rows (HARD STOP on any failure)
    for idx, r in enumerate(original_rows):
        try:
            resolve_sort_key_universal(r, city_readings, town_readings)
        except Exception as err:
            sys.exit(f"FAIL [Universal Reading Check] at row {idx+1} (rowId={r.get('rowId')}): {err}")

    print("PASS [Universal Reading Check]: All records successfully resolved sort keys via official ABR data.")

    # Sort execution
    sorted_rows = sorted(original_rows, key=lambda r: resolve_sort_key_universal(r, city_readings, town_readings))

    # Verification: row count preservation and rowId sequence
    assert len(sorted_rows) == original_count, "Record count mismatch after sort"

    orig_row_ids = set(int(r["rowId"]) for r in original_rows)
    sorted_row_ids = set(int(r["rowId"]) for r in sorted_rows)
    assert orig_row_ids == sorted_row_ids, "rowId set changed after sort"

    # Write output atomically via temporary file
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    fd, temp_out_path = tempfile.mkstemp(prefix="sort_address_", dir=out_dir)
    os.close(fd)

    try:
        with open(temp_out_path, "w", encoding="utf-8", newline="\n") as f:
            writer = csv.DictWriter(f, fieldnames=original_header, lineterminator="\n")
            writer.writeheader()
            writer.writerows(sorted_rows)

        # Atomic move to destination
        shutil.move(temp_out_path, args.output)
        print(f"[Sorter] SUCCESS: Written {len(sorted_rows)} sorted records to {args.output}")
    finally:
        if os.path.exists(temp_out_path):
            os.remove(temp_out_path)

if __name__ == "__main__":
    main()
