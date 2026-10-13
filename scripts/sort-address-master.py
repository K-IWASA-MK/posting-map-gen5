#!/usr/bin/env python3
"""
sort-address-master.py

address_master.csv の各レコードを日本語の読み順（あいうえお順・五十音順）に整列する標準スクリプト。

【絶対順守規則】
1. 表示値（town_name等の全カラム）は1文字も改変しない。
2. rowId（1..N）の各町丁目の既存数値は100%保持する（振り直し・改番厳禁）。
3. 読み順は日本郵便公式データ（公定一次情報）に基づくソート専用キー（sort_kana）によって決定する。
4. 同一町名で複数小地域が存在する場合は e_stat_code 昇順による安定した副順序を使用する。
"""

import os
import sys
import re
import csv
import argparse

# 日本郵便公式データに基づく桑名市町名カナ辞書 (公定一次資料)
POSTAL_KANA_KUWANA = {
    "相生町": "アイオイチョウ",
    "相川町": "アイカワチョウ",
    "青葉町": "アオバチョウ",
    "赤須賀": "アカスカ",
    "赤尾": "アコオ",
    "赤尾台": "アコオダイ",
    "油町": "アブラマチ",
    "伊賀町": "イガマチ",
    "和泉": "イズミ",
    "一色町": "イッシキマチ",
    "今片町": "イマカタマチ",
    "今北町": "イマキタマチ",
    "今島": "イマジマ",
    "今中町": "イマナカマチ",
    "入江葭町": "イリエヨシマチ",
    "上野": "ウエノ",
    "内堀": "ウチボリ",
    "馬道": "ウマミチ",
    "梅園通": "ウメゾノドオリ",
    "駅元町": "エキモトチョウ",
    "江戸町": "エドマチ",
    "江場": "エバ",
    "大貝須": "オオガイス",
    "大仲新田": "オオナカシンデン",
    "大山田": "オオヤマダ",
    "尾野山": "オノヤマ",
    "蠣塚新田": "カキヅカシンデン",
    "神楽町": "カグラチョウ",
    "掛樋": "カケヒ",
    "鍜冶町": "カジマチ",
    "春日町": "カスガチョウ",
    "霞町": "カスミチョウ",
    "片町": "カタマチ",
    "上之輪新田": "カミノワシンデン",
    "上深谷部": "カミフカヤベ",
    "萱町": "カヤマチ",
    "嘉例川": "カレガワ",
    "川口町": "カワグチチョウ",
    "川崎町": "カワサキチョウ",
    "北魚町": "キタウオマチ",
    "北川原台": "キタガワラダイ",
    "北寺町": "キタテラマチ",
    "北鍋屋町": "キタナベヤマチ",
    "北別所": "キタベッシヨ",
    "希望ケ丘": "キボウガオカ",
    "京橋町": "キョウバシチョウ",
    "京町": "キョウマチ",
    "清竹の丘": "キヨタケノオカ",
    "桑名": "クワナ",
    "桑部": "クワベ",
    "小泉": "コイズミ",
    "小貝須": "コガイス",
    "寿町": "コトブキチョウ",
    "紺屋町": "コンヤマチ",
    "五反田": "ゴタンダ",
    "坂井": "サカイ",
    "桜通": "サクラドオリ",
    "さくらの丘": "サクラノオカ",
    "里町": "サトマチ",
    "三栄町": "サンエイチョウ",
    "参宮通": "サングウドオリ",
    "三之丸": "サンノマル",
    "汐見町": "シオミチョウ",
    "繁松新田": "シゲマツシンデン",
    "志知": "シチ",
    "島田": "シマダ",
    "清水町": "シミズチョウ",
    "下深谷部": "シモフカヤベ",
    "職人町": "ショクニンマチ",
    "城山台": "シロヤマダイ",
    "新倉持": "シンクラモチ",
    "神成町": "シンセイチョウ",
    "新地": "シンチ",
    "新築町": "シンチクチョウ",
    "新西方": "シンニシカタ",
    "新町": "シンマチ",
    "新屋敷": "シンヤシキ",
    "新矢田": "シンヤダ",
    "地蔵": "ジゾウ",
    "城南萱町": "ジョウナンカヤマチ",
    "末広町": "スエヒロチョウ",
    "住吉町": "スミヨシチョウ",
    "船馬町": "センバチョウ",
    "桑栄町": "ソウエイチョウ",
    "外堀": "ソトボリ",
    "太一丸": "タイチマル",
    "太平町": "タイヘイチョウ",
    "高塚町": "タカツカチョウ",
    "立花町": "タチバナチョウ",
    "立田町": "タツタチョウ",
    "多度町猪飼": "タドチョウイカイ",
    "多度町大鳥居": "タドチョウオオドリイ",
    "多度町小山": "タドチョウオヤマ",
    "多度町小山台": "タドチョウオヤマダイ",
    "多度町香取": "タドチョウカトリ",
    "多度町上之郷": "タドチョウカミノゴウ",
    "多度町北猪飼": "タドチョウキタイカイ",
    "多度町古野": "タドチョウコノ",
    "多度町下野代": "タドチョウシモノシロ",
    "多度町多度": "タドチョウタド",
    "多度町力尾": "タドチョウチカラオ",
    "多度町戸津": "タドチョウトヅ",
    "多度町中須": "タドチョウナカズ",
    "多度町肱江": "タドチョウヒジエ",
    "多度町平古": "タドチョウヒラコ",
    "多度町美鹿": "タドチョウビロク",
    "多度町福永": "タドチョウフクナガ",
    "多度町御衣野": "タドチョウミゾノ",
    "多度町南之郷": "タドチョウミナミノゴウ",
    "多度町柚井": "タドチョウユイ",
    "田町": "タマチ",
    "太夫": "タユウ",
    "大央町": "ダイオウチョウ",
    "大福": "ダイフク",
    "中央町": "チュウオウチョウ",
    "千代田町": "チヨダチョウ",
    "筑紫": "ツクシ",
    "筒尾": "ツツオ",
    "堤原": "ツツミハラ",
    "伝馬町": "テンマチョウ",
    "常盤町": "トキワチョウ",
    "殿町": "トノマチ",
    "友村": "トモムラ",
    "中山町": "ナカヤマチョウ",
    "長島町赤地": "ナガシマチョウアカジ",
    "長島町浦安": "ナガシマチョウウラヤス",
    "長島町大倉": "ナガシマチョウオオクラ",
    "長島町大島": "ナガシマチョウオオジマ",
    "長島町押付": "ナガシマチョウオシツケ",
    "長島町鎌ケ地": "ナガシマチョウカマガンジ",
    "長島町上坂手": "ナガシマチョウカミサカテ",
    "長島町北殿名": "ナガシマチョウキタトノメ",
    "長島町源部外面": "ナガシマチョウゲンベドモ",
    "長島町高座": "ナガシマチョウコウザ",
    "長島町小島": "ナガシマチョウコジマ",
    "長島町駒江": "ナガシマチョウコマエ",
    "長島町下坂手": "ナガシマチョウシモサカテ",
    "長島町新所": "ナガシマチョウシンショ",
    "長島町杉江": "ナガシマチョウスギエ",
    "長島町千倉": "ナガシマチョウチクラ",
    "長島町出口": "ナガシマチョウデグチ",
    "長島町十日外面": "ナガシマチョウトオカドモ",
    "長島町殿名": "ナガシマチョウトノメ",
    "長島町中川": "ナガシマチョウナカガワ",
    "長島町長島萱町": "ナガシマチョウナガシマカヤマチ",
    "長島町長島下町": "ナガシマチョウナガシマシモマチ",
    "長島町長島中町": "ナガシマチョウナガシマナカマチ",
    "長島町西川": "ナガシマチョウニシカワ",
    "長島町西外面": "ナガシマチョウニシドモ",
    "長島町西外面市街": "ナガシマチョウニシドモシガイ",
    "長島町白鶏": "ナガシマチョウハッケ",
    "長島町東殿名": "ナガシマチョウヒガシトノメ",
    "長島町平方": "ナガシマチョウヒラカタ",
    "長島町福豊": "ナガシマチョウフクトヨ",
    "長島町福吉": "ナガシマチョウフクヨシ",
    "長島町又木": "ナガシマチョウマタギ",
    "長島町又木市街": "ナガシマチョウマタギシガイ",
    "長島町松蔭": "ナガシマチョウマツカゲ",
    "長島町松ケ島": "ナガシマチョウマツガシマ",
    "長島町松之木": "ナガシマチョウマツノキ",
    "長島町間々": "ナガシマチョウママ",
    "長島町横満蔵": "ナガシマチョウヨコマクラ",
    "長島町葭ケ須": "ナガシマチョウヨシガス",
    "西方": "ニシカタ",
    "西金井": "ニシカナイ",
    "西正和台": "ニシセイワダイ",
    "西鍋屋町": "ニシナベヤマチ",
    "西別所": "ニシベッシヨ",
    "西矢田町": "ニシヤダマチ",
    "西汰上": "ニシユリアゲ",
    "額田": "ヌカタ",
    "野田": "ノダ",
    "能部": "ノンベ",
    "芳ケ崎": "ハガサキ",
    "蓮見町": "ハスミチョウ",
    "八間通": "ハチケンドオリ",
    "八幡町": "ハチマンチョウ",
    "播磨": "ハリマ",
    "稗田": "ヒエダ",
    "東方": "ヒガシカタ",
    "東金井": "ヒガシカナイ",
    "東正和台": "ヒガシセイワダイ",
    "東太一丸": "ヒガシタイチマル",
    "東鍋屋町": "ヒガシナベヤマチ",
    "東野": "ヒガシノ",
    "東矢田町": "ヒガシヤダマチ",
    "東汰上": "ヒガシユリアゲ",
    "陽だまりの丘": "ヒダマリノオカ",
    "広見ケ丘": "ヒロミガオカ",
    "枇杷島台": "ビワジマダイ",
    "深谷町": "フカヤチョウ",
    "福江": "フクエ",
    "福江町": "フクエマチ",
    "福岡町": "フクオカチョウ",
    "福島": "フクジマ",
    "福島新町": "フクジマシンマチ",
    "福地": "フクチ",
    "藤が丘": "フジガオカ",
    "風呂町": "フロマチ",
    "宝殿町": "ホウデンマチ",
    "星川": "ホシカワ",
    "星見ケ丘": "ホシミガオカ",
    "本願寺": "ホンガンジ",
    "本町": "ホンマチ",
    "益生町": "マスオチョウ",
    "増田": "マスダ",
    "松並町": "マツナミチョウ",
    "松ノ木": "マツノキ",
    "三崎通": "ミサキドオリ",
    "三ツ矢橋": "ミツヤバシ",
    "南魚町": "ミナミウオマチ",
    "南寺町": "ミナミテラマチ",
    "宮通": "ミヤドオリ",
    "宮町": "ミヤマチ",
    "明正町": "メイセイチョウ",
    "元赤須賀": "モトアカスカ",
    "森忠": "モリタダ",
    "安永": "ヤスナガ",
    "矢田": "ヤダ",
    "矢田磧": "ヤダカワラ",
    "柳原": "ヤナギハラ",
    "有楽町": "ユウラクチョウ",
    "吉之丸": "ヨシノマル",
    "吉津屋町": "ヨツヤチョウ",
    "蓮花寺": "レンゲジ",
    "鍛冶町": "カジマチ",
    "星見ヶ丘": "ホシミガオカ",
    "芳ヶ崎": "ハガサキ",
    "蛎塚新田": "カキヅカシンデン",
    "上之輪": "カミノワ",
    "巖新田": "イワオシンデン",
    "長島町老松": "ナガシマチョウオイマツ",
    "小貝須字柳原": "コガイスアザヤナギハラ",
    "多度町御衣野・下野代": "タドチョウミゾノ・シモノシロ"
}

CHOME_NUM_MAP = {
    "一丁目": "01",
    "二丁目": "02",
    "三丁目": "03",
    "四丁目": "04",
    "五丁目": "05",
    "六丁目": "06",
    "七丁目": "07",
    "八丁目": "08",
    "九丁目": "09",
    "十丁目": "10"
}

def resolve_sort_key(row):
    """
    row からソート専用キー (sort_kana, chome_num, e_stat_code_int) を導出する。
    town_name の表示文字列そのものは一切変更しない。
    """
    town_name = row["town_name"]

    # 1. 大字接頭辞の除去（ソート専用キー用）
    core_name = re.sub(r"^大字", "", town_name)

    # 2. 丁目部分の分離
    chome_part = ""
    chome_match = re.search(r"([一二三四五六七八九十]+丁目)$", core_name)
    base_name = core_name
    if chome_match:
        chome_part = chome_match.group(1)
        base_name = core_name[:-len(chome_part)]

    # 3. カナ引き当て
    base_kana = None
    if base_name in POSTAL_KANA_KUWANA:
        base_kana = POSTAL_KANA_KUWANA[base_name]
    elif core_name in POSTAL_KANA_KUWANA:
        base_kana = POSTAL_KANA_KUWANA[core_name]

    if not base_kana:
        raise ValueError(f"FATAL: Unresolved reading kana for town_name='{town_name}' (base='{base_name}')")

    chome_num = CHOME_NUM_MAP.get(chome_part, "00")
    e_stat_code = int(row.get("e_stat_code") or 0)

    return (base_kana, chome_num, e_stat_code)

def main():
    parser = argparse.ArgumentParser(description="Sort address_master.csv in Japanese alphabetical reading order without altering rowId or values.")
    parser.add_argument("--input", default="data/address_master.csv", help="Input address_master.csv path")
    parser.add_argument("--output", default="data/address_master.csv", help="Output address_master.csv path")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"FATAL: Input file not found: {args.input}")

    with open(args.input, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        original_header = reader.fieldnames
        original_rows = list(reader)

    original_count = len(original_rows)
    print(f"📊 Loaded {original_count} records from {args.input}")

    # 全件のソートキー解決テスト
    for r in original_rows:
        try:
            resolve_sort_key(r)
        except Exception as err:
            sys.exit(f"❌ Error at rowId={r.get('rowId')}: {err}")

    print("✅ All records successfully resolved sort_kana from official Japan Post data.")

    # ソート実行
    sorted_rows = sorted(original_rows, key=resolve_sort_key)

    # 整合性検証
    assert len(sorted_rows) == original_count, "Record count mismatch after sort"

    orig_row_ids = set(int(r["rowId"]) for r in original_rows)
    sorted_row_ids = set(int(r["rowId"]) for r in sorted_rows)
    assert orig_row_ids == sorted_row_ids, "rowId set changed after sort"
    assert orig_row_ids == set(range(1, original_count + 1)), "rowId is not a continuous sequence from 1 to N"

    orig_pop = sum(int(r["population"]) for r in original_rows if r.get("population"))
    sorted_pop = sum(int(r["population"]) for r in sorted_rows if r.get("population"))
    assert orig_pop == sorted_pop, f"Population sum mismatch: {orig_pop} vs {sorted_pop}"

    orig_hh = sum(int(r["households"]) for r in original_rows if r.get("households"))
    sorted_hh = sum(int(r["households"]) for r in sorted_rows if r.get("households"))
    assert orig_hh == sorted_hh, f"Households sum mismatch: {orig_hh} vs {sorted_hh}"

    # 出力 (LF改行)
    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        writer = csv.DictWriter(f, fieldnames=original_header, lineterminator="\n")
        writer.writeheader()
        writer.writerows(sorted_rows)

    print(f"🎉 Successfully sorted and wrote {len(sorted_rows)} records to {args.output}")
    print(f"   First: rowId={sorted_rows[0]['rowId']}, town_name={sorted_rows[0]['town_name']}")
    print(f"   Last:  rowId={sorted_rows[-1]['rowId']}, town_name={sorted_rows[-1]['town_name']}")

if __name__ == "__main__":
    main()
