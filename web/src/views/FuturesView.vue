<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
const contracts=ref<any[]>([]),coverage=ref<any[]>([]),detail=ref<any>(null),product=ref('AU'),code=ref(''),error=ref('');
const products=computed(()=>[...new Set(contracts.value.map(x=>x.commodity_code))]);
const filtered=computed(()=>contracts.value.filter(x=>x.commodity_code===product.value));
async function load(){try{const r=await fetch('/api/futures');if(!r.ok)throw Error('期货目录读取失败');const j=await r.json();contracts.value=j.contracts;coverage.value=j.coverage;}catch(e){error.value=String(e);}}
async function select(){try{const r=await fetch('/api/futures/'+encodeURIComponent(code.value));if(!r.ok)throw Error('合约读取失败');detail.value=await r.json();}catch(e){error.value=String(e);}}
onMounted(load);
</script>
<template>
 <section style="padding:24px;overflow:auto">
 <h1>期货行情与数据覆盖</h1><p>仅供研究，不提供期货交易。供应商主连单独存储，不覆盖旧 xx0；仓单不等于总库存。</p>
 <p v-if="error">{{ error }}</p>
 <label>品种 <select v-model="product"><option v-for="p in products" :key="p">{{p}}</option></select></label>
 <label>合约 / 主连 <select v-model="code" @change="select"><option value="">请选择</option><option v-for="c in filtered" :key="c.instrument_id" :value="c.code">{{c.name}} {{c.code}} · {{c.contract_kind}} · {{c.latest_date}}</option></select></label>
 <h2>最新同步覆盖与缺口</h2>
 <table><thead><tr><th>品种</th><th>数据</th><th>目标日</th><th>最新日</th><th>状态</th><th>覆盖</th><th>缺口</th></tr></thead><tbody><tr v-for="r in coverage.filter(x=>x.product_code===product)" :key="r.dataset"><td>{{r.product_code}}</td><td>{{r.dataset}}</td><td>{{String(r.target_date).slice(0,10)}}</td><td>{{String(r.latest_date??'未知').slice(0,10)}}</td><td>{{r.status}}</td><td>{{r.written_count}} / {{r.expected_count??'未知'}}</td><td>{{r.gaps}}</td></tr></tbody></table>
 <template v-if="detail"><h2>{{detail.instrument.name}} · 日线 / 结算 / 持仓</h2><table><thead><tr><th>交易日</th><th>开</th><th>高</th><th>低</th><th>收</th><th>成交量</th><th>结算</th><th>持仓</th><th>来源</th></tr></thead><tbody><tr v-for="b in detail.bars" :key="b.bar_date"><td>{{b.bar_date}}</td><td>{{b.open}}</td><td>{{b.high}}</td><td>{{b.low}}</td><td>{{b.close}}</td><td>{{b.volume}}</td><td>{{b.settlement??'缺失'}}</td><td>{{b.open_interest??'缺失'}}</td><td>{{b.channel}}</td></tr></tbody></table><h2>换月映射</h2><pre>{{detail.mapping}}</pre><h2>仓单（原始单位未披露时不换算）</h2><pre>{{detail.receipts}}</pre></template>
 </section>
</template>
<style scoped>table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd}select{padding:8px;margin:12px}pre{white-space:pre-wrap}</style>
