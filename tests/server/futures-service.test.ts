import { describe,it,expect } from 'vitest';
import { futuresMonth,futuresBars } from '../../server/datasource/futures-service.js';

describe('期货目录与日线解析',()=>{
 it('郑商所三位合约按目录日期解析，不猜系统当前年',()=>{
  expect(futuresMonth({thscode:'MA701.CZC',last_trade_date:'2027-01-15'})).toBe('202701');
  expect(()=>futuresMonth({thscode:'MA701.CZC'})).toThrow();
  expect(futuresMonth({thscode:'AU2612.SHF'})).toBe('202612');
 });
 it('交易日使用东八区时间戳，保留合法零成交与持仓',()=>{
  const bars=futuresBars({item:[{timestamp:Date.parse('2026-11-16T00:00:00+08:00'),open_price:10,high_price:12,low_price:9,close_price:11,volume:0,open_interest:0}]},'2026-11-16');
  expect(bars[0]).toMatchObject({date:'2026-11-16',volume:0,interest:0,adjustment:'none'});
 });
 it('拒绝缺价及错误高低价，不补零价格',()=>{
  expect(()=>futuresBars({item:[{timestamp:Date.parse('2026-11-16T00:00:00+08:00'),open_price:null,high_price:10,low_price:9,close_price:10}]},'2026-11-16')).toThrow();
  expect(()=>futuresBars({item:[{timestamp:Date.parse('2026-11-16T00:00:00+08:00'),open_price:10,high_price:9,low_price:8,close_price:11}]},'2026-11-16')).toThrow();
 });
});
