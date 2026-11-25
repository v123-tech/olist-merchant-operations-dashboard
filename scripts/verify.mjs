/** Verify actual shipping bytes and the data contract. No network or raw input reads. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFile(path.join(root,p));
const raw=await read('src/dashboardData.json'),data=JSON.parse(raw);
let checks=0;const ok=(condition,message)=>{assert(condition,message);checks++;};
ok(raw.length<80000,'JSON未压缩UTF-8体积超限');
ok(data.brand==='瞄店'&&data.version===2,'品牌和版本');
ok(data.kpis.orders===99441&&data.scope.sourceItems===112650,'原始行数');
const k=data.kpis;
ok(k.onTime+k.late===k.eligible&&k.eligible<=k.orders,'准时率分母恒等式');
ok(k.otd===null||Math.abs(k.otd-k.onTime/k.eligible)<0.000001,'准时率');
ok(k.lateLowReviews<=k.lateReviewed&&k.lateReviewed<=k.late,'延迟差评分母');
ok(k.highRiskGmvCents<=k.totalGmvCents&&Number.isSafeInteger(k.totalGmvCents),'高危成交额');
ok(data.delayBands.reduce((n,b)=>n+b.orders,0)===k.eligible,'延迟分箱与总体相符');
ok(data.delayBands.every(b=>b.lowReviews<=b.reviewed&&b.reviewed<=b.orders),'差评箱分子分母');
ok(data.categories.length>0&&data.categories.every(c=>/[\u3400-\u9fff]/.test(c.name)&&!/[a-z]/i.test(c.name)),'全部品类中文');
ok(data.merchants.length===30&&new Set(data.merchants.map(m=>m.id)).size===30,'30家唯一匿名商家');
for(const m of data.merchants){
 ok(!/[a-z]/i.test(m.id+m.label+m.tier+m.category+m.pain+m.actions.join('')),'商家呈现字段完全中文');
 ok(!/\b[a-f0-9]{32}\b/i.test(JSON.stringify(m)),'商家对象不得含原始哈希标识');
 ok(m.actions.length===3&&m.actions.every(a=>a.length>=10),'每家三项具体建议');
 ok(m.late<=m.eligible&&m.eligible<=m.orders&&Number.isSafeInteger(m.gmvCents),'商家指标分母');
}
ok(data.replay.days.length===8&&data.replay.aov.length===11,'滑块格点完整');
ok(data.replay.cells.length===88&&new Set(data.replay.cells.map(c=>c.days+':'+c.aov)).size===88,'88个回放格点唯一');
ok(data.replay.cells.every(c=>c.knownBadReviews<=c.observableOutcomes&&c.observableOutcomes<=c.alerts&&c.lateOutcomes<=c.alerts),'回放历史分子分母');
ok(data.replay.recoveryRate===0.2&&data.replay.minutesPerAlert===5,'情景假设明确');
const html=(await read('dist/index.html')).toString('utf8');
ok(Buffer.byteLength(html)<150000,'整个离线HTML体积');
ok(/<html[^>]+lang="zh-CN"/.test(html)&&/<title>[^<]*瞄店[^<]*<\/title>/.test(html),'中文文档与标题');
ok(!/商衡|ShopPeek|加载订单明细|正在读取历史数据|orders\.json\.gz|items\.json\.gz|cdn\.jsdelivr/i.test(html),'无旧品牌、分页或下载器');
ok(!/\b(?:fetch|XMLHttpRequest|Worker|WebSocket|EventSource)\s*\(|\bimport\s*\(/.test(html),'运行时没有网络数据加载器');
ok(!/<script[^>]+src=|<link[^>]+(?:stylesheet|preload)|<img[^>]+src=["']https?:/i.test(html),'无需外部脚本样式图像');
ok(/connect-src\s+'none'/.test(html),'CSP禁止数据联网');
ok(/form-action\s+'none'/.test(html),'CSP禁止提交外部表单');
const expected=['.nojekyll','CODE_LICENSE.md','SOURCE_LICENSE.md','app/index.html','case.html','index.html'];
const paths=[];async function walk(dir,rel=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){assert(!e.isSymbolicLink());const p=rel?rel+'/'+e.name:e.name;if(e.isDirectory())await walk(path.join(dir,e.name),p);else paths.push(p);}}
await walk(path.join(root,'dist'));ok(JSON.stringify(paths.sort())===JSON.stringify(expected),'发布目录只有自包含页面与兼容入口');
for(const p of ['dist/app/index.html','dist/case.html']){const s=(await read(p)).toString('utf8');ok(!/https?:|src=|商衡/.test(s)&&/进入瞄店/.test(s),'兼容入口仅相对本地跳转');}
console.log(JSON.stringify({passed:true,checks,brand:data.brand,dataBytes:raw.length,htmlBytes:Buffer.byteLength(html),dataSha256:createHash('sha256').update(raw).digest('hex'),runtimeDataRequests:0,staticFiles:paths},null,2));
