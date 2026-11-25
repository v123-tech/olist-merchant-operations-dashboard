import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {calculateReplay,filterMerchants} from '../src/app.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=JSON.parse(await fs.readFile(path.join(root,'src/dashboardData.json')));

test('每个滑块组合精确使用真实聚合格点，估算与历史事实分离',()=>{
 for(const c of data.replay.cells){const r=calculateReplay(data,c.days,c.aov);assert.equal(r.alerts,c.alerts);assert.equal(r.knownBadReviews,c.knownBadReviews);assert.equal(r.observableOutcomes,c.observableOutcomes);assert.equal(r.lateOutcomes,c.lateOutcomes);assert.equal(r.estimatedRecoverable,c.knownBadReviews*data.replay.recoveryRate);assert.equal(r.laborHours,c.alerts*data.replay.minutesPerAlert/60);assert(r.estimatedRecoverable<=r.knownBadReviews);}
});
test('提高客单价门槛不会增加排查量，扩大提前窗口不会减少覆盖',()=>{
 for(const day of data.replay.days){let prior=Infinity;for(const aov of data.replay.aov){const r=calculateReplay(data,day,aov);assert(r.alerts<=prior);prior=r.alerts;}}
 for(const aov of data.replay.aov){let prior=-1;for(const day of data.replay.days){const r=calculateReplay(data,day,aov);assert(r.alerts>=prior);prior=r.alerts;}}
});
test('越界、非数值输入安全归入合法格点，不产生NaN',()=>{
 for(const x of [-999,999,NaN,Infinity,'无效',null,undefined]){const r=calculateReplay(data,x,x);assert(data.replay.days.includes(r.days));assert(data.replay.aov.includes(r.aov));assert(Number.isFinite(r.alerts));assert(Number.isFinite(r.laborHours));}
});
test('中文风险和品类筛选仅返回满足两个条件的商家',()=>{
 assert.equal(filterMerchants(data).length,30);
 for(const tier of new Set(data.merchants.map(m=>m.tier)))for(const category of new Set(data.merchants.map(m=>m.category))){const found=filterMerchants(data,tier,category);assert.deepEqual(found.map(m=>m.id),data.merchants.filter(m=>m.tier===tier&&m.category===category).map(m=>m.id));}
 assert.deepEqual(filterMerchants(data,'不存在的层级'),[]);assert.deepEqual(filterMerchants(data,'','不存在的品类'),[]);
});
test('交互不修改已内嵌的数据，零结果仍可计算',()=>{
 const before=JSON.stringify(data);calculateReplay(data,0,500);filterMerchants(data,'高危');assert.equal(JSON.stringify(data),before);
 const zero=structuredClone(data);zero.replay.cells=zero.replay.cells.map(c=>({...c,alerts:0,knownBadReviews:0,observableOutcomes:0,lateOutcomes:0}));const r=calculateReplay(zero,3,100);assert.equal(r.estimatedRecoverable,0);assert.equal(r.laborHours,0);
});
test('发布物内嵌真实聚合数据，未留下数据请求和原始哈希商家',async()=>{
 const html=await fs.readFile(path.join(root,'dist/index.html'),'utf8');assert(html.includes('const dashboardData='));assert(!/\bfetch\s*\(|XMLHttpRequest|new Worker|cdn\.jsdelivr/.test(html));assert(!/<script[^>]+src=/.test(html));assert(!/商衡/.test(html));assert(Buffer.byteLength(html)<150000);
});
test('实际HTML中的模块可以解析，特殊替换字符不损坏打包脚本',async()=>{
 const html=await fs.readFile(path.join(root,'dist/index.html'),'utf8');const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];assert(script);const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal((html.match(/<script type="module">/g)||[]).length,1);
});
