import WebSocket from '../panel/daemon/node_modules/ws/index.js';
import { execSync } from 'node:child_process';

// Discover ALL CDP ports dynamically (multiple CEF extensions may be running)
const psOut = execSync("ps aux | grep -o 'remote-debugging-port=[0-9]*'", {encoding:'utf8'});
const ports = [...new Set(psOut.match(/\d+/g) || [])]; // unique ports

if (ports.length === 0) {
  console.error('no CEF remote-debugging-port found — is the AE panel open?');
  process.exit(2);
}

console.log(`[INFO] Found CEF debug ports: ${ports.join(', ')}`);

// Find the Gaffer panel by checking each port
let gafferPage = null;
let gafferPort = null;

for (const port of ports) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find(t => t.type === 'page' && /gaffer/i.test((t.url||'')+(t.title||'')));
    if (page) {
      gafferPage = page;
      gafferPort = port;
      console.log(`[INFO] Found Gaffer panel on port ${port}: "${page.title}"`);
      break;
    }
  } catch (e) {
    // Port not responding, continue to next
  }
}

if (!gafferPage) {
  console.error('Gaffer panel not found on any CEF debug port');
  process.exit(1);
}

const ws = new WebSocket(gafferPage.webSocketDebuggerUrl);
await new Promise(r=>ws.on('open',r));

let id=0;
const rpc=(m,p)=>new Promise(res=>{
  const i=++id;
  const h=d=>{
    const x=JSON.parse(d);
    if(x.id===i){
      ws.off('message',h);
      res(x.result);
    }
  };
  ws.on('message',h);
  ws.send(JSON.stringify({id:i,method:m,params:p||{}}));
});

await rpc('Page.enable');
await rpc('Runtime.enable');
await rpc('Page.reload');
await new Promise(r=>setTimeout(r,3200));

const ev=e=>rpc('Runtime.evaluate',{returnByValue:true,expression:e}).then(r=>r.result.value);

// Test signed out → card visible, input disabled, chip hidden
await ev("window.__gafferAuth({loggedIn:false})");
const out = JSON.parse(await ev("JSON.stringify({card:document.getElementById('signInCard').classList.contains('visible'),input:document.getElementById('chatInput').disabled,chip:document.getElementById('accountChip').hidden})"));

// Test signed in → card hidden, chip shown with label, input enabled (if ws connected)
await ev("window.__gafferAuth({loggedIn:true,email:'a@b.co',orgName:'Acme',plan:'team'})");
const in_ = JSON.parse(await ev("JSON.stringify({card:document.getElementById('signInCard').classList.contains('visible'),chipHidden:document.getElementById('accountChip').hidden,label:document.getElementById('accountLabel').textContent})"));

console.log('SIGNED OUT', JSON.stringify(out));
console.log('SIGNED IN', JSON.stringify(in_));

// Restore panel state
console.log('[INFO] Sending restore reload...');
await rpc('Page.reload');
console.log('[INFO] Restore reload sent');

const pass = out.card===true && out.input===true && out.chip===true && in_.card===false && in_.chipHidden===false && in_.label.includes('a@b.co');
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass?0:1);
