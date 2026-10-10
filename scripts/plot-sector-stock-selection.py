"""绘制同板块同日选股对照；只使用研究JSON。"""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

NEXT = "--next" in sys.argv
ROOT = Path(__file__).resolve().parents[1] / ("支撑/tmp/夜间板块个股深化研究" if NEXT else "支撑/tmp/夜间板块个股选择研究")
data = json.loads((ROOT / "板块内个股选择验证.json").read_text())
rows = [r for r in data["matrix"] if r["exit"] == "固定20日" and r["slip_bps"] == 10 and r["rule"] != "盈利现金流质量"]
if NEXT:
    rows = [r for r in rows if r["rule"] in ["20日跌幅靠前", "止跌修复确认", "修复后按跌幅选股", "补涨修复各一只"]]
plt.rcParams.update({"font.family": "PingFang SC", "axes.unicode_minus": False, "font.size": 11,
                     "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(1, 2, figsize=(15, 5.6), gridspec_kw={"width_ratios": [1.1, 1]})
for i, row in enumerate(rows):
    value = row["excess"]["mean"] * 100
    ci = row["excess_month_ci"]
    color = "#176b80" if value >= 0 else "#aa5d45"
    axes[0].errorbar(value, i, xerr=[[value - ci["low"] * 100], [ci["high"] * 100 - value]],
                     fmt="o", color=color, ecolor=color, capsize=4, linewidth=1.8)
    axes[0].annotate(f"{value:+.2f}", (value, i), xytext=(0, 8), textcoords="offset points", ha="center", fontsize=9)
axes[0].axvline(0, color="#999999", linestyle="--", linewidth=1)
axes[0].set_yticks(range(len(rows)), [r["rule"] for r in rows])
axes[0].invert_yaxis()
axes[0].set_xlabel("相对同板块候选等权的均笔增益（百分点）")
axes[0].set_title(f"{rows[0]['returns']['count']}个共同可结算事件 · 月块95%描述区间", fontsize=12, loc="left")
axes[0].grid(axis="x", color="#dddddd", linewidth=0.6)
years = ["2022", "2023", "2024", "2025", "2026"]
values = np.array([[r["by_year"][year]["excess"]["mean"] * 100 for year in years] for r in rows])
axes[1].imshow(values, cmap="RdBu", vmin=-5, vmax=5, aspect="auto")
axes[1].set_xticks(range(len(years)), years)
axes[1].set_yticks(range(len(rows)), [r["rule"] for r in rows])
for i in range(len(rows)):
    for j in range(len(years)):
        axes[1].text(j, i, f"{values[i, j]:+.2f}", ha="center", va="center",
                     color="white" if abs(values[i, j]) > 3 else "#222222", fontsize=10)
axes[1].set_title("按信号年分组的选股增益（百分点）", fontsize=12, loc="left")
fig.suptitle("补涨与修复：简单组合未证明优于单独补涨" if NEXT else "行业反弹窗口内：补涨路线有候选价值，追强与成交额排序未增加收益", x=0.04, ha="left", fontsize=17)
fig.text(0.04, 0.017,
         "固定20日、最多两只主板股票；次日开盘、滑点10bp、佣金与历史印花税。未成交资金留现金。\n"
         "当前成分回看，非点时历史全集；区间未校正多重比较。2026截至冻结信号日；财务组覆盖不同，未混入这张图。", fontsize=9, color="#555555")
fig.tight_layout(rect=[0, 0.11, 1, 0.93], w_pad=3)
file = ROOT / ("补涨与修复深化对照.png" if NEXT else "板块内选股原则对照.png")
fig.savefig(file, dpi=170)
plt.close(fig)
print(file)
