const http=require('http'),fs=require('fs'),path=require('path');
const T={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer((q,s)=>{
  let f=decodeURIComponent(q.url.split('?')[0]); if(f==='/')f='/index.html';
  const p=path.join(__dirname,f);
  fs.readFile(p,(e,d)=>{ if(e){s.writeHead(404);s.end('404');return;}
    s.writeHead(200,{'Content-Type':T[path.extname(p)]||'application/octet-stream','Cache-Control':'no-store'});s.end(d);});
}).listen(8765,()=>console.log('http://127.0.0.1:8765'));
