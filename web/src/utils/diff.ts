// 行级 diff 渲染辅助：基于 diff 包的 diffLines，输出带上下文裁剪的内联行序列。
// 相同内容超过上下文窗口时折叠为 gap 行，避免长文档全量刷屏。
import { diffLines } from "diff";

export interface DiffRow {
  type: "same" | "add" | "del" | "gap";
  text: string;
  /** type === "gap" 时被折叠的行数 */
  count?: number;
}

/** diff 包的行片拆分：去掉末尾空串（由结尾 \n 产生） */
function splitPartLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 构造内联 diff 行序列：
 * 变化处保留上下各 context 行相同内容，其余相同内容折叠为「相同内容省略 N 行」。
 */
export function buildDiffRows(oldText: string, newText: string, context = 2): DiffRow[] {
  const parts = diffLines(oldText, newText);
  const rows: DiffRow[] = [];
  let sameBuf: string[] = [];
  let seenChange = false;

  const hasChangeAfter = (fromIndex: number): boolean =>
    parts.slice(fromIndex).some((p) => p.added || p.removed);

  const flushSame = (hasMoreChange: boolean): void => {
    const buf = sameBuf;
    sameBuf = [];
    if (buf.length === 0) return;
    if (!seenChange) {
      // 首个变化之前的相同内容：只留末尾 context 行作为上文
      const kept = buf.slice(-context);
      if (buf.length > kept.length) {
        rows.push({ type: "gap", text: "", count: buf.length - kept.length });
      }
      for (const text of kept) rows.push({ type: "same", text });
      return;
    }
    if (!hasMoreChange) {
      // 最后一个变化之后的相同内容：只留开头 context 行作为下文
      const kept = buf.slice(0, context);
      for (const text of kept) rows.push({ type: "same", text });
      if (buf.length > kept.length) {
        rows.push({ type: "gap", text: "", count: buf.length - kept.length });
      }
      return;
    }
    // 两个变化之间的相同内容：两端各留 context 行
    if (buf.length <= context * 2) {
      for (const text of buf) rows.push({ type: "same", text });
    } else {
      for (const text of buf.slice(0, context)) rows.push({ type: "same", text });
      rows.push({ type: "gap", text: "", count: buf.length - context * 2 });
      for (const text of buf.slice(-context)) rows.push({ type: "same", text });
    }
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lines = splitPartLines(part.value);
    if (part.added) {
      flushSame(hasChangeAfter(i + 1));
      seenChange = true;
      for (const text of lines) rows.push({ type: "add", text });
    } else if (part.removed) {
      flushSame(hasChangeAfter(i + 1));
      seenChange = true;
      for (const text of lines) rows.push({ type: "del", text });
    } else {
      sameBuf.push(...lines);
    }
  }
  flushSame(false);
  return rows;
}

/** 统计变更行数（列表/标题摘要用） */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}
