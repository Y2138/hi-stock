#!/usr/bin/env python3
"""AKShare 接口发现、检查、只读调用与可复现导出工具。"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
from datetime import datetime
from pathlib import Path
import platform
import re
import sys
from typing import Any


接口名格式 = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def 加载模块():
    try:
        import akshare as ak
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"当前解释器未安装 AKShare：{sys.executable}\n"
            f"请运行：{sys.executable} -m pip install --upgrade akshare"
        ) from exc
    return ak


def 取得接口(ak, 名称: str):
    if not 接口名格式.fullmatch(名称) or 名称.startswith("_"):
        raise SystemExit(f"非法接口名：{名称}")
    接口 = getattr(ak, 名称, None)
    if 接口 is None or not callable(接口):
        raise SystemExit(f"当前 AKShare {ak.__version__} 不存在可调用接口：{名称}")
    return 接口


def 解析参数(原文: str) -> dict[str, Any]:
    try:
        参数 = json.loads(原文)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--params-json 不是合法 JSON：{exc}") from exc
    if not isinstance(参数, dict):
        raise SystemExit("--params-json 必须是 JSON 对象")
    return 参数


def 文档首行(对象: Any) -> str:
    文档 = inspect.getdoc(对象) or ""
    return next((行.strip() for 行 in 文档.splitlines() if 行.strip()), "")


def 命令检查(args: argparse.Namespace) -> int:
    ak = 加载模块()
    结果: dict[str, Any] = {
        "python": platform.python_version(),
        "python_64bit": platform.architecture()[0] == "64bit",
        "executable": sys.executable,
        "akshare": ak.__version__,
        "smoke": "未执行",
    }
    if args.smoke:
        try:
            数据 = 取得接口(ak, "stock_info_a_code_name")()
            行数 = len(数据)
            if 行数 == 0:
                raise RuntimeError("股票列表返回空表")
            结果["smoke"] = "通过"
            结果["smoke_rows"] = 行数
            结果["smoke_columns"] = [str(列) for 列 in 数据.columns]
        except Exception as exc:
            结果["smoke"] = "失败"
            结果["smoke_error"] = f"{type(exc).__name__}: {exc}"
            print(json.dumps(结果, ensure_ascii=False, indent=2))
            return 2
    print(json.dumps(结果, ensure_ascii=False, indent=2))
    return 0


def 命令搜索(args: argparse.Namespace) -> int:
    ak = 加载模块()
    关键词 = args.keyword.casefold()
    结果 = []
    for 名称 in sorted(dir(ak)):
        if 名称.startswith("_"):
            continue
        对象 = getattr(ak, 名称)
        if not callable(对象):
            continue
        摘要 = 文档首行(对象)
        if 关键词 not in 名称.casefold() and 关键词 not in 摘要.casefold():
            continue
        try:
            签名 = str(inspect.signature(对象))
        except (TypeError, ValueError):
            签名 = "(签名不可用)"
        结果.append({"api": 名称, "signature": 签名, "summary": 摘要})
        if len(结果) >= args.limit:
            break
    print(json.dumps({"akshare": ak.__version__, "matches": 结果}, ensure_ascii=False, indent=2))
    return 0 if 结果 else 1


def 命令说明(args: argparse.Namespace) -> int:
    ak = 加载模块()
    接口 = 取得接口(ak, args.api_name)
    try:
        签名 = str(inspect.signature(接口))
    except (TypeError, ValueError):
        签名 = "(签名不可用)"
    print(f"AKShare: {ak.__version__}")
    print(f"接口: {args.api_name}{签名}")
    print("\n" + (inspect.getdoc(接口) or "无 docstring"))
    return 0


def 文件哈希(路径: Path) -> str:
    哈希 = hashlib.sha256()
    with 路径.open("rb") as 文件:
        for 数据块 in iter(lambda: 文件.read(1024 * 1024), b""):
            哈希.update(数据块)
    return 哈希.hexdigest()


def 序列化值(值: Any) -> Any:
    if isinstance(值, (str, int, float, bool)) or 值 is None:
        return 值
    if hasattr(值, "isoformat"):
        return 值.isoformat()
    return str(值)


def 写出结果(数据: Any, 路径: Path) -> tuple[int | None, list[str]]:
    路径.parent.mkdir(parents=True, exist_ok=True)
    后缀 = 路径.suffix.lower()
    if hasattr(数据, "to_frame") and not hasattr(数据, "columns"):
        数据 = 数据.to_frame()
    if hasattr(数据, "columns"):
        if 后缀 == ".csv":
            数据.to_csv(路径, index=False, encoding="utf-8-sig")
        elif 后缀 in {".parquet", ".pq"}:
            try:
                数据.to_parquet(路径, index=False)
            except ImportError as exc:
                raise SystemExit("写 Parquet 需要 pyarrow 或 fastparquet") from exc
        elif 后缀 == ".json":
            数据.to_json(路径, orient="records", force_ascii=False, date_format="iso", indent=2)
        else:
            raise SystemExit("DataFrame 输出仅支持 .csv、.parquet、.pq 或 .json")
        return len(数据), [str(列) for 列 in 数据.columns]
    if 后缀 != ".json":
        raise SystemExit("非表格结果只能输出为 .json")
    路径.write_text(
        json.dumps(数据, ensure_ascii=False, indent=2, default=序列化值) + "\n",
        encoding="utf-8",
    )
    行数 = len(数据) if hasattr(数据, "__len__") else None
    return 行数, []


def 打印预览(数据: Any, 行数: int) -> None:
    if hasattr(数据, "head"):
        print(数据.head(行数).to_string(index=False))
        return
    print(json.dumps(数据, ensure_ascii=False, indent=2, default=序列化值))


def 命令调用(args: argparse.Namespace) -> int:
    ak = 加载模块()
    接口 = 取得接口(ak, args.api_name)
    参数 = 解析参数(args.params_json)
    获取时间 = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        数据 = 接口(**参数)
    except Exception as exc:
        raise SystemExit(
            f"AKShare 调用失败：api={args.api_name}, version={ak.__version__}, "
            f"error={type(exc).__name__}: {exc}"
        ) from exc

    实际行数 = len(数据) if hasattr(数据, "__len__") else None
    空结果 = 实际行数 == 0
    打印预览(数据, args.preview)

    摘要: dict[str, Any] = {
        "api": args.api_name,
        "params": 参数,
        "akshare_version": ak.__version__,
        "python_version": platform.python_version(),
        "fetched_at": 获取时间,
        "rows": 实际行数,
        "empty": 空结果,
    }
    if hasattr(数据, "columns"):
        摘要["columns"] = [str(列) for 列 in 数据.columns]

    if args.output:
        输出路径 = Path(args.output).expanduser().resolve()
        行数, 字段 = 写出结果(数据, 输出路径)
        摘要["rows"] = 行数
        摘要["columns"] = 字段
        摘要["output"] = str(输出路径)
        摘要["sha256"] = 文件哈希(输出路径)
        元数据路径 = Path(str(输出路径) + ".meta.json")
        元数据路径.write_text(
            json.dumps(摘要, ensure_ascii=False, indent=2, default=序列化值) + "\n",
            encoding="utf-8",
        )
        摘要["metadata"] = str(元数据路径)

    print("\n" + json.dumps(摘要, ensure_ascii=False, indent=2, default=序列化值))
    if args.require_data and 空结果:
        return 3
    return 0


def 构建解析器() -> argparse.ArgumentParser:
    解析器 = argparse.ArgumentParser(description="AKShare 接口发现、检查和只读调用工具")
    子命令 = 解析器.add_subparsers(dest="command", required=True)

    检查 = 子命令.add_parser("doctor", help="检查 Python 与 AKShare 环境")
    检查.add_argument("--smoke", action="store_true", help="联网获取 A 股代码列表")
    检查.set_defaults(handler=命令检查)

    搜索 = 子命令.add_parser("search", help="搜索当前版本公开接口")
    搜索.add_argument("keyword", help="接口名或 docstring 关键词")
    搜索.add_argument("--limit", type=int, default=30, help="最大结果数，默认 30")
    搜索.set_defaults(handler=命令搜索)

    说明 = 子命令.add_parser("describe", help="查看接口签名和 docstring")
    说明.add_argument("api_name", help="AKShare 接口名")
    说明.set_defaults(handler=命令说明)

    调用 = 子命令.add_parser("call", help="调用接口并可选导出")
    调用.add_argument("api_name", help="AKShare 接口名")
    调用.add_argument("--params-json", default="{}", help="JSON 对象形式的关键字参数")
    调用.add_argument("--output", help="输出 .csv/.parquet/.pq/.json 路径")
    调用.add_argument("--preview", type=int, default=10, help="预览行数，默认 10")
    调用.add_argument("--require-data", action="store_true", help="空结果时返回状态码 3")
    调用.set_defaults(handler=命令调用)
    return 解析器


def main() -> int:
    参数 = 构建解析器().parse_args()
    return 参数.handler(参数)


if __name__ == "__main__":
    raise SystemExit(main())
