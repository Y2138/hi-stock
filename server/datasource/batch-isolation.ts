/** 仅对逐标的错误二分隔离；限流/整批来源故障仍显式失败，不盲目放大请求。 */
export async function fetchBatchIsolated<T>(
  codes: string[],
  fetcher: (batch: string[]) => Promise<T[]>,
): Promise<{ rows: T[]; skipped: string[] }> {
  if (!codes.length) return { rows: [], skipped: [] };
  try { return { rows: await fetcher(codes), skipped: [] }; }
  catch (error) {
    if (/429|4001|request limit exceeded|throttl/i.test((error as Error).message)) throw error;
    if (codes.length === 1) return { rows: [], skipped: codes };
    const half = Math.floor(codes.length / 2);
    const left = await fetchBatchIsolated(codes.slice(0, half), fetcher);
    const right = await fetchBatchIsolated(codes.slice(half), fetcher);
    return { rows: [...left.rows, ...right.rows], skipped: [...left.skipped, ...right.skipped] };
  }
}
