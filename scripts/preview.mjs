/** Loopback-only, temporary static preview. Never exposes source or original data. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const port=4184;
const prefix='/olist-merchant-operations-dashboard';
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  let p=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  if(p===prefix){res.writeHead(302,{Location:prefix+'/'});res.end();return;}
  if(p.startsWith(prefix+'/'))p=p.slice(prefix.length);
  if(!['/','/index.html','/app/','/app/index.html','/case.html','/SOURCE_LICENSE.md','/CODE_LICENSE.md'].includes(p)){res.writeHead(404);res.end();return;}
  const target=path.join(root,p.endsWith('/')?p+'index.html':p);
  const b=await fs.readFile(target);
  res.writeHead(200,{'Content-Type':target.endsWith('.md')?'text/plain; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:b);
 }catch{res.writeHead(404);res.end();}
});
const stop=()=>server.close(()=>process.exit(0));
setTimeout(stop,30*60*1000);process.on('SIGTERM',stop);process.on('SIGINT',stop);
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}${prefix}/`,pid:process.pid,ttlMinutes:30})));
