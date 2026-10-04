// Provision/checkpoint Dana's persistent headed browser. Run via setup-dana-sprite.sh.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { APIError, ExecError, SpritesClient } from '@fly/sprites';
import { loadRootEnv } from '@fabric/db';
loadRootEnv();
const token=process.env.SPRITES_TOKEN;
if(!token) throw new Error('SPRITES_TOKEN is required');
const client=new SpritesClient(token);
const name=process.env.SPRITE_ASSISTANT||'fabric-assistant';
if(name===(process.env.SPRITE_CODER||'fabric-coder')||name===(process.env.SPRITE_VALIDATOR||'fabric-validator')) throw new Error('SPRITE_ASSISTANT must not share Jonah or Sana sandbox identity');
let sprite;
try {sprite=await client.getSprite(name);} catch(error) {if(!(error instanceof APIError)||error.statusCode!==404)throw error;sprite=await client.createSprite(name,{cpus:8,ramMB:8192});}
await sprite.updateURLSettings({auth:'sprite',privateAccess:'admins'});
await sprite.updateNetworkPolicy({rules:[{domain:'*',action:'allow'}]});
const started=Date.now();
const install=await sprite.execFile('bash',['-lc',`set -euo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify nftables ca-certificates openssl curl libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxcursor1 libasound2t64 libpango-1.0-0 libcairo2 libcups2t64 libgtk-3-0t64 fonts-liberation
sudo mkdir -p /opt/fabric-dana
id dana-browser >/dev/null 2>&1 || sudo useradd --create-home --shell /usr/sbin/nologin dana-browser
sudo chown -R sprite:sprite /opt/fabric-dana
cd /opt/fabric-dana
if ! test -f package.json; then printf '%s' '{"private":true,"type":"module"}' > package.json; fi
npm install --no-audit --no-fund playwright@1.58.2
# Sprite currently ships Ubuntu 26.04; Playwright's automatic apt dependency installer
# does not support it. Native dependencies above run the supported 24.04 browser build.
env PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/opt/fabric-dana/browsers node node_modules/playwright/cli.js install chromium
sudo mkdir -p /home/dana-browser/profile /home/dana-browser/responses
sudo chown -R dana-browser:dana-browser /home/dana-browser
sudo chmod 700 /home/dana-browser
`],{timeout:600000,maxBuffer:4*1024*1024});
if(install.exitCode!==0)throw new Error(`Dana install failed: ${String(install.stderr).slice(-3000)}`);
console.log(JSON.stringify({phase:'installed',sprite:name,elapsedMs:Date.now()-started}));
const fs=sprite.filesystem('/opt/fabric-dana');
for(const filename of ['dana-browser-worker.mjs','dana-browser-proxy.mjs','dana-browser-start.sh']) await fs.writeFile(filename,await readFile(fileURLToPath(new URL(filename,import.meta.url)),'utf8'));
await fs.chmod('dana-browser-start.sh',0o755);
await sprite.execFile('sudo',['chown','root:root','/opt/fabric-dana/dana-browser-start.sh','/opt/fabric-dana/dana-browser-worker.mjs','/opt/fabric-dana/dana-browser-proxy.mjs']);
const service={cmd:'/usr/bin/sudo',args:['-n','/bin/bash','/opt/fabric-dana/dana-browser-start.sh'],httpPort:8080};
const services=await sprite.listServices();
const stream=services.some(item=>item.name==='dana-browser')
  ? await sprite.restartService('dana-browser','1s')
  : await sprite.createService('dana-browser',service,'1s');
for await(const item of stream){if(item.type==='error')throw new Error(item.data);}
async function healthy() {for(let i=0;i<30;i++){try{const r=await sprite!.execFileHTTP('curl',['-fsS','--max-time','2','http://127.0.0.1:9223/health'],{timeout:5000});return String(r.stdout);}catch(error){if(!(error instanceof ExecError))throw error;}await delay(500);}throw new Error('Dana browser did not become healthy');}
console.log(JSON.stringify({phase:'ready',health:JSON.parse(await healthy()),elapsedMs:Date.now()-started}));
const checkpoint=await sprite.createCheckpoint('Dana headed Playwright + persistent profile + private view-only noVNC + public-only browser egress');
for await(const message of checkpoint){console.log(JSON.stringify({phase:'checkpoint',...message}));if(message.type==='error')throw new Error(message.error||message.data);}
const checkpoints=await sprite.listCheckpoints();
// The SDK lists a synthetic \"Current\" entry which the restore API rejects.
const latest=checkpoints.filter(item=>/^v\d+$/.test(item.id)).sort((a,b)=>new Date(b.createTime).getTime()-new Date(a.createTime).getTime())[0];
if(!latest)throw new Error('Checkpoint creation completed but no checkpoint was returned');
console.log(JSON.stringify({phase:'checkpoint-created',id:latest.id,elapsedMs:Date.now()-started}));
const boot=Date.now();
const restore=await sprite.restoreCheckpoint(latest.id);
for await(const message of restore){console.log(JSON.stringify({phase:'restore',...message}));if(message.type==='error')throw new Error(message.error||message.data);}
console.log(JSON.stringify({phase:'checkpoint-boot',id:latest.id,health:JSON.parse(await healthy()),elapsedMs:Date.now()-boot}));
