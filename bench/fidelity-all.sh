#!/usr/bin/env bash
# Run every fidelity scenario, one per freshly started Aperture.
#
# The static server is a five-line node one-liner rather than http-server so
# that `Cache-Control: no-store` is guaranteed. Electron caches fixture
# responses, and a run against a STALE fixture measures a page nobody is
# looking at while printing a verdict about the one on disk — that happened,
# and cost a day. fidelity.mjs's `?benchrun=` cache-buster is the other half.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

node -e '
const {createServer}=require("http"),{readFile}=require("fs/promises"),{join,extname}=require("path");
const dir=join(process.cwd(),"test","fixtures");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8"};
createServer(async(req,res)=>{
  const p=(req.url||"/").split("?")[0];
  try{
    const b=await readFile(join(dir,p==="/"?"index.html":p.replace(/^\/+/,"")));
    res.writeHead(200,{"content-type":mime[extname(p)]||"application/octet-stream","cache-control":"no-store"});
    res.end(b);
  }catch{res.writeHead(404);res.end();}
}).listen(8899,"127.0.0.1",()=>console.log("fixtures on 8899"));
' &
SERVER=$!
sleep 1

FAILED=0
for scenario in form rerender widgets biglist selects blindfields filterlist; do
  taskkill //F //IM electron.exe >/dev/null 2>&1
  sleep 3
  npx electron . > /tmp/ap-$scenario.log 2>&1 &
  sleep 14
  TOK=$(node -e '
    const {readFileSync}=require("fs"),{join}=require("path");
    const c=JSON.parse(readFileSync(join(process.env.APPDATA,"aperture","mcp.json"),"utf8"));
    process.stdout.write(c.mcpServers.aperture.headers.Authorization.replace("Bearer ",""));
  ')
  echo ""
  echo "############ $scenario ############"
  node bench/fidelity.mjs "$TOK" "$scenario"
  RC=$?
  echo "$scenario EXIT=$RC"
  [ "$RC" -ne 0 ] && FAILED=1
done

taskkill //F //IM electron.exe >/dev/null 2>&1
kill $SERVER 2>/dev/null
echo ""
echo "ALL FIDELITY SCENARIOS: $([ $FAILED -eq 0 ] && echo GREEN || echo 'RED — see above')"
exit $FAILED
