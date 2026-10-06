import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const PILOT_ORGANIZATION_ID = '00605bb8-3899-406e-a428-d7779e856bb2';
const OIDC_AUDIENCE = 'emcore-live-pilot-smoke';
const G03_SYNTHETIC_SUPPLY_ID = '17d6e198-ff7a-4af7-a36e-595120392f02';
const G03_SIMULATION_HASH = '#simulation?supply=' + G03_SYNTHETIC_SUPPLY_ID;
const G03_INPUT_ENDPOINT_PATH = '/api/g03/organizations/' + PILOT_ORGANIZATION_ID + '/supplies/' + G03_SYNTHETIC_SUPPLY_ID + '/invoice-simulation-inputs';
const G03_SIMULATION_ENDPOINT_PATH = '/api/g03/organizations/' + PILOT_ORGANIZATION_ID + '/supplies/' + G03_SYNTHETIC_SUPPLY_ID + '/invoice-simulations';
const G03_SIMULATION_PERIOD_START = '2026-08-01';
const G03_SIMULATION_PERIOD_END = '2026-08-31';
const routes = ['overview','documents','supplies','simulation','analysis','actions','markets','practices','deadlines','fiscality'];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}
function decodeBase32(value) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized=String(value).toUpperCase().replace(/=+$/g,'').replace(/\s+/g,'');
  let bits='';
  for (const char of normalized) {
    const idx=alphabet.indexOf(char);
    if (idx < 0) throw new Error('Invalid base32 secret');
    bits += idx.toString(2).padStart(5,'0');
  }
  const bytes=[];
  for(let i=0;i+8<=bits.length;i+=8) bytes.push(Number.parseInt(bits.slice(i,i+8),2));
  return Buffer.from(bytes);
}
function deriveTotp(secret) {
  const counter=BigInt(Math.floor(Date.now()/1000/30));
  const message=Buffer.alloc(8); message.writeBigUInt64BE(counter);
  const digest=createHmac('sha1',decodeBase32(secret)).update(message).digest();
  const offset=digest[digest.length-1]&0x0f;
  const binary=((digest[offset]&0x7f)<<24)|((digest[offset+1]&0xff)<<16)|((digest[offset+2]&0xff)<<8)|(digest[offset+3]&0xff);
  return String(binary % 1_000_000).padStart(6,'0');
}
async function githubOidcToken() {
  const url=required('ACTIONS_ID_TOKEN_REQUEST_URL');
  const token=required('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  const response=await fetch(url+(url.includes('?')?'&':'?')+'audience='+encodeURIComponent(OIDC_AUDIENCE),{headers:{authorization:'Bearer '+token}});
  if(!response.ok) throw new Error('GitHub OIDC request failed: '+response.status);
  const body=await response.json();
  if(typeof body?.value!=='string') throw new Error('GitHub OIDC token missing');
  return body.value;
}
async function bootstrap(url, oidc, action, userId) {
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+oidc,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({action,userId})});
  if(!response.ok) throw new Error('Bootstrap '+action+' failed: '+response.status);
  return response.json();
}
async function runtimeConfig(baseUrl) {
  const response=await fetch(baseUrl+'/api/runtime-config',{headers:{accept:'application/json'}});
  if(!response.ok) throw new Error('runtime-config failed: '+response.status);
  const body=await response.json();
  if(body.authMode!=='magic_link_mfa' || body.applicationSurfaceMode!=='PILOT' || body.documentIngestionEnabled!==false || body.allowedOrganizationId!==PILOT_ORGANIZATION_ID) {
    throw new Error('PILOT runtime safety contract mismatch');
  }
  return body;
}
async function deploymentIdentity(baseUrl, expectedCommit) {
  const response=await fetch(baseUrl+'/api/deployment-identity',{headers:{accept:'application/json'}});
  if(!response.ok) throw new Error('deployment-identity failed: '+response.status);
  const body=await response.json();
  if(body.commitSha!==expectedCommit) throw new Error('deployed commit mismatch');
}
async function waitFor(fn, timeout=15000) {
  const started=Date.now();
  while(Date.now()-started<timeout) {
    try { if(await fn()) return; } catch {}
    await new Promise(r=>setTimeout(r,180));
  }
  throw new Error('Timed out waiting for browser state');
}
async function openPage(baseUrl) {
  const chrome=spawn('/usr/bin/google-chrome',[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223',
    '--user-data-dir=/tmp/emcore-owner-acceptance-chrome','about:blank'
  ],{stdio:'ignore'});
  await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:9223/json/version')).ok}catch{return false}});
  const response=await fetch('http://127.0.0.1:9223/json/new?'+encodeURIComponent(baseUrl),{method:'PUT'});
  if(!response.ok) throw new Error('Unable to create Chrome target');
  const target=await response.json();
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
  let seq=0; const pending=new Map();
  const network={requests:new Map(),responses:new Map(),finished:new Set(),failed:new Map()};
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(String(event.data));
    if(msg.method==='Network.requestWillBeSent') {
      const request=msg.params?.request;
      if(request && typeof msg.params?.requestId==='string') {
        const headers=request.headers && typeof request.headers==='object' ? request.headers : {};
        const authenticated=Object.entries(headers).some(([key,value])=>key.toLowerCase()==='authorization' && String(value).startsWith('Bearer '));
        network.requests.set(msg.params.requestId,{method:String(request.method||''),url:String(request.url||''),authenticated});
      }
    } else if(msg.method==='Network.responseReceived' && typeof msg.params?.requestId==='string') {
      const response=msg.params?.response;
      if(response) network.responses.set(msg.params.requestId,{status:Number(response.status),url:String(response.url||'')});
    } else if(msg.method==='Network.loadingFinished' && typeof msg.params?.requestId==='string') {
      network.finished.add(msg.params.requestId);
    } else if(msg.method==='Network.loadingFailed' && typeof msg.params?.requestId==='string') {
      network.failed.set(msg.params.requestId,String(msg.params?.errorText||'network failure'));
    }
    if(!msg.id) return;
    const p=pending.get(msg.id); if(!p) return;
    pending.delete(msg.id);
    if(msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const evalJs=async(expression)=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) {
      const detail=result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown browser exception';
      throw new Error('Browser expression failed: '+detail);
    }
    return result.result?.value;
  };
  const close=()=>{try{ws.close()}catch{} try{chrome.kill('SIGTERM')}catch{}};
  return {send,evalJs,close,network};
}
function networkPathname(value) {
  try { return new URL(value).pathname; } catch { return ''; }
}
async function waitForG03EndpointProof(browser,method,pathname,timeout=20000) {
  const started=Date.now();
  while(Date.now()-started<timeout) {
    const match=[...browser.network.requests.entries()].find(([,request])=>request.method===method && networkPathname(request.url)===pathname);
    if(match) {
      const [requestId,request]=match;
      const failed=browser.network.failed.get(requestId);
      if(failed) throw new Error('G03 '+method+' '+pathname+' network failure: '+failed);
      const response=browser.network.responses.get(requestId);
      if(response && browser.network.finished.has(requestId)) {
        if(!request.authenticated) throw new Error('G03 '+method+' '+pathname+' did not carry authenticated browser authority');
        if(!Number.isInteger(response.status) || response.status<200 || response.status>=300) throw new Error('G03 '+method+' '+pathname+' failed: HTTP '+response.status);
        const responseBody=await browser.send('Network.getResponseBody',{requestId});
        const raw=responseBody.base64Encoded ? Buffer.from(responseBody.body,'base64').toString('utf8') : responseBody.body;
        let payload;
        try { payload=JSON.parse(raw); } catch { throw new Error('G03 '+method+' '+pathname+' returned non-JSON evidence'); }
        if(payload?.organizationId!==PILOT_ORGANIZATION_ID || payload?.supplyId!==G03_SYNTHETIC_SUPPLY_ID) throw new Error('G03 '+method+' '+pathname+' response identity mismatch');
        return {method,pathname,status:response.status,pass:true,responseIdentityVerified:true,authenticated:true};
      }
    }
    await new Promise(r=>setTimeout(r,120));
  }
  throw new Error('Timed out waiting for authenticated G03 '+method+' '+pathname);
}
async function setBrowserInput(browser,selector,value) {
  await browser.evalJs(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)});
    if(!(input instanceof HTMLInputElement)) throw new Error('Missing G03 input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
}
async function clickBrowserButtonByText(browser,selector,text) {
  await browser.evalJs(`(() => {
    const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find((item)=>item.textContent?.replace(/\\s+/g,' ').trim()===${JSON.stringify(text)});
    if(!(button instanceof HTMLButtonElement)) throw new Error('Missing G03 action');
    if(button.disabled) throw new Error('Disabled G03 action');
    button.click();
    return true;
  })()`);
}
async function performG03LiveEndpointAcceptance(browser) {
  await openRoute(browser,'simulation');
  const exactContext=await browser.evalJs(`location.hash===${JSON.stringify(G03_SIMULATION_HASH)} && document.querySelector('.g03-context-grid select')?.value===${JSON.stringify(G03_SYNTHETIC_SUPPLY_ID)}`);
  if(!exactContext) throw new Error('G03 synthetic organization/supply navigation context mismatch');
  await setBrowserInput(browser,'.g03-context-grid label:nth-child(2) input',G03_SIMULATION_PERIOD_START);
  await setBrowserInput(browser,'.g03-context-grid label:nth-child(3) input',G03_SIMULATION_PERIOD_END);
  await clickBrowserButtonByText(browser,'.g03-context-grid button','Carica dati canonici');
  const canonicalInputGet=await waitForG03EndpointProof(browser,'GET',G03_INPUT_ENDPOINT_PATH);
  await waitFor(async()=>await browser.evalJs("Boolean(document.querySelector('.g03-canonical')) && document.body.innerText.includes('Dati canonici')"),20000);
  await clickBrowserButtonByText(browser,'.g03-scenario-actions button','Calcola scenario A');
  const simulationPost=await waitForG03EndpointProof(browser,'POST',G03_SIMULATION_ENDPOINT_PATH);
  await waitFor(async()=>await browser.evalJs("Boolean(document.querySelector('.g03-results')) && document.body.innerText.includes('Risultati scenario')"),20000);
  return {
    organizationId:PILOT_ORGANIZATION_ID,
    supplyId:G03_SYNTHETIC_SUPPLY_ID,
    authenticatedSyntheticAal2Context:true,
    customerDataUsed:false,
    documentIngestionEnabled:false,
    simulationPersistenceUsed:false,
    canonicalInputGet,
    simulationPost,
  };
}
async function setViewport(browser,width,height,mobile) {
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});
}
async function screenshot(browser,file) {
  const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  await writeFile(file,Buffer.from(shot.data,'base64'));
}
async function waitForPortal(browser) {
  await waitFor(async()=>await browser.evalJs("Boolean(document.querySelector('.emcore-v02') && document.querySelector('[data-pilot-synthetic-owner-test]'))"),20000);
  const bad=await browser.evalJs("document.body.innerText.includes('READ MODEL NON COLLEGATO') || document.body.innerText.includes('Situazione regolare')");
  if(bad) throw new Error('Owner-rejected copy visible in deployed candidate');
}
async function openRoute(browser,route) {
  const hash=route==='overview' ? '' : route==='simulation' ? G03_SIMULATION_HASH : '#'+route;
  await browser.evalJs("location.hash="+JSON.stringify(hash)+"; window.dispatchEvent(new HashChangeEvent('hashchange'))");
  if(route==='simulation') {
    await waitFor(async()=>await browser.evalJs("location.hash==="+JSON.stringify(G03_SIMULATION_HASH)+" && Boolean(document.querySelector('[data-g03-workspace]')) && document.body.innerText.includes('Simulazione costi')"),20000);
  }
  await new Promise(r=>setTimeout(r,280));
  const overflow=await browser.evalJs("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1");
  if(overflow) {
    const diagnostic=await browser.evalJs(`(() => {
      const vw=document.documentElement.clientWidth;
      return [...document.querySelectorAll('body *')].map((el)=>{
        const r=el.getBoundingClientRect();
        return {
          tag:el.tagName,
          cls:typeof el.className==='string'?el.className:'',
          text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
          left:Math.round(r.left),
          right:Math.round(r.right),
          width:Math.round(r.width),
          scrollWidth:el.scrollWidth,
          clientWidth:el.clientWidth,
        };
      }).filter((x)=>x.right>vw+1 || x.left<-1 || x.scrollWidth>x.clientWidth+1)
        .sort((a,b)=>Math.max(b.right-vw,b.scrollWidth-b.clientWidth)-Math.max(a.right-vw,a.scrollWidth-a.clientWidth))
        .slice(0,24);
    })()`);
    console.error('OVERFLOW_DIAGNOSTIC '+route+' '+JSON.stringify(diagnostic));
    throw new Error('Horizontal document overflow on '+route);
  }
}
async function main() {
  const baseUrl=required('EMCORE_PILOT_BASE_URL').replace(/\/$/,'');
  const expectedCommit=required('EMCORE_PILOT_EXPECTED_COMMIT');
  const bootstrapUrl=required('EMCORE_PILOT_BOOTSTRAP_URL');
  const outDir=required('EMCORE_OWNER_ACCEPTANCE_OUTPUT_DIR');
  await mkdir(outDir,{recursive:true});
  await deploymentIdentity(baseUrl,expectedCommit);
  const runtime=await runtimeConfig(baseUrl);
  const oidc=await githubOidcToken();
  let synthetic;
  let browser;
  try {
    synthetic=await bootstrap(bootstrapUrl,oidc,'setup');
    if(synthetic?.organizationId!==PILOT_ORGANIZATION_ID || typeof synthetic?.email!=='string' || typeof synthetic?.password!=='string' || typeof synthetic?.userId!=='string') throw new Error('Invalid synthetic bootstrap envelope');
    const supabase=createClient(runtime.supabaseUrl,runtime.supabasePublishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const signIn=await supabase.auth.signInWithPassword({email:synthetic.email,password:synthetic.password});
    if(signIn.error || !signIn.data.session) throw new Error('Synthetic sign-in failed');
    const enrollment=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'EMCORE owner acceptance screenshots'});
    const factorId=enrollment.data?.id, secret=enrollment.data?.totp?.secret;
    if(enrollment.error || typeof factorId!=='string' || typeof secret!=='string') throw new Error('TOTP enrollment failed');
    const challenge=await supabase.auth.mfa.challenge({factorId});
    if(challenge.error || typeof challenge.data?.id!=='string') throw new Error('TOTP challenge failed');
    const verification=await supabase.auth.mfa.verify({factorId,challengeId:challenge.data.id,code:deriveTotp(secret)});
    if(verification.error) throw new Error('TOTP verification failed');
    const session=(await supabase.auth.getSession()).data.session;
    if(!session?.access_token || !session?.refresh_token) throw new Error('AAL2 session missing');

    browser=await openPage(baseUrl);
    const expectedOrigin=new URL(baseUrl).origin;
    await waitFor(async()=>await browser.evalJs("location.origin==="+JSON.stringify(expectedOrigin)+" && document.readyState !== 'loading'"),20000);
    const ref=new URL(runtime.supabaseUrl).hostname.split('.')[0];
    const storageKey='sb-'+ref+'-auth-token';
    await browser.evalJs("localStorage.setItem("+JSON.stringify(storageKey)+","+JSON.stringify(JSON.stringify(session))+"); true");
    await browser.send('Page.reload',{ignoreCache:true});
    await waitForPortal(browser);
    const g03LiveEndpointAcceptance=await performG03LiveEndpointAcceptance(browser);

    for(const [profile,width,height,mobile] of [['desktop',1365,900,false],['mobile',390,844,true]]) {
      await setViewport(browser,width,height,mobile);
      for(const route of routes) {
        await openRoute(browser,route);
        await screenshot(browser,outDir+'/'+profile+'-'+route+'.png');
      }
    }
    await setViewport(browser,800,1280,false);
    await openRoute(browser,'simulation');
    await screenshot(browser,outDir+'/tablet-simulation.png');
    const manifest={
      schema:'emcore.owner-acceptance-screenshot-pack.v1',
      generatedAt:new Date().toISOString(),
      deployedCommit:expectedCommit,
      deployedTree:required('EMCORE_PILOT_EXPECTED_TREE'),
      pilotBaseUrl:baseUrl,
      organizationId:PILOT_ORGANIZATION_ID,
      syntheticTestContext:true,
      customerDataUsed:false,
      documentIngestionEnabled:false,
      g03SimulationDeepLink:G03_SIMULATION_HASH,
      g03LiveEndpointAcceptance,
      viewports:{desktop:'1365x900',mobile:'390x844',tablet:'800x1280'},
      routes,
      screenshots:[...routes.flatMap(route=>['desktop-'+route+'.png','mobile-'+route+'.png']),'tablet-simulation.png'],
    };
    await writeFile(outDir+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');
    console.log('G03_LIVE_ENDPOINT_ACCEPTANCE=PASS GET='+g03LiveEndpointAcceptance.canonicalInputGet.status+' POST='+g03LiveEndpointAcceptance.simulationPost.status);
    console.log('OWNER_ACCEPTANCE_SCREENSHOT_PACK=PASS');
  } finally {
    browser?.close();
    if(synthetic?.userId) await bootstrap(bootstrapUrl,oidc,'cleanup',synthetic.userId);
  }
}
main().catch(error=>{console.error(error instanceof Error ? error.message : String(error));process.exit(1)});
