#!/usr/bin/env python3
"""
fetch-district-raw-data.py

国土交通省「位置参照情報」（大字・町丁目レベル／街区レベル）および総務省「e-Stat国勢調査小地域境界データ」を
市区町村コードから完全自律でHTTP直接取得・解凍・正規化する汎用スクリプト。

準拠規程: docs/architecture/DISTRICT_DATA_ACQUISITION_RULE.md §3.1, §7.2
"""

import os
import sys
import argparse
import urllib.request
import urllib.parse
import http.cookiejar
import zipfile
import csv
import json
import hashlib
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

def parse_args():
    parser = argparse.ArgumentParser(description='Fetch district raw data autonomously from MLIT and verify ABR master')
    parser.add_argument('--city-code', required=True, help='5-digit municipality code (e.g. 24205)')
    parser.add_argument('--ref-dir', required=True, help='Explicit destination directory to cache location reference data (Required; no default)')
    parser.add_argument('--estat-dir', default=None, help='Directory to cache e-Stat data (optional)')
    parser.add_argument('--abr-file', action='append', help='Path to Digital Agency ABR town master CSV (Required for Phase 1 verification)')
    parser.add_argument('--abr-dir', default=None, help='Directory containing Digital Agency ABR town master CSV files')
    parser.add_argument('--data-kind', default='1', choices=['1'], help='1: 大字・町丁目レベル (data_kind=1 only; block level is strictly prohibited)')
    return parser.parse_args()

def compute_sha256(filepath):
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

CREATION_DATE_KEYS = [
    '作成年月日', '原資料作成日', 'データ作成日', '作成日',
    'createDate', 'creationDate', 'dateCreated', 'Created Date', 'created_date'
]
EXCLUDED_DATE_KEYS = [
    '更新年月日', '更新日', '改定年月日', '改定日', '提供年月日', '提供日',
    '公開年月日', '公開日', '公表年月日', '公表日',
    'updateDate', 'modifiedDate', 'releaseDate', 'publishDate'
]

DATE_VALUE_REGEX = re.compile(r'(令和\s*\d+\s*年\s*\d+\s*月\s*\d+\s*日|\d{4}年\s*\d+\s*月\s*\d+\s*日|\d{4}[-/]\d{1,2}[-/]\d{1,2})')

def extract_creation_date_from_html(row_html):
    """
    Extract explicit source creation date and key from provider HTML table row.
    Strictly distinguishes creation date from update/release dates.
    Returns (matched_key, matched_date) or (None, None).
    """
    # 1. Pattern: sequential <th>/<td> cells (label followed by value)
    raw_cells = [re.sub(r'<[^>]+>', ' ', m.group(1)).strip() 
                 for m in re.finditer(r'<(?:th|td)[^>]*>(.*?)</(?:th|td)>', row_html, re.DOTALL | re.IGNORECASE)]
    
    for i in range(len(raw_cells) - 1):
        label_clean = raw_cells[i]
        val_clean = raw_cells[i + 1]
        is_creation = any(k.lower() in label_clean.lower() for k in CREATION_DATE_KEYS)
        is_excluded = any(k.lower() in label_clean.lower() for k in EXCLUDED_DATE_KEYS)
        if is_creation and not is_excluded:
            m_date = DATE_VALUE_REGEX.search(val_clean)
            if m_date:
                matched_key = next(k for k in CREATION_DATE_KEYS if k.lower() in label_clean.lower())
                return (matched_key, m_date.group(1))

    # 2. Pattern: Inside single cell (e.g. <td>作成年月日：令和6年3月29日</td>)
    for cell in raw_cells:
        for k in CREATION_DATE_KEYS:
            is_excluded = any(ex.lower() in cell.lower() for ex in EXCLUDED_DATE_KEYS)
            if not is_excluded and k.lower() in cell.lower():
                m_date = DATE_VALUE_REGEX.search(cell)
                if m_date:
                    return (k, m_date.group(1))

    # 3. Pattern: Key: Value across text
    key_pattern = '|'.join(re.escape(k) for k in CREATION_DATE_KEYS)
    kv_matches = re.finditer(rf'(?i)[\s>](?:{key_pattern})\s*[:：=]\s*([^\s<"\'&]+)', row_html)
    for m in kv_matches:
        full_match = m.group(0)
        matched_text = m.group(1)
        m_date = DATE_VALUE_REGEX.search(matched_text)
        if m_date:
            matched_key = next((k for k in CREATION_DATE_KEYS if re.search(re.escape(k), full_match, re.IGNORECASE)), '作成日')
            return (matched_key, m_date.group(1))

    return (None, None)

def extract_creation_date_from_metadata(content):
    """
    Extract explicit source creation date and key from metadata files (XML, README, text).
    Strictly distinguishes creation date from update/release dates.
    For JMP 2.0 / ISO 19115 XML:
      Analyzes <MD_DataIdentification> (or <dataIdInfo>) -> <citation> -> <date>
      where <dateType> (or <CI_DateTypeCode>) is 001 (creation).
      Strictly ignores specification dates (<specification>) and non-creation dates (002, 003).
    Returns (matched_key, matched_date) or (None, None).
    """
    # 1. JMP 2.0 / ISO 19115 XML citation structure analysis
    try:
        clean_xml = re.sub(r'<\?xml[^>]+encoding=[\'"][^\'"]+[\'"][^>]*\?>', '<?xml version="1.0"?>', content)
        root = ET.fromstring(clean_xml)

        def local_tag(elem):
            return elem.tag.split('}')[-1]

        for node in root.iter():
            if local_tag(node) in ('MD_DataIdentification', 'dataIdInfo'):
                for cit in node.iter():
                    if local_tag(cit) == 'citation':
                        for d_elem in cit.iter():
                            if local_tag(d_elem) in ('CI_Date', 'date'):
                                date_vals = [c.text.strip() for c in d_elem.iter() if local_tag(c) == 'date' and c.text and c.text.strip()]
                                type_vals = [c.text.strip() for c in d_elem.iter() if local_tag(c) in ('dateType', 'CI_DateTypeCode') and c.text and c.text.strip()]
                                for c in d_elem.iter():
                                    if local_tag(c) == 'CI_DateTypeCode' and c.get('codeListValue'):
                                        type_vals.append(c.get('codeListValue').strip())

                                # 001 = creation (作成日), 002 = publication (出版/公開), 003 = revision (改訂/更新)
                                is_creation = any(tv in ('001', 'creation', '作成', '作成日', '作成年月日') for tv in type_vals)
                                is_other = any(tv in ('002', '003', 'publication', 'revision', '公開', '更新', '改訂') for tv in type_vals)
                                if is_creation and not is_other:
                                    for dv in date_vals:
                                        m_d = DATE_VALUE_REGEX.search(dv)
                                        if m_d:
                                            return ('citation/date[dateType=001:creation]', m_d.group(1))
    except Exception:
        pass

    # 2. XML tag pattern: <作成年月日>...</作成年月日>, <createDate>...</createDate>
    for key in CREATION_DATE_KEYS:
        tag_match = re.search(rf'<{key}[^>]*>\s*([^<]+)\s*</{key}>', content, re.IGNORECASE)
        if tag_match:
            val = tag_match.group(1).strip()
            m_date = DATE_VALUE_REGEX.search(val)
            if m_date:
                return (key, m_date.group(1))

    # 3. Text label pattern: 作成年月日: 2024-03-29
    for key in CREATION_DATE_KEYS:
        txt_match = re.search(rf'(?i)(?:^|[\r\n\s]){key}\s*[:：=]\s*([^\r\n]+)', content)
        if txt_match:
            val = txt_match.group(1).strip()
            m_date = DATE_VALUE_REGEX.search(val)
            if m_date:
                return (key, m_date.group(1))

    return (None, None)

def fetch_mlit_location_reference(city_code, ref_dir, data_kind='1', abr_reports=None):
    """
    Fetch MLIT location reference data ZIP autonomously.
    data_kind: '1' for 大字・町丁目レベル (SSOT default and ONLY allowed kind)
    """
    if str(data_kind) != '1':
        sys.exit(f"FATAL HARD STOP [DISTRICT_DATA_ACQUISITION_RULE.md §3.1]: data_kind must be '1' (大字・町丁目レベル). Block level data_kind={data_kind} is strictly prohibited.")

    pref_code = city_code[:2]
    out_dir = os.path.join(ref_dir, city_code)
    normalized_csv = os.path.join(out_dir, 'reference_points.csv')
    provenance_path = os.path.join(out_dir, 'provenance.json')

    # Overwrite strictly prohibited across CSV, ZIP and provenance JSON
    if os.path.exists(normalized_csv):
        sys.exit(f"FATAL HARD STOP: Destination reference CSV already exists (overwrite strictly prohibited): {normalized_csv}")
    if os.path.exists(provenance_path):
        sys.exit(f"FATAL HARD STOP: Destination provenance JSON already exists (overwrite strictly prohibited): {provenance_path}")
    if os.path.exists(out_dir):
        existing_zips = [f for f in os.listdir(out_dir) if f.endswith('.zip')]
        if existing_zips:
            sys.exit(f"FATAL HARD STOP: Destination archive ZIP already exists in {out_dir} (overwrite strictly prohibited): {existing_zips}")

    kind_label = "大字・町丁目"
    print(f"[MLIT Fetcher] Target Municipality Code: {city_code} (Pref: {pref_code}), Kind: {kind_label} (data_kind={data_kind})")

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    user_agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    opener.addheaders = [
        ('User-Agent', user_agent),
        ('Referer', 'https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_download_files.cgi')
    ]

    temp_work_dir = tempfile.mkdtemp(prefix=f"mlit_fetch_{city_code}_")
    try:
        # Step 1: Query cities list for the prefecture to resolve city checkbox ID (ac)
        print("[MLIT Fetcher] Step 1: Resolving municipality parameters...")
        view_cities_url = 'https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_view_cities_wards.cgi'
        data_step1 = urllib.parse.urlencode({'sbm': '1', 'pc': pref_code}).encode('euc-jp')
        req1 = urllib.request.Request(view_cities_url, data=data_step1)

        ac_val = None
        with opener.open(req1) as resp:
            text1 = resp.read().decode('euc-jp', errors='replace')
            m_ac = re.search(r'id=[\'\"]?ac' + city_code + r'[\'\"]?[^>]*value=[\'\"]?(\d+)[\'\"]?', text1)
            if not m_ac:
                m_ac = re.search(r'value=[\'\"]?(\d+)[\'\"]?[^>]*id=[\'\"]?ac' + city_code + r'[\'\"]?', text1)
            if m_ac:
                ac_val = m_ac.group(1)
                print(f"[MLIT Fetcher] Resolved city parameter ac: {ac_val}")
            else:
                sys.exit(f"FATAL: Could not resolve ac parameter for city_code {city_code} in MLIT response.")

        # Step 2: Choose files page to resolve latest dataset ID (chn) based on metadata
        print(f"[MLIT Fetcher] Step 2: Resolving latest {kind_label} dataset ID (chn) from provider metadata...")
        choose_files_url = 'https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_files.cgi'
        data_step2 = urllib.parse.urlencode({'sbm': '1', 'srh': '', 'oa': '', 'pc': pref_code, 'ac': ac_val}).encode('euc-jp')
        req2 = urllib.request.Request(choose_files_url, data=data_step2)

        chn_val = None
        resolved_version = None
        resolved_year = None
        raw_row_text = ""

        with opener.open(req2) as resp:
            text2 = resp.read().decode('euc-jp', errors='replace')
            rows = re.findall(r'<tr>(.*?)</tr>', text2, re.DOTALL)
            matched_candidates = []

            for row in rows:
                # Determine data kind by official form input attribute value="1" (大字・町丁目) or "0" (街区), or cell text
                m_data_kind = re.search(r'name=[\'\"]?data_kind[\'\"]?[^>]*value=[\'\"]?(\d+)[\'\"]?', row)
                if not m_data_kind:
                    m_data_kind = re.search(r'value=[\'\"]?(\d+)[\'\"]?[^>]*name=[\'\"]?data_kind[\'\"]?', row)

                is_kind_match = False
                if m_data_kind:
                    is_kind_match = (m_data_kind.group(1) == data_kind)
                else:
                    # Fallback to tag-stripped text match: "大字・町丁目" or "街区" (handles <br> tags in cell)
                    clean_row = re.sub(r'<[^>]+>', ' ', row)
                    is_kind_match = (kind_label in clean_row or re.search(rf'{kind_label[0]}.*{kind_label[-1]}', clean_row) is not None)

                if is_kind_match:
                    m_chn = re.search(r'name=[\'\"]?chn[\'\"]?[^>]*value=[\'\"]?(\d+)[\'\"]?', row)
                    if not m_chn:
                        m_chn = re.search(r'value=[\'\"]?(\d+)[\'\"]?[^>]*name=[\'\"]?chn[\'\"]?', row)
                    if m_chn:
                        cid = m_chn.group(1)
                        # Extract version like 19.0b, 24.0a
                        m_ver = re.search(r'(\d+\.\d+[a-z]?)', row)
                        ver_str = m_ver.group(1) if m_ver else None
                        # Extract year like 令和7年, 令和6年度, 2025年, 2024年度, R06
                        m_year = re.search(r'(令和\s*\d+\s*(?:年|年度)?|\d{4}\s*(?:年|年度)?|平成\s*\d+\s*(?:年|年度)?|R\d+)', row)
                        year_str = m_year.group(1) if m_year else None
                        # Extract explicit source created date and key stated by provider
                        key_str, date_str = extract_creation_date_from_html(row)

                        # Strip html tags for provenance
                        clean_text = re.sub(r'<[^>]+>', ' ', row).strip()
                        matched_candidates.append({
                            'chn': cid,
                            'version': ver_str,
                            'year': year_str,
                            'created_date_key': key_str,
                            'created_date': date_str,
                            'text': clean_text
                        })

            if not matched_candidates:
                sys.exit(f"FATAL: No dataset candidates matching kind '{kind_label}' found for city {city_code}.")

            # Rule: Select by explicit provider metadata (highest version or latest year), no blind head assumption
            def ver_key(item):
                v = item['version']
                if not v:
                    return (0, 0, 0)
                m = re.match(r'(\d+)\.(\d+)([a-z]?)', v)
                if m:
                    major = int(m.group(1))
                    minor = int(m.group(2))
                    patch = ord(m.group(3)) if m.group(3) else 0
                    return (major, minor, patch)
                return (0, 0, 0)

            sorted_candidates = sorted(matched_candidates, key=ver_key, reverse=True)
            chosen = sorted_candidates[0]
            chn_val = chosen['chn']
            resolved_version = chosen['version']
            resolved_year = chosen['year']
            resolved_created_date_key = chosen['created_date_key']
            resolved_created_date = chosen['created_date']
            raw_row_text = chosen['text']

            # RULE: If year or version is unknown/undetermined, HARD STOP immediately
            if not resolved_version or not resolved_year:
                sys.exit(f"FATAL HARD STOP [DISTRICT_DATA_ACQUISITION_RULE.md §3.1, §7.2]: Failed to determine version or year from provider metadata! (version='{resolved_version}', year='{resolved_year}')")

            # Check if final ZIP already exists (overwrite strictly prohibited)
            final_zip_target = os.path.join(out_dir, f"{city_code}-{resolved_version}.zip")
            if os.path.exists(final_zip_target):
                sys.exit(f"FATAL HARD STOP: Destination archive ZIP already exists (overwrite strictly prohibited): {final_zip_target}")

            print(f"[MLIT Fetcher] Resolved metadata: Version={resolved_version}, Year={resolved_year}, CreatedDate={resolved_created_date or 'Searching in archive...'}, chn={chn_val}")

        # Step 3: Accept stipulation
        print("[MLIT Fetcher] Step 3: Handling terms & stipulation confirmation...")
        stipulation_url = 'https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_view_stipulation.cgi'
        data_step3 = urllib.parse.urlencode({'data_kind': data_kind, 'chn': chn_val}).encode('euc-jp')
        req3 = urllib.request.Request(stipulation_url, data=data_step3)
        with opener.open(req3) as resp:
            resp.read()

        # Step 4: Download files confirmation page to extract ZIP download path
        print("[MLIT Fetcher] Step 4: Confirming download file path...")
        dl_confirm_url = 'https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_download_files.cgi'
        data_step4 = urllib.parse.urlencode({'data_kind': data_kind, 'chn': chn_val, 'sbm': '', 'srh': '', 'oa': '', 'pc': pref_code}).encode('euc-jp')
        req4 = urllib.request.Request(dl_confirm_url, data=data_step4)

        zip_subpath = None
        with opener.open(req4) as resp:
            text4 = resp.read().decode('euc-jp', errors='replace')
            m_zip = re.search(r"DownLd_isj\([^,]+,[^,]+,[\'\"]([^\'\"]+\.zip)[\'\"]", text4)
            if m_zip:
                zip_subpath = m_zip.group(1)
                print(f"[MLIT Fetcher] Resolved ZIP remote URL path: {zip_subpath}")
            else:
                zip_subpath = f"/isj/dls/data/{resolved_version}/{city_code}-{resolved_version}.zip"
                print(f"[MLIT Fetcher] Fallback constructed ZIP path: {zip_subpath}")

        # Step 5: Direct ZIP download to temporary directory
        full_zip_url = urllib.parse.urljoin('https://nlftp.mlit.go.jp', zip_subpath)
        print(f"[MLIT Fetcher] Step 5: Downloading ZIP from {full_zip_url}...")
        temp_zip_path = os.path.join(temp_work_dir, f"{city_code}-download.zip")
        req_zip = urllib.request.Request(full_zip_url)
        with opener.open(req_zip) as resp_zip:
            zip_bytes = resp_zip.read()
            with open(temp_zip_path, 'wb') as f:
                f.write(zip_bytes)
            print(f"[MLIT Fetcher] SUCCESS: Downloaded {len(zip_bytes)} bytes")

        zip_hash = compute_sha256(temp_zip_path)

        # Step 6: Extract ZIP
        temp_extract_dir = os.path.join(temp_work_dir, "extracted")
        os.makedirs(temp_extract_dir, exist_ok=True)
        print(f"[MLIT Fetcher] Step 6: Extracting ZIP archive...")
        with zipfile.ZipFile(temp_zip_path, 'r') as zf:
            zf.extractall(temp_extract_dir)
            extracted_files = zf.namelist()
            print(f"[MLIT Fetcher] Extracted {len(extracted_files)} files: {extracted_files}")

        # Step 7: Locate and normalize CSV to UTF-8
        raw_csv_path = None
        for root, dirs, files in os.walk(temp_extract_dir):
            for f in files:
                if f.endswith('.csv') and f != 'reference_points.csv':
                    raw_csv_path = os.path.join(root, f)
                    break
            if raw_csv_path:
                break

        if not raw_csv_path:
            sys.exit(f"FATAL: No CSV file found inside extracted MLIT archive.")

        temp_normalized_csv = os.path.join(temp_work_dir, 'reference_points.csv')
        print(f"[MLIT Fetcher] Step 7: Normalizing CP932 CSV ({raw_csv_path}) to UTF-8...")

        row_count = 0
        with open(raw_csv_path, 'r', encoding='cp932', errors='replace') as infile, \
             open(temp_normalized_csv, 'w', encoding='utf-8', newline='\n') as outfile:
            reader = csv.reader(infile)
            writer = csv.writer(outfile, lineterminator='\n')
            header = next(reader)
            writer.writerow(header)
            for row in reader:
                writer.writerow(row)
                row_count += 1

        print(f"[MLIT Fetcher] Normalized {row_count} rows.")

        # Step 8: Validate explicit source creation date stated by provider
        if not resolved_created_date:
            # Search inside extracted metadata files for explicit creation date
            for root, dirs, files in os.walk(temp_extract_dir):
                for f in files:
                    if f.endswith('.xml') or f.lower().startswith('readme') or f.endswith('.txt'):
                        meta_fpath = os.path.join(root, f)
                        try:
                            with open(meta_fpath, 'r', encoding='utf-8', errors='ignore') as mf:
                                content = mf.read()
                                k, d = extract_creation_date_from_metadata(content)
                                if k and d:
                                    resolved_created_date_key = k
                                    resolved_created_date = d
                                    break
                        except Exception:
                            pass
                if resolved_created_date:
                    break

        if not resolved_created_date:
            sys.exit(f"FATAL HARD STOP [DISTRICT_DATA_ACQUISITION_RULE.md §7.2]: Explicit source creation date not stated by provider for city {city_code}! (Update/release dates cannot substitute creation date, and file timestamps cannot be used as substitute)")

        # Step 9: Prepare Provenance metadata
        provenance_data = {
            'municipality_code': city_code,
            'data_kind': kind_label,
            'data_kind_code': data_kind,
            'resolved_version': resolved_version,
            'resolved_year': resolved_year,
            'source_creation_date_key': resolved_created_date_key,
            'source_creation_date': resolved_created_date,
            'download_url': full_zip_url,
            'download_timestamp_utc': datetime.now(timezone.utc).isoformat(),
            'zip_sha256': zip_hash,
            'record_count': row_count,
            'provider_metadata_row': raw_row_text
        }
        if abr_reports:
            provenance_data['abr_verification'] = abr_reports

        temp_provenance_path = os.path.join(temp_work_dir, 'provenance.json')
        with open(temp_provenance_path, 'w', encoding='utf-8') as f:
            json.dump(provenance_data, f, ensure_ascii=False, indent=2)

        # Step 10: Atomic move to target destination
        os.makedirs(out_dir, exist_ok=True)
        final_zip_path = os.path.join(out_dir, f"{city_code}-{resolved_version}.zip")
        shutil.move(temp_zip_path, final_zip_path)
        shutil.move(temp_normalized_csv, normalized_csv)
        shutil.move(temp_provenance_path, provenance_path)
        print(f"[MLIT Fetcher] SUCCESS: Output files committed to {out_dir}")
        return normalized_csv, provenance_path

    except Exception as err:
        print(f"[MLIT Fetcher] ERROR during execution: {err}", file=sys.stderr)
        raise
    finally:
        if os.path.exists(temp_work_dir):
            shutil.rmtree(temp_work_dir)

def verify_abr_master(city_code, abr_files=None, abr_dir=None):
    """
    Verify presence and integrity of pre-positioned official Digital Agency ABR town master CSV.
    Does NOT claim autonomous acquisition; strictly verifies placed official primary archive.
    Verifies:
    - File presence and read access
    - Official header inspection (supporting both official English and Japanese column names)
    - Mandatory presence of all 5 required columns:
      1. lg_code / 全国地方公共団体コード
      2. city_name / 市区町村名
      3. city_kana / 市区町村名_カナ
      4. oaza_cho / 町字名
      5. oaza_cho_kana / 町字名_カナ
    - Matching 5-digit prefix of 6-digit official lg_code (preserving leading zeroes)
    - Strict validation of mandatory column values per record (no blind fallback on city name)
    - Total record count in file
    - Presence of records matching specified municipality code
    - SHA-256 hash calculation
    """
    abr_candidates = []
    if abr_files:
        abr_candidates.extend(abr_files)
    if abr_dir and os.path.exists(abr_dir):
        for root, dirs, files in os.walk(abr_dir):
            for f in files:
                if f.endswith('.csv'):
                    abr_candidates.append(os.path.join(root, f))

    if not abr_candidates:
        sys.exit(f"FATAL HARD STOP: No ABR town master CSV specified or found in --abr-file / --abr-dir for city {city_code}.")

    verified_reports = []
    matched_city_records_total = 0
    city_code_5 = city_code[:5]

    for abr_path in abr_candidates:
        if not os.path.exists(abr_path):
            sys.exit(f"FATAL HARD STOP: Specified ABR file not found: {abr_path}")

        print(f"[ABR Verifier] Inspecting official ABR master: {abr_path}...")
        file_hash = compute_sha256(abr_path)

        with open(abr_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            try:
                header = next(reader)
            except StopIteration:
                sys.exit(f"FATAL HARD STOP: ABR file is empty: {abr_path}")

            col_code_idx = -1
            col_city_idx = -1
            col_city_kana_idx = -1
            col_type_idx = -1
            col_town_idx = -1
            col_town_kana_idx = -1
            col_koaza_idx = -1
            col_koaza_kana_idx = -1

            for idx, col in enumerate(header):
                c = col.strip()
                if c in ['全国地方公共団体コード', 'lg_code', '市区町村コード', 'city_code']:
                    col_code_idx = idx
                elif c in ['市区町村名', 'city_name', 'city']:
                    col_city_idx = idx
                elif c in ['市区町村名_カナ', 'city_kana']:
                    col_city_kana_idx = idx
                elif c in ['町字区分コード', 'machiaza_type']:
                    col_type_idx = idx
                elif c in ['町字名', 'oaza_cho', 'town']:
                    col_town_idx = idx
                elif c in ['町字名_カナ', 'oaza_cho_kana', 'town_kana']:
                    col_town_kana_idx = idx
                elif c in ['小字名', 'koaza']:
                    col_koaza_idx = idx
                elif c in ['小字名_カナ', 'koaza_kana']:
                    col_koaza_kana_idx = idx

            missing_cols = []
            if col_code_idx == -1: missing_cols.append("全国地方公共団体コード / lg_code")
            if col_city_idx == -1: missing_cols.append("市区町村名 / city_name / city")
            if col_city_kana_idx == -1: missing_cols.append("市区町村名_カナ / city_kana")
            if col_town_idx == -1: missing_cols.append("町字名 / oaza_cho / town")
            if col_town_kana_idx == -1: missing_cols.append("町字名_カナ / oaza_cho_kana / town_kana")

            if missing_cols:
                sys.exit(f"FATAL HARD STOP: Missing mandatory ABR column(s) ({', '.join(missing_cols)}) in header: {header}")

            total_file_records = 0
            matched_for_this_file = 0
            required_indices = [col_code_idx, col_city_idx, col_city_kana_idx, col_town_idx, col_town_kana_idx]
            if col_type_idx != -1:
                required_indices.append(col_type_idx)
            max_idx = max(required_indices)

            for line_no, row in enumerate(reader, start=2):
                total_file_records += 1
                if len(row) <= max_idx:
                    sys.exit(f"FATAL HARD STOP: Malformed ABR CSV row at line {line_no} in {abr_path} (expected at least {max_idx + 1} columns): {row}")

                # Keep leading zeroes as string!
                code_val = row[col_code_idx].strip()
                if not code_val:
                    sys.exit(f"FATAL HARD STOP: Empty lg_code at line {line_no} in {abr_path}")

                # Compare 5-digit prefix preserving leading zeroes (lg_code is 6 digits with check digit)
                if len(code_val) >= 5 and code_val[:5] == city_code_5:
                    c_name = row[col_city_idx].strip()
                    c_kana = row[col_city_kana_idx].strip()
                    if not c_name or not c_kana:
                        sys.exit(
                            f"FATAL HARD STOP: Missing mandatory municipality value at line {line_no} in {abr_path}: "
                            f"code='{code_val}', city='{c_name}', city_kana='{c_kana}'"
                        )
                    matched_for_this_file += 1

            if total_file_records == 0:
                sys.exit(f"FATAL HARD STOP: ABR file {abr_path} has 0 records!")

            matched_city_records_total += matched_for_this_file
            verified_reports.append({
                'filepath': os.path.abspath(abr_path),
                'sha256': file_hash,
                'total_records': total_file_records,
                'matched_municipality_records': matched_for_this_file,
                'header_columns': header
            })

    if matched_city_records_total == 0:
        sys.exit(
            f"FATAL HARD STOP: Inspected ABR files do NOT contain records for municipality code '{city_code}'! "
            f"Checked files: {[r['filepath'] for r in verified_reports]}"
        )

    print(f"[ABR Verifier] PASS: Verified {len(verified_reports)} ABR file(s). Target municipality matched {matched_city_records_total} records.")
    return verified_reports

def verify_estat_data(city_code, estat_dir):
    """
    Verify presence and integrity of e-Stat Census Small Area Shapefile (Phase 2 legacy support).
    """
    if not estat_dir:
        return None, None
    c_dir = os.path.join(estat_dir, city_code)
    shp_path = os.path.join(c_dir, f"r2ka{city_code}.shp")
    dbf_path = os.path.join(c_dir, f"r2ka{city_code}.dbf")

    if os.path.exists(shp_path) and os.path.exists(dbf_path):
        print(f"[e-Stat Verifier] Verified existing e-Stat Shapefile & DBF at {c_dir}")
        return shp_path, dbf_path

    zip_candidates = [f for f in os.listdir(c_dir) if f.endswith('.zip')] if os.path.exists(c_dir) else []
    if zip_candidates:
        zip_path = os.path.join(c_dir, zip_candidates[0])
        print(f"[e-Stat Verifier] Extracting e-Stat ZIP {zip_path}...")
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(c_dir)
        if os.path.exists(shp_path) and os.path.exists(dbf_path):
            return shp_path, dbf_path

    print(f"[e-Stat Verifier] Note: e-Stat Shapefile not found at {shp_path} (Phase 2 attribute).")
    return None, None

def main():
    args = parse_args()
    print("=" * 70)
    print("DISTRICT DATA AUTONOMOUS FETCHER & ABR VERIFIER (DISTRICT_DATA_ACQUISITION_RULE.md)")
    print(f"Target Municipality Code: {args.city_code}")
    print(f"Ref Output Directory:     {args.ref_dir}")
    print("=" * 70)

    # 1. Verify pre-positioned official ABR town master if specified
    abr_reports = None
    if args.abr_file or args.abr_dir:
        abr_reports = verify_abr_master(args.city_code, abr_files=args.abr_file, abr_dir=args.abr_dir)

    # 2. Fetch MLIT location reference data
    ref_csv, prov_json = fetch_mlit_location_reference(
        city_code=args.city_code,
        ref_dir=args.ref_dir,
        data_kind=args.data_kind,
        abr_reports=abr_reports
    )
    if args.estat_dir:
        verify_estat_data(args.city_code, args.estat_dir)

    print("=" * 70)
    print("[QG-1 Autonomous Fetch Gate] PASS: Reference data acquired with full provenance.")
    print(f"  - MLIT Reference:  {ref_csv}")
    print(f"  - Provenance:      {prov_json}")
    if abr_reports:
        print(f"  - ABR Verified:    {len(abr_reports)} file(s)")
    print("=" * 70)

if __name__ == '__main__':
    main()
