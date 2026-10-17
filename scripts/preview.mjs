import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist'),port=Number(process.env.PORT||8877);
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png'};
await fs.access(path.join(root,'index.html'));
http.createServer(async(req,res)=>{
  try{let url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(url==='/')url='/index.html';const file=path.resolve(root,'.'+url);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'text/plain');res.setHeader('Cache-Control','no-store');res.end(await fs.readFile(file));}
  catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Purchase preview: http://127.0.0.1:${port} (local plans; Cloudflare API is not emulated)`));
