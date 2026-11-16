import { describe,it,expect,vi,beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({find:vi.fn(),bars:vi.fn(),indicator:vi.fn(),fetch:vi.fn(),remote:vi.fn()}));
vi.mock('../../server/modules/market/repo.js',async original=>({...await original<typeof import('../../server/modules/market/repo.js')>(),findInstrumentByCode:mocks.find,listBars:mocks.bars,latestIndicatorStatus:mocks.indicator}));
vi.mock('../../server/datasource/service.js',()=>({fetchAndStore:mocks.fetch}));
vi.mock('../../server/datasource/hithink-meta.js',()=>({resolveRemoteTicker:mocks.remote}));
import { marketRoutes } from '../../server/modules/market/routes.js';
import type pg from 'pg';
const ctx=(params:string)=>({pool:{} as pg.Pool,params:{},body:undefined,query:new URLSearchParams(params)});
beforeEach(()=>{vi.clearAllMocks();mocks.bars.mockResolvedValue([]);mocks.indicator.mockResolvedValue(null);});
describe('行情API stored_only只读保护',()=>{
 for(const kind of ['stock','index','board'])it(`${kind}空窗口不外采、不写入`,async()=>{
 mocks.find.mockResolvedValue({id:'1',code:'TEST',kind,persisted:true});
 const result=await marketRoutes.bars(ctx('code=TEST&start=2026-01-01&end=2026-01-02&stored_only=true'));
 expect(result.data).toMatchObject({data_source:'stored',bars:[]});
 expect(mocks.fetch).not.toHaveBeenCalled();expect(mocks.remote).not.toHaveBeenCalled();
 });
 it('未知标的直接返回缺失，不远程消歧',async()=>{
 mocks.find.mockResolvedValue(null);
 await expect(marketRoutes.bars(ctx('code=UNKNOWN&start=2026-01-01&end=2026-01-02&stored_only=1'))).rejects.toMatchObject({httpStatus:404});
 expect(mocks.remote).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('只读模式拒绝无区间与非法参数',async()=>{
 await expect(marketRoutes.bars(ctx('code=TEST&stored_only=true'))).rejects.toMatchObject({httpStatus:400});
 await expect(marketRoutes.bars(ctx('code=TEST&stored_only=invalid'))).rejects.toMatchObject({httpStatus:400});
 });
});
