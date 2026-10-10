"""绘制冻结行业事件的前后走势。依赖本机已有 matplotlib；不读写数据库。"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "支撑/tmp/夜间板块双线趋势回测"
data = json.loads((OUT / "反弹择时与选板增强复核.json").read_text())
plt.rcParams.update({"font.family": "PingFang SC", "axes.unicode_minus": False,
                     "font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
COLORS = {"行业等权": "#176b80", "沪深300": "#aa6b35", "上证指数": "#76767f", "入选行业": "#c54350"}


def decorate(ax):
    ax.axhline(0, color="#bbbbbb", linewidth=0.8)
    ax.axvline(0, color="#333333", linewidth=0.9, linestyle="--")
    ax.axvspan(0, 20, color="#176b80", alpha=0.055)
    ax.yaxis.set_major_formatter(PercentFormatter(1))
    ax.grid(axis="y", color="#dddddd", linewidth=0.6, alpha=0.7)
    ax.set_xlabel("相对信号日的交易日（0＝信号日收盘）")
    ax.set_ylabel("相对信号日收盘的涨跌幅")


fig, axes = plt.subplots(1, 2, figsize=(14, 5.2), sharey=True)
for ax, name in zip(axes, ["信号日期", "间隔20日"]):
    cohort = data["curves"][name]
    for key in ["行业等权", "沪深300", "上证指数"]:
        ax.plot([p["offset"] for p in cohort["points"]], [p[key] for p in cohort["points"]],
                label=key, color=COLORS[key], linewidth=2)
    if name == "信号日期":
        reference = data["curves"]["全部可比日期"]["points"]
        ax.plot([p["offset"] for p in reference], [p["行业等权"] for p in reference],
                label="全部可比日·行业等权", color="#176b80", linewidth=1.4, linestyle=":")
    decorate(ax)
    ax.set_title(f"{'每个信号日等权' if name == '信号日期' else '每隔至少20日取首次信号'} · {cohort['count']}个完整窗口", loc="left", fontsize=12)
    ax.legend(frameon=False, loc="upper right", fontsize=9)
fig.suptitle("行业信号前后：通常已经反弹，再观察是否延续", x=0.06, ha="left", fontsize=17)
fig.text(0.06, 0.01, "曲线为收盘路径均值，未扣费；行业等权每日再平衡。只保留完整−40至+40日且宽基核验行情齐全的窗口。\n交易收益另按次日开盘至第21日开盘统计；曲线不可直接当作可交易组合收益。", fontsize=9, color="#555555")
fig.tight_layout(rect=[0, 0.095, 1, 0.94])
fig.savefig(OUT / "夜间板块信号前后走势.png", dpi=170)
plt.close(fig)

fig, axes = plt.subplots(2, 2, figsize=(14, 9.0))
for ax, episode in zip(axes.flat, data["episodes"]):
    points = episode["points"]
    for key in ["入选行业", "行业等权", "沪深300"]:
        ax.plot([p["offset"] for p in points], [p[key] for p in points], label=key,
                color=COLORS[key], linewidth=1.8)
    decorate(ax)
    ax.set_title(f"{episode['date']} · 当日{len(episode['codes'])}个行业信号", loc="left", fontsize=12)
    ax.legend(frameon=False, fontsize=9, loc="upper left")
fig.suptitle("三个高贡献月份的首次信号，与一个失败案例", x=0.06, ha="left", fontsize=17)
fig.text(0.06, 0.012, "案例按已知结果选择，仅解释走势；不是随机样本或样本外证明。宽基使用按原始日期远端核验的行情。\n入选行业按当日信号等权；0日收盘归零，路径未扣费用。阴影为0至+20日。", fontsize=9, color="#555555")
fig.tight_layout(rect=[0, 0.075, 1, 0.95])
fig.savefig(OUT / "夜间板块反弹与失败案例.png", dpi=170)
plt.close(fig)
print(OUT / "夜间板块信号前后走势.png")
print(OUT / "夜间板块反弹与失败案例.png")
