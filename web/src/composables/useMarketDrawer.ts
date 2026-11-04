// 全局行情抽屉：任何页面打开后都保留当前页面状态，不再跳转 /market。
import { reactive } from "vue";

export interface MarketDrawerTarget {
  code: string;
  name?: string;
}

interface MarketDrawerState {
  open: boolean;
  target: MarketDrawerTarget | null;
  /** 每次显式打开递增，确保重复点同一只也会刷新。 */
  seq: number;
}

const state = reactive<MarketDrawerState>({ open: false, target: { code: "000001.SH", name: "上证指数" }, seq: 0 });

export function openMarket(code?: string, name?: string): void {
  if (code) state.target = { code, name };
  state.open = true;
  state.seq += 1;
}

export function closeMarket(): void {
  state.open = false;
}

export function useMarketDrawer(): MarketDrawerState {
  return state;
}
