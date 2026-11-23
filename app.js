/* Draw My Route
   Draw a route -> find the fewest "fake" stops that force Google Maps / Apple Maps onto it -> share links. */
(function(){
'use strict';
const DEMO = window.DMR_DEMO || null;          // embedded Waukesha map + road graph (offline demo build)
/* How hard to pin the route down. More stops = more reliable, but more "arriving at stop" announcements.
   second: also check the stops against a second routing engine. maxGap: longest stretch (metres) allowed without a stop. */
const LEVELS = {
  few:      {label:'Lightest',      second:false, maxGap:0,        note:'Lightest: a pass-through point only where the fastest route would leave yours. Fewest announcements.'},
  balanced: {label:'Balanced',      second:true,  maxGap:2000,  note:'Balanced: checked against two routing engines, with a pass-through point at least every 2 km (1.2 mi).'},
  most:     {label:'Firmest',       second:true,  maxGap:700,  note:'Firmest: checked against two routing engines, with a pass-through point at least every 700 m (0.4 mi). Expect frequent announcements.'},
};
const PART_MAX = 9;                                // Google Maps URLs allow up to 9 waypoints
const TOL = 22;                                    // meters: how close a route must be to count as "the same road"
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function toast(t, ms=2800){const el=$('toast');el.textContent=t;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,ms)}
function load(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function store(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
const fmtDist = m => {const mi=m/1609.344;if(mi<0.1)return Math.max(50,Math.round(m*3.28084/50)*50)+' ft';return (mi<10?mi.toFixed(1):Math.round(mi))+' mi'};
const fmtTime = s => {const m=Math.max(1,Math.round(s/60));return m<60?m+' min':Math.floor(m/60)+' hr '+(m%60)+' min'};
const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* ---------------- Geometry (meters, local flat projection) ---------------- */
let REF=[43.01,-88.235], KX=111320*Math.cos(REF[0]*Math.PI/180), KY=110540;
function setRef(ll){REF=ll;KX=111320*Math.cos(ll[0]*Math.PI/180)}
const P = ll => [(ll[1]-REF[1])*KX, (REF[0]-ll[0])*KY];
const U = xy => [REF[0]-xy[1]/KY, REF[1]+xy[0]/KX];
const hyp = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
function hav(a,b){const R=6371000,r=Math.PI/180,dLa=(b[0]-a[0])*r,dLo=(b[1]-a[1])*r;const h=Math.sin(dLa/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function resample(xy, step){
  const out=[xy[0]], al=[0];let carry=0,total=0;
  for(let i=1;i<xy.length;i++){
    const a=xy[i-1],b=xy[i],L=hyp(a,b);if(L===0)continue;
    let d=step-carry;
    while(d<=L){out.push([a[0]+(b[0]-a[0])*d/L,a[1]+(b[1]-a[1])*d/L]);al.push(total+d);d+=step}
    carry=L-(d-step);total+=L;
  }
  const last=xy[xy.length-1];if(hyp(out[out.length-1],last)>0.5){out.push(last);al.push(total)}
  return {pts:out,along:al,len:total};
}
/* Grid index over a polyline's segments, for fast "distance to this route" checks. */
function indexLine(pts, cell=50){
  const g=new Map(),k=(i,j)=>i+','+j;
  for(let s=0;s<pts.length-1;s++){const a=pts[s],b=pts[s+1];
    const i0=Math.floor(Math.min(a[0],b[0])/cell),i1=Math.floor(Math.max(a[0],b[0])/cell),j0=Math.floor(Math.min(a[1],b[1])/cell),j1=Math.floor(Math.max(a[1],b[1])/cell);
    for(let i=i0;i<=i1;i++)for(let j=j0;j<=j1;j++){const key=k(i,j);if(!g.has(key))g.set(key,[]);g.get(key).push(s)}}
  return {g,pts,cell};
}
function distToLine(ix,p){
  const {g,pts,cell}=ix,ci=Math.floor(p[0]/cell),cj=Math.floor(p[1]/cell);let best=Infinity;
  for(let i=ci-1;i<=ci+1;i++)for(let j=cj-1;j<=cj+1;j++){const segs=g.get(i+','+j);if(!segs)continue;
    for(const s of segs){const a=pts[s],b=pts[s+1],dx=b[0]-a[0],dy=b[1]-a[1],L2=dx*dx+dy*dy;
      let t=L2?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2:0;t=Math.max(0,Math.min(1,t));
      const d=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);if(d<best)best=d}}
  return best;
}
/* Douglas-Peucker in xy */
function simplify(pts,eps){if(pts.length<3)return pts.slice();const a=pts[0],b=pts[pts.length-1];let m=0,mi=0;
  for(let i=1;i<pts.length-1;i++){const p=pts[i],dx=b[0]-a[0],dy=b[1]-a[1],L=Math.hypot(dx,dy)||1e-9,d=Math.abs(dy*p[0]-dx*p[1]+b[0]*a[1]-b[1]*a[0])/L;if(d>m){m=d;mi=i}}
  if(m<eps)return [a,b];return simplify(pts.slice(0,mi+1),eps).slice(0,-1).concat(simplify(pts.slice(mi),eps))}

/* Intersection registry: stops are placed away from intersections so they snap to the right road. */
const INTER={g:new Map(),cell:60};
const ixy=ll=>[ll[1]*111320*Math.cos(ll[0]*Math.PI/180),-ll[0]*110540];
function addInter(ll){const xy=ixy(ll);const k=Math.floor(xy[0]/INTER.cell)+','+Math.floor(xy[1]/INTER.cell);if(!INTER.g.has(k))INTER.g.set(k,[]);const arr=INTER.g.get(k);if(arr.length<40)arr.push(xy)}
function interDist(ll){const xy=ixy(ll),ci=Math.floor(xy[0]/INTER.cell),cj=Math.floor(xy[1]/INTER.cell);let b=Infinity;
  for(let i=ci-1;i<=ci+1;i++)for(let j=cj-1;j<=cj+1;j++){const a=INTER.g.get(i+','+j);if(a)for(const q of a){const d=hyp(xy,q);if(d<b)b=d}}return b}

/* ---------------- Routers ---------------- */
/* Hosted: public OSRM (OpenStreetMap) driving router. */
/* Fetch JSON from a routing service: plain-language errors, and a few spaced retries when it says it is busy. */
async function getJSON(url,tries=0){
  let r;const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),10000);   // never wait on a silent server for more than 10 seconds
  try{r=await fetch(url,{signal:ctl.signal})}
  catch(e){clearTimeout(timer);                                                           // the free servers drop the odd connection: try once more before giving up
    if(tries<1){await sleep(700);return getJSON(url,tries+1)}
    throw new Error("Can't reach the routing service. Check your connection and try again.")}
  if(r.status===429){if(tries>=3)throw new Error('The routing service is busy right now. Wait a minute and try again.');await sleep(1500*(tries+1));return getJSON(url,tries+1)}
  try{return await r.json()}catch(e){throw new Error('The routing service is having trouble. Try again in a minute.')}
  finally{clearTimeout(timer)}
}
let lastCall=0;
const LOOP_TURN=200,LOOP_LONG=1500;                  // degrees a ramp must turn to count as a loop; metres: longer than this is not a ramp
function turnOf(c){let tot=0,prev=null;const k=Math.cos(c[0][0]*Math.PI/180);
  for(let i=1;i<c.length;i++){const dx=(c[i][1]-c[i-1][1])*k,dy=c[i][0]-c[i-1][0];if(!dx&&!dy)continue;const h=Math.atan2(dx,dy)*180/Math.PI;
    if(prev!==null)tot+=((h-prev+540)%360)-180;prev=h}return tot}
async function osrmRoute(pts){
  const wait=lastCall+350-Date.now();if(wait>0)await sleep(wait);lastCall=Date.now();
  const s=pts.map(p=>p[1].toFixed(6)+','+p[0].toFixed(6)).join(';');
  const j=await getJSON(`https://router.project-osrm.org/route/v1/driving/${s}?overview=full&geometries=geojson&steps=true`);
  if(j.code!=='Ok')throw new Error(j.code==='NoRoute'||j.code==='NoSegment'?'No drivable route between two of your points.':(j.message||'No route found'));
  const rt=j.routes[0];
  // exits: how many times the route comes off the freeway and later gets back on. Each time it gets on from an ordinary
  // road the directions say "on ramp" (going from one freeway to another they say "merge" or "fork"), so: on-ramps, less the first.
  // loops: cloverleaf loop ramps on the route. A loop ramp is a short piece of road that turns most of a full circle
  // (LOOP_TURN degrees or more; a flyover or an ordinary ramp turns 90 or so). Roundabouts are not ramps.
  let hwy=false,ramps=0,loops=0;
  rt.legs.forEach(l=>l.steps.forEach(st=>{const ty=st.maneuver&&st.maneuver.type;if(ty==='on ramp')ramps++;
    if(st.distance<LOOP_LONG&&st.geometry&&ty!=='roundabout'&&ty!=='rotary'&&ty!=='exit roundabout'&&ty!=='exit rotary'&&Math.abs(turnOf(st.geometry.coordinates.map(c=>[c[1],c[0]])))>=LOOP_TURN)loops++;
    (st.intersections||[]).forEach(i=>{if((i.bearings||[]).length>=3)addInter([i.location[1],i.location[0]]);if((i.classes||[]).includes('motorway'))hwy=true})}));
  return {coords:rt.geometry.coordinates.map(c=>[c[1],c[0]]),distance:rt.distance,duration:rt.duration,hwy,exits:Math.max(0,ramps-1),loops};
}

/* Hosted, avoid-highways predictions: public Valhalla router (OSRM's public server can't avoid highways). */
let lastV=0;
function dec6(s){const pts=[];let i=0,la=0,lo=0;const d=()=>{let r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&0x1f)<<sh;sh+=5}while(b>=0x20);return r&1?~(r>>1):r>>1};
  while(i<s.length){la+=d();lo+=d();pts.push([la/1e6,lo/1e6])}return pts}
const VALHALLA_MAX=10;                                // the public server refuses requests with more than 10 points
async function valhallaRoute(pts,avoid=true,exclude=null){
  if(pts.length>VALHALLA_MAX){                        // every point is a full stop, so routing in overlapping pieces gives the same answer
    let coords=[],distance=0,duration=0;
    for(let i=0;i<pts.length-1;i+=VALHALLA_MAX-1){const r=await valhallaRoute(pts.slice(i,i+VALHALLA_MAX),avoid,exclude);
      coords=coords.length?coords.concat(r.coords.slice(1)):r.coords;distance+=r.distance;duration+=r.duration}
    return {coords,distance,duration};
  }
  const wait=lastV+1100-Date.now();if(wait>0)await sleep(wait);lastV=Date.now();
  const q={locations:pts.map(p=>({lat:+p[0].toFixed(6),lon:+p[1].toFixed(6),type:'break'})),costing:'auto',...(avoid?{costing_options:{auto:{use_highways:0}}}:{}),...(exclude&&exclude.length?{exclude_locations:exclude.map(z=>({lat:+z[0].toFixed(6),lon:+z[1].toFixed(6)}))}:{}),directions_options:{units:'kilometers'}};
  const j=await getJSON('https://valhalla1.openstreetmap.de/route?json='+encodeURIComponent(JSON.stringify(q)));
  if(!j.trip)throw new Error(j.error||'No route found');
  let coords=[];j.trip.legs.forEach(l=>{const c=dec6(l.shape);coords=coords.length?coords.concat(c.slice(1)):c});
  return {coords,distance:j.trip.summary.length*1000,duration:j.trip.summary.time};
}

/* Demo: the same idea, computed locally on Waukesha's OpenStreetMap road graph. */
function makeLocalRouter(GR){
  const LAT0=43.01,LON0=-88.235,LKX=111320*Math.cos(LAT0*Math.PI/180),LKY=110540;
  const toXY=ll=>[(ll[1]-LON0)*LKX,-(ll[0]-LAT0)*LKY], toLL=p=>[LAT0-p[1]/LKY,LON0+p[0]/LKX];
  const N=[];for(let i=0;i<GR.n.length;i+=2)N.push({x:GR.n[i],y:GR.n[i+1],out:[],deg:0});
  const E=GR.e.map(([a,b,nm,cls,sp,one,mid])=>{const g=[[N[a].x,N[a].y]];for(let i=0;i<mid.length;i+=2)g.push([mid[i],mid[i+1]]);g.push([N[b].x,N[b].y]);
    const cum=[0];for(let i=1;i<g.length;i++)cum.push(cum[i-1]+hyp(g[i-1],g[i]));return {a,b,one,v:sp*0.44704,g,cum,len:Math.max(cum[cum.length-1],1),hw:cls%10<=1}});
  const hs=new Float64Array(E.length*2),he=new Float64Array(E.length*2),H=(p,q)=>Math.atan2(q[1]-p[1],q[0]-p[0]);
  E.forEach((e,id)=>{N[e.a].deg++;N[e.b].deg++;if(e.one!==-1)N[e.a].out.push(2*id);if(e.one!==1)N[e.b].out.push(2*id+1);
    const g=e.g,n=g.length;hs[2*id]=H(g[0],g[1]);he[2*id]=H(g[n-2],g[n-1]);hs[2*id+1]=H(g[n-1],g[n-2]);he[2*id+1]=H(g[1],g[0])});
  N.forEach(n=>{if(n.deg>=3)addInter(toLL([n.x,n.y]))});
  const arcTo=k=>k&1?E[k>>1].a:E[k>>1].b;
  const turn=(k1,k2)=>{if((k1>>1)===(k2>>1))return 45;let d=(hs[k2]-he[k1])*180/Math.PI;d=((d+540)%360)-180;const a=Math.abs(d);return a<30?0:a<140?(d>0?5:10):20};
  // segment grid for snapping
  const SG=new Map(),SC=80;
  E.forEach((e,id)=>{for(let s=0;s<e.g.length-1;s++){const a=e.g[s],b=e.g[s+1];
    for(let i=Math.floor(Math.min(a[0],b[0])/SC);i<=Math.floor(Math.max(a[0],b[0])/SC);i++)for(let j=Math.floor(Math.min(a[1],b[1])/SC);j<=Math.floor(Math.max(a[1],b[1])/SC);j++){const k=i+','+j;if(!SG.has(k))SG.set(k,[]);SG.get(k).push(id*10000+s)}}});
  function snap(ll){const p=toXY(ll);let best={d:Infinity};
    for(let r=1;r<=6&&best.d===Infinity;r+=2){const ci=Math.floor(p[0]/SC),cj=Math.floor(p[1]/SC);
      for(let i=ci-r;i<=ci+r;i++)for(let j=cj-r;j<=cj+r;j++){const L=SG.get(i+','+j);if(!L)continue;
        for(const code of L){const id=Math.floor(code/10000),s=code%10000,e=E[id],a=e.g[s],b=e.g[s+1],dx=b[0]-a[0],dy=b[1]-a[1],L2=dx*dx+dy*dy;
          let t=L2?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2:0;t=Math.max(0,Math.min(1,t));const q=[a[0]+t*dx,a[1]+t*dy],d=hyp(p,q);
          if(d<best.d)best={d,e:id,pos:e.cum[s]+t*(e.cum[s+1]-e.cum[s])}}}}
    if(best.d===Infinity)throw new Error('That spot is outside the demo map.');return best}
  function slice(e,p0,p1){const g=e.g,c=e.cum,out=[];const at=p=>{let i=0;while(i<c.length-2&&c[i+1]<p)i++;const t=(p-c[i])/((c[i+1]-c[i])||1);return [g[i][0]+t*(g[i+1][0]-g[i][0]),g[i][1]+t*(g[i+1][1]-g[i][1])]};
    out.push(at(p0));if(p1>=p0){for(let i=0;i<c.length;i++)if(c[i]>p0&&c[i]<p1)out.push(g[i])}else{for(let i=c.length-1;i>=0;i--)if(c[i]<p0&&c[i]>p1)out.push(g[i])}out.push(at(p1));return out}
  function arcPts(k){const e=E[k>>1];return k&1?e.g.slice().reverse():e.g}
  function leg(S,T,prevArc,avoid){
    const eS=E[S.e],eT=E[T.e],fwdS=eS.one!==-1,bwdS=eS.one!==1,fwdT=eT.one!==-1,bwdT=eT.one!==1;
    const uturn=a=>prevArc>=0&&(prevArc>>1)===(a>>1)&&prevArc!==a?60:0;
    let best={c:Infinity,arc:-2,last:-1};
    if(S.e===T.e){if(T.pos>=S.pos&&fwdS)best={c:(T.pos-S.pos)/eS.v+uturn(2*S.e),arc:-1,last:2*S.e};
      else if(T.pos<S.pos&&bwdS)best={c:(S.pos-T.pos)/eS.v+uturn(2*S.e+1),arc:-1,last:2*S.e+1}}
    const n2=E.length*2,dist=new Float64Array(n2).fill(Infinity),prev=new Int32Array(n2).fill(-1),hk=[],hv=[];
    const push=(k,v)=>{let i=hk.length;hk.push(k);hv.push(v);while(i>0){const p=(i-1)>>1;if(hv[p]<=v)break;hk[i]=hk[p];hv[i]=hv[p];i=p}hk[i]=k;hv[i]=v};
    const pop=()=>{const rk=hk[0],rv=hv[0],lk=hk.pop(),lv=hv.pop(),n=hk.length;if(n){let i=0;for(;;){const l=2*i+1,r=l+1;let m=i,mv=lv;if(l<n&&hv[l]<mv){m=l;mv=hv[l]}if(r<n&&hv[r]<mv)m=r;if(m===i)break;hk[i]=hk[m];hv[i]=hv[m];i=m}hk[i]=lk;hv[i]=lv}return [rk,rv]};
    if(fwdS){const k=2*S.e;dist[k]=(eS.len-S.pos)/eS.v+uturn(k);push(k,dist[k])}
    if(bwdS){const k=2*S.e+1;dist[k]=S.pos/eS.v+uturn(k);push(k,dist[k])}
    while(hk.length){const [k,d]=pop();if(d>dist[k])continue;if(d>=best.c)break;const n=arcTo(k);
      if(n===eT.a&&fwdT){const c=d+turn(k,2*T.e)+T.pos/eT.v;if(c<best.c)best={c,arc:k,last:2*T.e}}
      if(n===eT.b&&bwdT){const c=d+turn(k,2*T.e+1)+(eT.len-T.pos)/eT.v;if(c<best.c)best={c,arc:k,last:2*T.e+1}}
      for(const k2 of N[n].out){const e=E[k2>>1];const c=d+e.len/e.v*(avoid&&e.hw?6:1)+turn(k,k2);if(c<dist[k2]){dist[k2]=c;prev[k2]=k;push(k2,c)}}}
    if(best.arc===-2)throw new Error('No drivable route between two of your points.');
    let pts;
    if(best.arc===-1)pts=slice(eS,S.pos,T.pos);
    else{const arcs=[];for(let a=best.arc;a>=0;a=prev[a])arcs.unshift(a);
      pts=arcs[0]&1?slice(eS,S.pos,0):slice(eS,S.pos,eS.len);
      for(let i=1;i<arcs.length;i++)pts=pts.concat(arcPts(arcs[i]).slice(1));
      pts=pts.concat((best.last&1?slice(eT,eT.len,T.pos):slice(eT,0,T.pos)).slice(1))}
    let hwy=eS.hw||eT.hw;if(best.arc>=0)for(let a=best.arc;a>=0;a=prev[a])if(E[a>>1].hw){hwy=true;break}
    return {pts,time:best.c,last:best.last,hwy};
  }
  return async function(ptsLL,opt){
    const avoid=!!(opt&&opt.avoid);
    const S=ptsLL.map(snap);let all=[],time=0,prevArc=-1,hwy=false;
    for(let i=1;i<S.length;i++){const r=leg(S[i-1],S[i],prevArc,avoid);hwy=hwy||r.hwy;all=all.length?all.concat(r.pts.slice(1)):r.pts;time+=r.time;prevArc=r.last}
    let dist=0;for(let i=1;i<all.length;i++)dist+=hyp(all[i-1],all[i]);
    return {coords:all.map(toLL),distance:dist,duration:time,hwy};
  };
}
const route = DEMO ? makeLocalRouter(DEMO.graph) : (pts,opt)=>opt&&opt.avoid?valhallaRoute(pts):osrmRoute(pts);

/* ---------------- The fake-stop finder ---------------- */
/* Simulates "fastest route through these stops" and adds a stop wherever that route leaves yours,
   until it follows your route the whole way.
   With opts.second (a second, independent router) the stops must hold your route in BOTH routers:
   Google and Apple each make their own choices, so stops that only convince one router are fragile. */
async function findStops(desiredLL, opts, onProgress){
  setRef(desiredLL[0]);
  const D=resample(desiredLL.map(P),10),Dix=indexLine(D.pts);
  const origin=desiredLL[0],dest=desiredLL[desiredLL.length-1];
  const stops=[];let iter=0;const maxIter=opts.maxStops*2+10;
  const ZR=opts.zoneR||40;
  const allZ=(opts.zones||[]).map(z=>({ll:z,p:P(z)}));
  const blocked=allZ.filter(z=>distToLine(Dix,z.p)<=ZR);          // spots on your own route can't be avoided
  const Z=allZ.filter(z=>!blocked.includes(z));
  const avoidOnly=Z.length>0&&!opts.strict;
  const routers=[{fn:pts=>route(pts,{avoid:opts.avoid}),min:0.995,second:false}];
  if(opts.second)routers.push({fn:opts.second,min:0.97,second:true});
  let secondFailed=false,dirty=true;
  const evaluate=async R=>{
    const cand=await R.fn([origin,...stops.map(s=>s.ll),dest]);
    const C=resample(cand.coords.map(P),10),Cix=indexLine(C.pts);
    const dOn=D.pts.map(p=>distToLine(Cix,p)<=TOL),cOn=C.pts.map(p=>distToLine(Dix,p)<=TOL);
    const frac=a=>a.filter(Boolean).length/a.length;
    const score=Math.min(frac(dOn),frac(cOn));
    const hits=[];C.pts.forEach((p,j)=>{for(const z of Z)if(hyp(p,z.p)<=ZR){hits.push(j);break}});
    return {R,cand,C,dOn,cOn,score,hits,ok:avoidOnly?hits.length===0:score>=R.min};
  };
  /* Ask each router in turn. If the second router is unreachable, carry on with the first one alone. */
  const evalAll=async stopAtFirstBad=>{const out=[];
    for(const R of routers.slice()){let e;
      try{e=await evaluate(R)}catch(err){if(!R.second)throw err;routers.splice(routers.indexOf(R),1);secondFailed=true;continue}
      out.push(e);if(stopAtFirstBad&&!e.ok)break}
    dirty=false;return out};
  const stretches=(on,along,minLen)=>{const out=[];let i=0;while(i<on.length){if(on[i]){i++;continue}let j=i;while(j<on.length&&!on[j])j++;
    if(along[j-1]-along[i]+10>=minLen)out.push([i,j-1]);i=j}return out};
  const placeIn=(i0,i1)=>{ // candidate positions inside a stretch of YOUR route, best first
    const a0=D.along[i0],a1=D.along[i1],mid=(a0+a1)/2,len=Math.max(a1-a0,10),c=[];
    for(let i=i0;i<=i1;i++){const al=D.along[i];if(len>60&&(al-a0<18||a1-al<18))continue;
      const ll=U(D.pts[i]),di=Math.min(interDist(ll),70);c.push({i,s:di-25*Math.abs(al-mid)/len})}
    if(!c.length)c.push({i:Math.round((i0+i1)/2),s:0});
    return c.sort((x,y)=>y.s-x.s).map(x=>x.i);
  };
  const addStop=(i0,i1)=>{const cands=placeIn(i0,i1),i=cands[0];dirty=true;
    stops.push({i,ll:U(D.pts[i]),along:D.along[i],cands,k:0});stops.sort((a,b)=>a.along-b.along)};
  let E=[],phase2=false;
  const converge=async()=>{while(iter++<maxIter){
    onProgress&&onProgress(stops.length,phase2);
    E=await evalAll(true);
    const ev=E.find(e=>!e.ok);
    if(!ev)break;
    phase2=ev.R.second;
    if(stops.length>=opts.maxStops)break;
    const {dOn,cOn,C,hits}=ev;
    const near=p=>{let b=0,bd=Infinity;D.pts.forEach((q,i)=>{const d=hyp(p,q);if(d<bd){bd=d;b=i}});return b};
    if(avoidOnly){
      // Only fix the place where the predicted route runs into a spot you marked.
      let j0=hits[0],j1=hits[0];while(j0>0&&!cOn[j0-1])j0--;while(j1<C.pts.length-1&&!cOn[j1+1])j1++;
      let ia=near(C.pts[Math.max(0,j0-1)]),ib=near(C.pts[Math.min(C.pts.length-1,j1+1)]);if(ia>ib)[ia,ib]=[ib,ia];
      if(D.along[ib]-D.along[ia]>40){addStop(ia,ib);continue}
    }
    let gaps=stretches(dOn,D.along,ev.R.second?40:20);
    // A stretch the second router still misses even with a stop in it is a mapping difference a stop can't fix: leave it.
    if(ev.R.second)gaps=gaps.filter(([a,b])=>!stops.some(st=>st.i>=a&&st.i<=b));
    if(gaps.length&&!avoidOnly){addStop(gaps[0][0],gaps[0][1]);continue}
    if(ev.R.second)break;                                            // don't reshuffle stops the first router is happy with
    // Your route is covered, but the simulated one makes an extra detour (often a U-turn around a stop).
    const det=stretches(cOn,C.along,20);if(!det.length)break;
    const [j0,j1]=det[0],pa=C.pts[Math.max(0,j0-1)],pb=C.pts[Math.min(C.pts.length-1,j1+1)];
    let ia=near(pa),ib=near(pb);if(ia>ib)[ia,ib]=[ib,ia];
    if(D.along[ib]-D.along[ia]>40){addStop(ia,ib);continue}
    // A spur: move the stop closest to it to its next-best spot, or drop it.
    let s=null,sd=Infinity;for(const st of stops){for(let j=j0;j<=j1;j++){const d=hyp(D.pts[st.i],C.pts[j]);if(d<sd){sd=d;s=st}}}
    if(!s)break;
    dirty=true;
    s.k++;if(s.k<Math.min(s.cands.length,6)){s.i=s.cands[s.k];s.ll=U(D.pts[s.i]);s.along=D.along[s.i]}else stops.splice(stops.indexOf(s),1);
  }};
  /* Spacing: on a long stretch with no stop, a maps app is free to pick its own road. With opts.maxGap, add evenly
     spaced stops so no stretch between stops is longer than that many metres. */
  const space=()=>{if(!opts.maxGap||avoidOnly)return 0;
    const anchors=[0,...stops.map(s=>s.along),D.len],plan=[];let added=0;
    for(let i=1;i<anchors.length;i++){const g=anchors[i]-anchors[i-1];if(g<=opts.maxGap)continue;const n=Math.ceil(g/opts.maxGap)-1;
      for(let k=1;k<=n;k++)plan.push({m:anchors[i-1]+g*k/(n+1),w:Math.min(150,g/(n+1)/4)})}
    for(const {m,w} of plan){if(stops.length>=opts.maxStops)break;
      let i0=D.along.findIndex(a=>a>=m-w),i1=D.along.findIndex(a=>a>=m+w);if(i0<0)continue;if(i1<0)i1=D.pts.length-1;
      addStop(i0,i1);added++}
    return added};
  await converge();
  for(let round=0;round<3&&space();round++)await converge();        // spacing stops can need a little tidying themselves
  if(dirty||E.length<routers.length){onProgress&&onProgress(stops.length,routers.length>1);E=await evalAll(false)}
  const first=E.find(e=>!e.R.second),sec=E.find(e=>e.R.second)||null;
  const crossedBy=e=>Z.filter(z=>e.C.pts.some(p=>hyp(p,z.p)<=ZR)).length;
  return {origin,dest,stops:stops.map(s=>s.ll),cand:first.cand,cand2:sec?sec.cand:null,score:first.score,score2:sec?sec.score:null,
    match:sec?Math.min(first.score,sec.score):first.score,checked:sec?'two':secondFailed?'failed':'one',
    length:D.len,avoidOnly,avoid:!!opts.avoid,zones:Z.length,blocked:blocked.length,crossed:Math.max(...E.map(crossedBy))};
}

/* ---------------- Links ---------------- */
const f6=ll=>ll[0].toFixed(6)+','+ll[1].toFixed(6);
/* names (optional): {o, d} text for the trip's real start and destination: a place name with its address, or a street address.
   Only the first part's start and the last part's end get one. Every stop, and the joins between parts, stay coordinates. */
function splitParts(origin,dest,stops,names){const parts=[];let o=origin,i=0;
  for(;;){const rest=stops.slice(i);if(rest.length<=PART_MAX){parts.push({o,w:rest,d:dest});break}parts.push({o,w:rest.slice(0,PART_MAX),d:rest[PART_MAX]});o=rest[PART_MAX];i+=PART_MAX+1}
  if(names){if(names.o)parts[0].on=names.o;if(names.d)parts[parts.length-1].dn=names.d}
  return parts}
function googleLink(p,fromHere,avoid){const e=s=>encodeURIComponent(s);
  let w=p.w.slice();if(fromHere)w=[p.o,...w];
  return 'https://www.google.com/maps/dir/?api=1'+(fromHere?'':'&origin='+e(p.on||f6(p.o)))+'&destination='+e(p.dn||f6(p.d))+'&travelmode=driving&dir_action=navigate'+(avoid?'&avoid=highways':'')+(w.length?'&waypoints='+w.map(x=>e(f6(x))).join('%7C'):'')}
function appleLink(p,fromHere,avoid){const e=s=>encodeURIComponent(s);
  let w=p.w.slice();if(fromHere)w=[p.o,...w];
  return 'https://maps.apple.com/directions?'+(fromHere?'':'source='+e(p.on||f6(p.o))+'&')+'destination='+e(p.dn||f6(p.d))+w.map(x=>'&waypoint='+e(f6(x))).join('')+'&mode=driving'+(avoid?'&avoid=highways':'')}

/* polyline encode/decode (Google's algorithm) for share links */
function encPoly(pts){let out='',pl=0,pn=0;const enc=v=>{v=v<0?~(v<<1):v<<1;let s='';while(v>=0x20){s+=String.fromCharCode((0x20|(v&0x1f))+63);v>>=5}return s+String.fromCharCode(v+63)};
  for(const [la,lo] of pts){const a=Math.round(la*1e5),b=Math.round(lo*1e5);out+=enc(a-pl)+enc(b-pn);pl=a;pn=b}return out}
function decPoly(s){const pts=[];let i=0,la=0,lo=0;const dec=()=>{let r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&0x1f)<<sh;sh+=5}while(b>=0x20);return r&1?~(r>>1):r>>1};
  while(i<s.length){la+=dec();lo+=dec();pts.push([la/1e5,lo/1e5])}return pts}
const b64u={enc:s=>btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),dec:s=>decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/'))))};

/* ---------------- Map ---------------- */
const BOUNDS = DEMO ? L.latLngBounds([42.975,-88.285],[43.045,-88.185]) : null;
const map=L.map('map',{zoomControl:false,attributionControl:true,minZoom:DEMO?11:3}).setView(DEMO?[43.0117,-88.2315]:[39.5,-98.35],DEMO?14:4);   // a neutral wide view: nothing is known about the visitor
if(DEMO){
  const T=DEMO.tiles,cache={};
  const getImg=k=>cache[k]||(cache[k]=new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=T[k]}));
  const DemoLayer=L.GridLayer.extend({createTile(c,done){
    const cv=document.createElement('canvas');cv.width=cv.height=256;
    let z=c.z,x=c.x,y=c.y;while(z>=12&&!T[z+'/'+x+'/'+y]){x>>=1;y>>=1;z--}
    if(z<12){setTimeout(()=>done(null,cv));return cv}
    const sc=2**(c.z-z),sz=256/sc,ox=(c.x-x*sc)*sz,oy=(c.y-y*sc)*sz;
    getImg(z+'/'+x+'/'+y).then(im=>{if(im){const g=cv.getContext('2d');g.imageSmoothingEnabled=true;g.drawImage(im,ox,oy,sz,sz,0,0,256,256)}done(null,cv)});
    return cv}});
  new DemoLayer({maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
}else{
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'}).addTo(map);
  // The visitor's location is never requested when the page opens: only when they tap the location button (useMyLocation).
}

/* ---------------- State ---------------- */
const S={mode:'draw',pts:[],snap:true,desired:null,markers:[],line:null,busy:0,result:null,resLayers:[],level:load('dmr.level','few'),tool:'route',zones:[],zoneLayers:[],strict:false,fromHere:load('wps.fromHere',false),name:'',note:'',fromLabel:'',toLabel:'',fromQ:'',toQ:'',toWait:null,grab:null};
const sheet=$('sheet');

function pinIcon(label,cls){return L.divIcon({className:'',html:`<div class="pin ${cls}">${label}</div>`,iconSize:[26,26],iconAnchor:[13,13]})}
function drawPoints(){
  S.markers.forEach(m=>map.removeLayer(m));S.markers=[];
  if(S.mode!=='draw')return;
  S.pts.forEach((p,i)=>{const last=i===S.pts.length-1&&i>0;
    const m=L.marker(p,{draggable:true,icon:pinIcon(i===0?'A':last?'B':i,i===0?'start':last?'end':'mid'),zIndexOffset:500}).addTo(map);
    const via=i>0&&!last;
    m.on('dragstart',()=>{if(S.pts.length>1)liveStart(i,finePointer(),via)});
    m.on('drag',e=>{const ll=e.target.getLatLng(),c=map.latLngToContainerPoint(ll);liveMove([ll.lat,ll.lng],c.x,c.y)});
    m.on('dragend',e=>{const ll=e.target.getLatLng();if(!live.on||!liveNear(live.pt,[map.latLngToContainerPoint(ll).x,map.latLngToContainerPoint(ll).y]))S.pts[i]=[ll.lat,ll.lng];
      if(i===0){S.fromLabel='';S.fromQ=''}else if(last){S.toLabel='';S.toQ=''}
      if(live.on)liveEnd();else changed();
      if(i===0)describeEnd('from');else if(last)describeEnd('to')});
    m.on('click',()=>{const div=document.createElement('div');div.className='pop';div.innerHTML=`<b>${i===0?'Start':last?'Destination':'Your route goes through here'}</b><button class="btn small danger">Remove</button>`;
      div.querySelector('button').onclick=()=>{map.closePopup();removePt(i);changed()};m.bindPopup(div,{closeButton:false}).openPopup()});
    S.markers.push(m)});
}
function removePt(i){const n=S.pts.length;
  if(i===0){S.fromLabel=n===2?S.toLabel:'';S.fromQ=n===2?S.toQ:'';if(n===2){S.toLabel='';S.toQ=''}}else if(i===n-1){S.toLabel='';S.toQ=''}
  S.pts.splice(i,1)}
/* What to call a place in the maps apps. From an OpenStreetMap search or reverse-lookup result: a named place with its
   address ("Frame Park, 1150 Baxter St, Waukesha, Wisconsin 53186"), or a street address with a house number. Anything
   vaguer (a bare road or town) returns '' and the place goes out as coordinates, which are exact. */
function placeText(p){
  const a=p.address||{},town=a.city||a.town||a.village||a.hamlet||a.municipality||'';
  const street=a.road?((a.house_number?a.house_number+' ':'')+a.road):'';
  const named=!!p.name&&p.name!==a.road&&!['highway','place','boundary','waterway','railway'].includes(p.category||p.class);
  if(!town||(!named&&!a.house_number))return {label:p.name||street||'',q:''};
  const tail=[town,[a.state,a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {label:named?p.name:street,q:[named?p.name:'',named&&!a.house_number?'':street,tail].filter(Boolean).join(', ')};
}
/* Look up the address at one end of the trip (a tapped or dragged pin, or the user's own location). */
async function describeEnd(which){
  if(DEMO)return;
  const ll=which==='from'?S.pts[0]:S.pts[S.pts.length-1];if(!ll||(which==='to'&&S.pts.length<2))return;
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${ll[0].toFixed(6)}&lon=${ll[1].toFixed(6)}`);
    const p=await r.json();if(!p||p.error)return;
    if((which==='from'?S.pts[0]:S.pts[S.pts.length-1])!==ll)return;     // the pin has moved since we asked
    if(hav(ll,[+p.lat,+p.lon])>60)return;                              // nearest address is too far off to stand for this spot
    const t=placeText(p);if(!t.q)return;
    if(which==='from'){if(S.fromLabel!=='My location')S.fromLabel=t.label;S.fromQ=t.q}else{S.toLabel=t.label;S.toQ=t.q}
    syncEnds();
  }catch(e){/* no address: the end goes out as coordinates */}
}
/* From / To boxes */
function syncEnds(){const n=S.pts.length,f=$('q-from'),t=$('q-to');if(!f||!t)return;
  if(document.activeElement!==f)f.value=n?S.fromLabel||'Pin on map':'';
  if(document.activeElement!==t)t.value=n>1?S.toLabel||'Pin on map':S.toWait?S.toWait.label:''}
function setEnd(which,ll,label,q=''){
  if(S.mode!=='draw')editRoute();
  if(which==='from'){S.fromLabel=label;S.fromQ=q;
    if(S.pts.length)S.pts[0]=ll;else{S.pts.push(ll);if(S.toWait){S.pts.push(S.toWait.ll);S.toLabel=S.toWait.label;S.toQ=S.toWait.q||'';S.toWait=null}}}
  else{
    if(!S.pts.length){S.toWait={ll,label,q};syncEnds();map.setView(ll,14);toast('Now set where you are starting from.');return}
    S.toLabel=label;S.toQ=q;if(S.pts.length===1)S.pts.push(ll);else S.pts[S.pts.length-1]=ll}
  if(S.pts.length<2)map.setView(ll,15);else S.fitNext=true;
  changed();
  if(!q)describeEnd(which);                                            // my location or a bare spot: find its address
}
/* The location button: the only place the visitor's location is ever requested. The browser shows its own permission
   prompt; the site adds no question of its own. */
function useMyLocation(){
  if(!navigator.geolocation){toast('This browser cannot share your location.');return}
  locateNow();
}
function locateNow(){
  toast('Finding your location…');
  navigator.geolocation.getCurrentPosition(p=>{toast('Starting from your location');setEnd('from',[p.coords.latitude,p.coords.longitude],'My location')},
    ()=>toast('Could not get your location. Type a starting place or tap the map.',4000),{timeout:8000});
}
const ZONE_R=40;
function drawZones(){
  S.zoneLayers.forEach(l=>map.removeLayer(l));S.zoneLayers=[];
  const editable=S.mode==='draw';
  S.zones.forEach((z,i)=>{
    S.zoneLayers.push(L.circle(z,{radius:ZONE_R,color:css('--danger'),weight:2,fillColor:css('--danger'),fillOpacity:.22,interactive:false}).addTo(map));
    const m=L.marker(z,{icon:pinIcon('✕','avoid'),interactive:editable,zIndexOffset:400}).addTo(map);
    if(editable)m.on('click',()=>{const div=document.createElement('div');div.className='pop';div.innerHTML='<b>Avoiding this road</b><button class="btn small danger">Remove</button>';
      div.querySelector('button').onclick=()=>{map.closePopup();S.zones.splice(i,1);drawZones();changed()};m.bindPopup(div,{closeButton:false}).openPopup()});
    S.zoneLayers.push(m)});
}
let rt;function changed(){drawPoints();syncEnds();clearTimeout(rt);rt=setTimeout(recompute,200);render();ensureLocal()}
async function routeFor(pts,warn){
  // Roads for this area are on the phone: route here, no server asked. (Falls through if a point is off the downloaded roads.)
  if(S.snap&&localCovers(pts)){const r=local.net.route(pts,{blocked:localBlocked(),cache:local.cache});if(r){r.src='phone';return r}}
  if(!S.snap){let d=0;for(let i=1;i<pts.length;i++)d+=hav(pts[i-1],pts[i]);return {coords:pts.slice(),distance:d,duration:d/13}}
  if(S.zones.length&&!DEMO){
    // Roads marked ✕: ask the engine that can keep off given spots. If it can't answer, fall back and say so.
    try{return await valhallaRoute(pts,false,S.zones)}
    catch(e){if(warn)toast("Couldn't route around your ✕ marks just now. Drag the line off those roads instead.",4500);return route(pts)}}
  return route(pts);
}
function clearLine(){if(S.line){map.removeLayer(S.line);S.line=null}if(S.grab){map.removeLayer(S.grab);S.grab=null}}
async function recompute(){
  if(S.pts.length<2){clearLine();S.desired=null;render();return}
  const id=++S.busy;render();
  try{const r=await routeFor(S.pts,true);
    if(id!==S.busy)return;S.desired=r;
  }catch(e){if(id!==S.busy)return;S.desired=null;toast(e.message||'Could not fit your route to roads.')}
  S.busy=0;clearLine();
  if(S.desired){
    S.line=L.polyline(S.desired.coords,{color:css('--drawn'),weight:7,opacity:.95,interactive:false}).addTo(map);
    if(S.snap){ // wide invisible strip over the line, so it is easy to grab
      S.grab=L.polyline(S.desired.coords,{color:'#000',weight:34,opacity:0,interactive:true}).addTo(map);
      const el=S.grab.getElement();if(el){el.style.cursor='grab';el.style.touchAction='none';el.addEventListener('pointerdown',startLineDrag)}}
  }
  render();
  if(S.fitNext&&S.desired){S.fitNext=false;fitRoute(S.desired.coords)}
  ensureLocal();
}

/* ---------------- Local roads: instant redraws while dragging ---------------- */
/* Once a route exists, the roads around it are downloaded (roads.js) so the line can follow a finger with no server
   round trip. The routing server still draws the final line on release: its fastest route is what Google and Apple
   most often agree with, which keeps stops to a minimum. If the download fails, dragging falls back to asking the server. */
const ROADS=window.DMRRoads||null;
const local={status:'none',box:null,net:null,job:0,failedAt:0,cache:new Map(),blocked:null,blockedKey:''};
const metresPerPx=lat=>40075016.686*Math.cos(lat*Math.PI/180)/(256*2**map.getZoom());
function boxAround(coords,padM){let s=90,w=180,n=-90,e=-180;for(const c of coords){if(c[0]<s)s=c[0];if(c[0]>n)n=c[0];if(c[1]<w)w=c[1];if(c[1]>e)e=c[1]}
  const dLat=padM/110540,dLon=padM/(111320*Math.cos((s+n)/2*Math.PI/180));return [s-dLat,w-dLon,n+dLat,e+dLon]}
const boxHolds=(B,b)=>!!B&&b[0]>=B[0]&&b[1]>=B[1]&&b[2]<=B[2]&&b[3]<=B[3];
const boxKm2=b=>(b[2]-b[0])*110.54*(b[3]-b[1])*111.32*Math.cos((b[0]+b[2])/2*Math.PI/180);
const localCovers=pts=>local.status==='ready'&&boxHolds(local.box,boxAround(pts,150));
async function ensureLocal(){
  if(DEMO||!ROADS||!S.snap||S.pts.length<2)return;
  const around=S.desired?S.desired.coords:S.pts,need=boxAround(around,400);
  if(boxHolds(local.box,need)&&(local.status==='ready'||local.status==='loading'))return;
  const span=Math.max((need[2]-need[0])*110540,(need[3]-need[1])*111320*Math.cos(need[0]*Math.PI/180));
  const box=boxAround(around,Math.max(1500,0.3*span));       // room to drag the line well off the direct way
  if(boxKm2(box)>700){local.job++;Object.assign(local,{status:'toobig',box:null,net:null});return}   // long trips: too much road data for a phone
  if(local.status==='failed'&&Date.now()-local.failedAt<60000)return;
  const job=++local.job;Object.assign(local,{status:'loading',box,net:null});
  if(S.mode==='draw'&&!live.on)render();
  try{
    const ways=await ROADS.fetchRoads(box);if(job!==local.job)return;
    const net=ROADS.buildNet(ways,[(box[0]+box[2])/2,(box[1]+box[3])/2]);
    if(!net.edges)throw new Error('no roads in that area');
    Object.assign(local,{status:'ready',net,cache:new Map(),blocked:null,blockedKey:''});
  }catch(e){if(job!==local.job)return;Object.assign(local,{status:'failed',failedAt:Date.now(),box:null,net:null})}
  if(S.mode==='draw'&&!live.on)render();
}
/* Road stretches the preview must keep off (the ✕ marks). */
function localBlocked(){const key=S.zones.map(z=>z.join(',')).join(';');
  if(key!==local.blockedKey){local.blockedKey=key;local.blocked=S.zones.length?local.net.edgesNear(S.zones,ZONE_R):null;local.cache=new Map()}
  return local.blocked}

/* ---------------- Snap to roads, favouring larger ones ---------------- */
/* Where a dragged or tapped route pin lands. The nearest road of any size is always a candidate, but main roads get a
   head start measured in screen pixels (a finger is imprecise), so dropping near a main road lands on it instead
   of on the alley or car park beside it. Freeways count as main roads: dragging the line onto one means "take it".
   Ramps never get a head start. */
const SNAP_TIERS=[
  {name:'main',  head:30, reach:70, filter:{min_road_class:'primary', exclude_ramp:true}},   // freeways, highways and arterials (never their ramps)
  {name:'medium',head:18, reach:45, filter:{min_road_class:'tertiary',exclude_ramp:true}},   // collector roads and up
  {name:'any',   head:0,  reach:Infinity, filter:null},
];
const SNAP_FAR=500,SNAP_SIDE=120,SNAP_FINGER=30;         // metres to look for main roads; metres, and screen pixels, beyond the nearest that still count as "right there"                         // metres: how far to look for main roads; how much farther than the nearest still counts as "right there"
async function snapToRoad(ll,fine){
  const raw={ll,name:'',tier:'none'};
  if(DEMO)return raw;
  const mpp=metresPerPx(ll[0]),k=fine?0.55:1;                          // a mouse is more precise than a finger
  if(localCovers([ll])){const s=local.net.snap(ll,SNAP_TIERS,mpp,k);if(s)return s}   // roads already on the phone: answer at once
  const at={lat:+ll[0].toFixed(6),lon:+ll[1].toFixed(6)};
  // For the main roads, every one within reach is asked for (the two directions of a freeway are separate roads).
  const q={locations:SNAP_TIERS.map((t,i)=>t.filter?{...at,search_filter:t.filter,...(i===0?{radius:Math.round(Math.min(t.reach*k*mpp,SNAP_FAR))}:{})}:at),costing:'auto',verbose:true};
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),3000);
  try{
    const r=await fetch('https://valhalla1.openstreetmap.de/locate?json='+encodeURIComponent(JSON.stringify(q)),{signal:ctl.signal});
    if(!r.ok)return raw;
    const j=await r.json();let best=null;
    const usable=e=>e&&typeof e.distance==='number'&&typeof e.correlated_lat==='number'&&!(e.edge&&e.edge.classification&&e.edge.classification.link);
    const nameOf=e=>(e.edge_info&&e.edge_info.names&&e.edge_info.names[0])||'';
    SNAP_TIERS.forEach((t,i)=>{const list=((j[i]&&j[i].edges)||[]).filter(usable).sort((a,b)=>a.distance-b.distance),e=list[0];if(!e)return;
      const px=e.distance/mpp;if(px>t.reach*k||(t.filter&&e.distance>1500))return;
      const score=px-t.head*k;if(best&&score>=best.score)return;
      best={score,ll:[e.correlated_lat,e.correlated_lon],name:nameOf(e),tier:t.name};
      if(i===0){const seen=new Set();                                     // the other main roads right there, each once
        // one choice per road and direction: three pieces of the same carriageway must not crowd out the other direction
        best.choices=list.filter(c=>c.distance<=e.distance+Math.min(SNAP_FAR,Math.max(SNAP_SIDE,SNAP_FINGER*k*mpp))).filter(c=>{const key=nameOf(c)+'|'+(typeof c.heading==='number'?Math.round(c.heading/90)%4:c.correlated_lat.toFixed(5)+','+c.correlated_lon.toFixed(5));if(seen.has(key))return false;seen.add(key);return true})
          .slice(0,5).map(c=>({ll:[c.correlated_lat,c.correlated_lon],name:nameOf(c),d:c.distance,freeway:!!(c.edge&&c.edge.classification&&c.edge.classification.classification==='motorway')}))}});
    return best||raw;
  }catch(e){return raw}
  finally{clearTimeout(timer)}
}
/* A pin is a pull, not a stop: it says "go along this road", not "visit this exact spot". So where several roads of the
   same size lie right where the pin was dropped (above all the two directions of a freeway, or a road crossing it), the
   pin goes on the one the route flows through: the one that makes the trip from the pin before to the pin after quickest.
   Landing on the wrong side of a freeway would otherwise send the route off at the next exit and back again. */
const PULL_TIE=5,PULL_FREEWAY=600,EXIT_COST=600;         // EXIT_COST: seconds a route is marked down for each time it leaves the freeway and gets back on
const LOOP_COST=600;                                        // seconds a route is marked down for each cloverleaf loop ramp it uses
const costOf=r=>r?r.duration+EXIT_COST*(r.exits||0)+LOOP_COST*(r.loops||0):Infinity;
//                         // seconds: a choice must be this much quicker to beat a nearer one; and a freeway's head start,
                                                          // so a pin dropped where a freeway and a street run side by side stays on the freeway
/* Where a freeway is as near the drop as anything else (within a finger's width of the nearest road), the pin is meant
   for the freeway: the streets beside it drop out. Zoomed far out, a finger covers the whole interchange and the streets
   round it, and a street would otherwise win just because the freeway there is mid-turn. Aim clearly at the street
   (zoom in) and the street is nearer than the freeway by more than a finger, so it stays. */
const PULL_FINGER=30,PULL_FINGER_MIN=60;                   // screen pixels, and metres at least
function freewayFirst(s){
  const ch=s.choices,fw=ch.filter(c=>c.freeway);if(!fw.length||fw.length===ch.length)return ch;
  const near=Math.min(...ch.map(c=>c.d)),slop=Math.max(PULL_FINGER_MIN,PULL_FINGER*metresPerPx(s.ll[0]));
  return fw.some(c=>c.d<=near+slop)?fw:ch;
}
function pullLocal(prev,next,s){
  if(!s||!s.choices||s.choices.length<2||!prev||!next)return s;
  let best=null;
  for(const c of freewayFirst(s)){const r=local.net.route([prev,c.ll,next],{blocked:localBlocked()}),dur=costOf(r)-(c.freeway?PULL_FREEWAY:0);
    if(!best||dur<best.dur-PULL_TIE)best={dur,c}}
  return best&&isFinite(best.dur)?{...s,ll:best.c.ll,name:best.c.name||s.name}:s;
}
async function pullChoice(idx,s){
  const prev=S.pts[idx-1],next=S.pts[idx+1];
  if(!s||!s.choices||!prev||!next)return s;
  if(s.choices.length<2){const only=freewayFirst(s)[0];return only?{...s,ll:only.ll,name:only.name||s.name}:s}
  if(localCovers([prev,next].concat(s.choices.map(c=>c.ll))))return pullLocal(prev,next,s);
  let best=null;
  for(const c of freewayFirst(s)){let dur=Infinity;
    try{dur=costOf(await route([prev,c.ll,next]))-(c.freeway?PULL_FREEWAY:0)}catch(e){/* that choice cannot be judged: leave it out */}
    if(!best||dur<best.dur-PULL_TIE)best={dur,c}}
  return best&&isFinite(best.dur)?{...s,ll:best.c.ll,name:best.c.name||s.name}:s;
}
/* A pin must never make the route double back. In the middle of an interchange every piece of road is mid-turn: to touch a
   pin there the route overshoots, comes off and loops round. So: route through the pin; if the way out runs back alongside
   the way in, slide the pin along that route, a little before it and a little after, further each time, until the detour
   is gone. The pin stays on the roads the route was already using, so the pull is kept; only the doubling back goes. */
const SPUR_LOOK=6000,SPUR_NEAR=90,SPUR_SKIP=250,SPUR_SAVE=45;   // metres along the route to look; how close counts as alongside; ignored next to the pin; seconds a move must save
const SPUR_SLIDES=[-500,500,-1200,1200,-2500,2500,-5000,5000],SPUR_QUICK=[-1200,1200];  // metres along the route: before the pin (minus) and after it
function doublesBack(c,k){
  // c: route points; k: index of the pin. True if the route within SPUR_LOOK after the pin passes alongside its own way in.
  const cum=[0];for(let i=1;i<c.length;i++)cum.push(cum[i-1]+hav(c[i-1],c[i]));
  // A point every 40 m along the way in and the way out (a freeway's own points can be a kilometre apart).
  const along=(from,to)=>{const out=[];for(let m=from;m<=to;m+=40){const want=cum[k]+m;if(want<0||want>cum[cum.length-1])continue;
    let i=1;while(i<c.length-1&&cum[i]<want)i++;const t=(want-cum[i-1])/((cum[i]-cum[i-1])||1);out.push([c[i-1][0]+t*(c[i][0]-c[i-1][0]),c[i-1][1]+t*(c[i][1]-c[i-1][1])])}return out};
  const inPts=along(-SPUR_LOOK,-SPUR_SKIP),outPts=along(SPUR_SKIP,SPUR_LOOK);
  if(!inPts.length||!outPts.length)return null;
  const kx=111320*Math.cos(c[k][0]*Math.PI/180),ky=110540,near2=SPUR_NEAR*SPUR_NEAR;
  for(const o of outPts)for(const p of inPts){const dx=(o[1]-p[1])*kx,dy=(o[0]-p[0])*ky;if(dx*dx+dy*dy<=near2)return cum}
  return null;
}
/* How direct the route is around the pin: straight-line distance between the points `reach` metres before and after it,
   over the distance driven between them. A route that flows through is near 1 (0.7 round a right-angle turn); one that
   loops round to touch the pin is much less. */
function directness(c,cum,k,reach){
  const at=want=>{if(want<=0)return c[0];if(want>=cum[cum.length-1])return c[c.length-1];let i=1;while(i<c.length-1&&cum[i]<want)i++;
    const t=(want-cum[i-1])/((cum[i]-cum[i-1])||1);return [c[i-1][0]+t*(c[i][0]-c[i-1][0]),c[i-1][1]+t*(c[i][1]-c[i-1][1])]};
  const a=Math.max(0,cum[k]-reach),b=Math.min(cum[cum.length-1],cum[k]+reach);
  return b-a<200?1:hav(at(a),at(b))/(b-a);
}
const SPUR_BENT=0.62,SPUR_TURN=0.8,SPUR_KEEP=400,SPUR_BETTER=5;                       // below this directness the pin is suspect; a slid pin's route must still pass this close (m) to the drop
async function despur(idx,s){
  const prev=S.pts[idx-1],next=S.pts[idx+1];if(!s||!s.ll||s.tier==='none'||!prev||!next)return s;
  const through=async ll=>{const pts=[prev,ll,next];try{return localCovers(pts)?local.net.route(pts,{blocked:localBlocked()}):await route(pts)}catch(e){return null}};
  const r=await through(s.ll);if(!r||!r.coords||r.coords.length<3)return s;
  const c=r.coords;let k=0,bd=Infinity;for(let i=0;i<c.length;i++){const d=hav(c[i],s.ll);if(d<bd){bd=d;k=i}}
  const cum=[0];for(let i=1;i<c.length;i++)cum.push(cum[i-1]+hav(c[i-1],c[i]));
  // Does the route flow through the pin? If it neither doubles back nor loops round, leave the pin alone.
  // (A pin on a straight run scores about 1 and costs nothing more. Anything that turns near the pin gets checked.)
  // Even then two nearby slides are tried: a pin just past the right ramp flows on smoothly to the next exit and back.
  const flows=!r.exits&&!r.loops&&!doublesBack(c,k)&&directness(c,cum,k,1500)>=SPUR_BENT&&directness(c,cum,k,3000)>=SPUR_TURN;
  const at=m=>{const want=cum[k]+m;if(want<=0||want>=cum[cum.length-1])return null;let i=1;while(i<c.length-1&&cum[i]<want)i++;
    const t=(want-cum[i-1])/((cum[i]-cum[i-1])||1);return [c[i-1][0]+t*(c[i][0]-c[i-1][0]),c[i-1][1]+t*(c[i][1]-c[i-1][1])]};
  // The slid pin's route must still come through the place the pin was dropped (else the pull itself would be lost).
  const keep=Math.max(SPUR_KEEP,40*metresPerPx(s.ll[0]));
  const passes=rr=>{setRef(s.ll);const ix=indexLine(resample(rr.coords.map(P),30).pts,Math.max(50,keep));return distToLine(ix,P(s.ll))<=keep};
  // Every slide is tried and the quickest kept (a smaller slide wins unless a bigger one is clearly quicker): the first
  // that helps may sit on a street the detour itself used, when the freeway straight through is quicker still.
  let best=null;
  for(const m of (flows?SPUR_QUICK:SPUR_SLIDES)){const ll=at(m);if(!ll)continue;
    const rr=await through(ll);
    if(rr&&costOf(rr)<=costOf(r)-SPUR_SAVE&&passes(rr)&&(!best||costOf(rr)<best.dur-SPUR_BETTER))best={dur:costOf(rr),ll,m}}
  return best?{...s,ll:best.ll,name:'',slid:best.m}:s;
}
/* Snap route pin number idx. Returns false if the pin moved again while we were asking. */
async function snapVia(idx,fine,announce){
  const before=S.pts[idx];if(!before||before.snapped)return true;
  if(!before.asking)before.asking=snapToRoad(before,fine).then(s=>pullChoice(idx,s)).then(s=>despur(idx,s));   // a drop right after a pause shares the one request
  const s=await before.asking;
  if(S.pts[idx]===before){const ll=[s.ll[0],s.ll[1]];ll.snapped=true;S.pts[idx]=ll}
  else if(!S.pts[idx]||!S.pts[idx].snapped)return false;
  if(announce&&s.slid)toast('Pin moved along the road so your route flows straight through',2600);
  else if(announce&&s.tier!=='any'&&s.tier!=='none'&&s.name)toast('On '+s.name,1600);
  return true;
}
const finePointer=()=>!matchMedia('(pointer:coarse)').matches;

/* ---------------- Follow the finger live ---------------- */
/* While a pin is being dragged the route is re-drawn continuously: one routing request in flight at a time, and a new
   one sent as soon as it returns if the finger has moved. A road lookup runs alongside, so the preview already goes
   via the larger road the pin will snap to when you let go. */
const live={on:false,idx:-1,fine:true,snapOk:true,busy:false,dirty:false,snapBusy:false,snap:null,pt:null,lastSnap:0,raf:0,t:0,previews:0};
const liveNear=(a,b,px=14)=>!!a&&!!b&&Math.hypot(a[0]-b[0],a[1]-b[1])<px;
function liveStart(idx,fine,snapOk){
  clearTimeout(rt);S.busy++;                                           // drop any re-route already on its way
  Object.assign(live,{on:true,idx,fine,snapOk,busy:false,dirty:false,snapBusy:false,snap:null,pt:null});
  local.cache=new Map();
}
function liveMove(ll,x,y){
  if(!live.on)return;S.pts[live.idx]=ll;live.pt=[x,y];live.dirty=true;
  if(localCovers(S.pts)){                                              // roads are on the phone: redraw every frame, ask the server once the finger pauses
    if(!live.raf)live.raf=requestAnimationFrame(livePreview)}   // and no server is asked
  else{liveRoute();liveSnap()}
}
function livePreview(){
  live.raf=0;if(!live.on||!live.pt||!localCovers(S.pts))return;
  const idx=live.idx,pts=S.pts.slice();
  if(live.snapOk){const s=pullLocal(S.pts[idx-1],S.pts[idx+1],local.net.snap(S.pts[idx],SNAP_TIERS,metresPerPx(S.pts[idx][0]),live.fine?0.55:1));
    if(s){live.snap={at:live.pt.slice(),res:s};pts[idx]=s.ll}}
  const r=local.net.route(pts,{blocked:localBlocked(),cache:local.cache});
  if(r&&S.line){S.line.setLatLngs(r.coords);live.previews++}
}
async function liveRoute(){
  if(!live.on||live.busy||!live.dirty)return;
  live.busy=true;live.dirty=false;
  const idx=live.idx,pts=S.pts.slice(),at=live.pt&&live.pt.slice(),previewing=localCovers(S.pts);
  if(live.snap&&liveNear(live.snap.at,live.pt))pts[idx]=live.snap.res.ll;
  try{const r=await routeFor(pts,false);
    if(live.on&&live.idx===idx&&(!previewing||liveNear(at,live.pt,3))){S.desired=r;   // with local previews running, only a still finger gets the server's line
      if(S.line)S.line.setLatLngs(r.coords);else S.line=L.polyline(r.coords,{color:css('--drawn'),weight:7,opacity:.95,interactive:false}).addTo(map);
      const el=$('tripline');if(el)el.innerHTML=`<b>${fmtTime(r.duration)}</b> · ${fmtDist(r.distance)}${r.loops?` · ${r.loops} loop ramp${r.loops===1?'':'s'}`:''}`}}
  catch(e){/* keep the last good line; the next move tries again */}
  live.busy=false;if(live.on&&live.dirty)liveRoute();
}
async function liveSnap(){
  if(!live.on||!live.snapOk||live.snapBusy||!live.pt||localCovers(S.pts))return;
  const idx=live.idx;live.snapBusy=true;
  const wait=live.lastSnap+700-Date.now();if(wait>0)await sleep(wait);   // road lookups: at most about one a second
  if(!live.on||live.idx!==idx){live.snapBusy=false;return}
  live.lastSnap=Date.now();const at=live.pt.slice();
  const res=await snapToRoad(S.pts[idx],live.fine);
  live.snapBusy=false;if(!live.on||live.idx!==idx)return;
  if(res.tier!=='none'){live.snap={at,res};if(liveNear(at,live.pt)){live.dirty=true;liveRoute()}}
  if(!liveNear(at,live.pt))liveSnap();
}
/* Let go: the pin snaps to its road (reusing the lookup just done if the finger has not moved since) and the route is finalised. */
function liveEnd(){
  if(!live.on)return;live.on=false;clearTimeout(live.t);if(live.raf){cancelAnimationFrame(live.raf);live.raf=0}
  const idx=live.idx,cur=S.pts[idx];
  if(!live.snapOk){changed();return}
  if(cur&&live.snap&&liveNear(live.snap.at,live.pt,3))cur.asking=pullChoice(idx,live.snap.res).then(s=>despur(idx,s));   // only if the finger really was still
  drawPoints();snapVia(idx,live.fine,true).then(ok=>{if(ok)changed()});
}

/* ---------------- Drag the line ---------------- */
/* Mouse: press the line and pull. Touch: press and hold the line for a moment (so panning the map still works), then pull.
   The spot you grabbed becomes a pin the route must pass through; pins can be dragged again or removed. */
let drag=null;
const PULL_MIN=14;                                        // pixels the line must be pulled before a pin is added
function nearestVertex(ll){const c=S.desired.coords,k=Math.cos(ll[0]*Math.PI/180);let b=0,bd=Infinity;
  for(let i=0;i<c.length;i++){const d=(c[i][0]-ll[0])**2+((c[i][1]-ll[1])*k)**2;if(d<bd){bd=d;b=i}}return b}
function startLineDrag(e){
  if(drag||S.mode!=='draw'||S.tool!=='route'||!S.desired||(e.pointerType==='mouse'&&e.button!==0))return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,on:false,idx:-1,hold:0,touch:e.pointerType!=='mouse'};
  if(drag.touch)drag.hold=setTimeout(engageLineDrag,230);else e.stopPropagation();
  document.addEventListener('pointermove',moveLineDrag,{passive:false});document.addEventListener('pointerup',endLineDrag);document.addEventListener('pointercancel',endLineDrag);
}
function engageLineDrag(){
  if(!drag||drag.on||!S.desired)return;
  drag.on=true;drag.hold=0;map.dragging.disable();
  const p=map.containerPointToLatLng(map.mouseEventToContainerPoint({clientX:drag.x,clientY:drag.y})),ll=[p.lat,p.lng],v=nearestVertex(ll);
  let idx=1;for(let k=1;k<S.pts.length-1;k++)if(nearestVertex(S.pts[k])<v)idx++;
  S.pts.splice(idx,0,ll);drag.idx=idx;drawPoints();liveStart(idx,!drag.touch,true);
  if(navigator.vibrate)try{navigator.vibrate(10)}catch(err){}
}
function moveLineDrag(e){
  if(!drag||e.pointerId!==drag.id)return;
  if(!drag.on){
    if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<=8)return;
    if(drag.touch){endLineDrag(e);return}                             // finger moved before the hold: it is a map pan
    engageLineDrag();
  }
  e.preventDefault();
  const p=map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
  drag.far=Math.max(drag.far||0,Math.hypot(e.clientX-drag.x,e.clientY-drag.y));
  if(S.markers[drag.idx])S.markers[drag.idx].setLatLng(p);
  liveMove([p.lat,p.lng],e.clientX,e.clientY);
}
function endLineDrag(e){
  if(!drag||(e&&e.pointerId!==drag.id))return;
  clearTimeout(drag.hold);const was=drag.on,idx=drag.idx,pulled=(drag.far||0)>=PULL_MIN;drag=null;
  document.removeEventListener('pointermove',moveLineDrag);document.removeEventListener('pointerup',endLineDrag);document.removeEventListener('pointercancel',endLineDrag);
  map.dragging.enable();
  if(was){S.noClickUntil=Date.now()+450;
    if(pulled)liveEnd();
    else{live.on=false;if(live.raf){cancelAnimationFrame(live.raf);live.raf=0}S.pts.splice(idx,1);changed()}}   // held but never pulled: no pin
}
map.on('click',e=>{
  if(S.mode!=='draw'||Date.now()<(S.noClickUntil||0))return;$('results').hidden=true;
  const p=[e.latlng.lat,e.latlng.lng];
  if(S.tool==='avoid'){S.zones.push(p);drawZones();changed();return}
  // A tap only ever sets the start, then the destination. Once there is a route, taps do nothing: the route is changed by
  // dragging its line, which takes a deliberate press, so a stray touch while panning or zooming cannot add a pin.
  if(S.pts.length>=2)return;
  S.pts.push(p);
  if(S.pts.length===1){S.fromLabel='';S.fromQ='';changed();describeEnd('from')}
  else{S.toLabel='';S.toQ='';changed();describeEnd('to')}
});

/* ---------------- Build links ---------------- */
async function build(){
  if(!S.desired)return;
  S.mode='working';render();
  try{
    const lv=LEVELS[S.level]||LEVELS.few;
    const second=!DEMO&&lv.second?pts=>valhallaRoute(pts,false):null;        // second opinion: a different routing engine, normal driving settings
    const base={maxStops:40,maxGap:lv.maxGap,zones:S.zones,zoneR:ZONE_R,strict:S.strict||S.pts.length>2,second};
    const prog=pre=>(n,two)=>{const el=$('prog');if(el)el.textContent=two?`Double-checking with a second routing engine (${n} stop${n===1?'':'s'} so far)…`:pre+(n?`testing with ${n} stop${n>1?'s':''}…`:'testing the fastest route…')};
    // The route was shaped on the phone. What Google and Apple are asked to follow is the routing server's line through the
    // same pins (and round the same ✕ marks): it is the closest stand-in for their own choice, so it needs the fewest stops.
    let line=S.desired;
    if(S.desired.src==='phone'){
      try{line=S.zones.length?await valhallaRoute(S.pts,false,S.zones):await route(S.pts)}
      catch(e){line=S.desired}                                         // server unreachable: send the phone's line as drawn
    }
    S.sent=line;
    const res=await findStops(line.coords,base,prog('Google and Apple: '));
    const pick=res;
    pick.same=line===S.desired?1:lineMatch(S.desired.coords,line.coords);   // how much of the shaped line the sent line shares
    pick.names={o:S.fromQ,d:S.toQ};pick.level=S.level;S.result=pick;S.mode='result';showResult();render();sheet.scrollTop=0;fitRoute(line.coords);return;
  }catch(e){toast(e.message||'Something went wrong. Try again.');S.mode='draw';drawPoints()}
  render();
}
/* Share of line a that runs along line b (within TOL metres). */
function lineMatch(aLL,bLL){setRef(aLL[0]);const A=resample(aLL.map(P),15),ix=indexLine(resample(bLL.map(P),15).pts);
  let on=0;for(const p of A.pts)if(distToLine(ix,p)<=TOL)on++;return A.pts.length?on/A.pts.length:1}
function fitRoute(coords){if(!coords||coords.length<2)return;const h=sheet.offsetHeight,top=$('top').hidden?28:$('ends').getBoundingClientRect().bottom+22;
  map.fitBounds(L.latLngBounds(coords),{paddingTopLeft:[28,top],paddingBottomRight:[28,h+20],maxZoom:17})}
function clearResult(){S.resLayers.forEach(l=>map.removeLayer(l));S.resLayers=[]}
function showResult(){
  clearResult();const r=S.result;if(!r)return;
  S.markers.forEach(m=>map.removeLayer(m));S.markers=[];drawZones();
  if(S.line&&S.sent)S.line.setLatLngs(S.sent.coords);                 // show the line that is being sent
  S.resLayers.push(L.polyline(r.cand.coords,{color:css('--accent'),weight:3,dashArray:'6 7',opacity:.9}).addTo(map));
  const parts=splitParts(r.origin,r.dest,r.stops,r.names);let n=0;
  parts.forEach((p,pi)=>{p.w.forEach(w=>{n++;S.resLayers.push(L.marker(w,{icon:pinIcon('','fake'),interactive:false}).addTo(map))});
    if(pi<parts.length-1){n++;S.resLayers.push(L.marker(p.d,{icon:pinIcon('⇥','split'),interactive:false}).addTo(map))}});
  S.resLayers.push(L.marker(r.origin,{icon:pinIcon('A','start'),interactive:false}).addTo(map));
  S.resLayers.push(L.marker(r.dest,{icon:pinIcon('B','end'),interactive:false}).addTo(map));
}
async function copyText(text,btn){
  try{await navigator.clipboard.writeText(text);flash(btn,'Copied')}
  catch(e){const box=$('copybox');box.hidden=false;const inp=$('copyfield');inp.value=text;inp.focus();inp.select();flash(btn,'Select & copy below')}
}
function flash(btn,t){if(!btn)return;const o=btn.textContent;btn.textContent=t;setTimeout(()=>btn.textContent=o,1600)}
function shareLink(){
  const r=S.result;const simp=simplify((S.sent||S.desired).coords.map(P),6).map(U);
  const data={v:1,n:S.name||'',o:r.origin.map(x=>+x.toFixed(6)),d:r.dest.map(x=>+x.toFixed(6)),s:r.stops.map(s=>s.map(x=>+x.toFixed(6))),z:S.zones.map(s=>s.map(x=>+x.toFixed(5))),...(r.avoid?{aa:1}:{}),...(S.note.trim()?{t:S.note.trim().slice(0,140)}:{}),...(r.names&&r.names.o?{on:r.names.o}:{}),...(r.names&&r.names.d?{dn:r.names.d}:{}),p:encPoly(simp),m:+r.match.toFixed(3)};
  return location.href.split('#')[0]+'#r='+b64u.enc(JSON.stringify(data));
}

/* ---------------- Search ---------------- */
let qT,qWhich='to';
for(const [id,which] of [['q-from','from'],['q-to','to']]){const el=$(id);
  el.addEventListener('input',e=>{qWhich=which;clearTimeout(qT);const v=e.target.value.trim();if(v.length<2){$('results').hidden=true;return}qT=setTimeout(()=>search(v),DEMO?50:450)});
  el.addEventListener('keydown',e=>{if(e.key==='Enter'){qWhich=which;clearTimeout(qT);search(e.target.value.trim())}});
  el.addEventListener('focus',()=>{qWhich=which;el.select()});
  el.addEventListener('blur',()=>setTimeout(syncEnds,300));}
$('b-loc').onclick=useMyLocation;
function showHits(hits){const el=$('results');el.innerHTML='';
  if(!hits.length)el.innerHTML='<button disabled>No matches. Try a street or place name.</button>';
  hits.slice(0,8).forEach(h=>{const b=document.createElement('button');b.innerHTML=`${esc(h.name)}<small>${esc(h.sub||'')}</small>`;
    b.onclick=()=>{el.hidden=true;$('q-from').blur();$('q-to').blur();setEnd(qWhich,h.ll,h.name,h.q||'')};el.appendChild(b)});
  el.hidden=false}
/* Where a search should look first: near the other end of the trip if that is set (typing a destination looks near the
   start, and the other way round); else near what the map shows, if it is zoomed in to somewhere; else anywhere. */
function searchNear(){
  const other=qWhich==='to'?S.pts[0]:(S.pts.length>1?S.pts[S.pts.length-1]:S.toWait&&S.toWait.ll);
  if(other)return [other[0],other[1]];
  if(map.getZoom()>=9){const c=map.getCenter();return [c.lat,c.lng]}
  return null;
}
/* The search service returns its few "most important" matches in an area, not the nearest ones, so a wide area crowds out
   what is close. So: a tight area round that point first, a wide one only if that finds little, anywhere only if both
   find nothing. Degrees of latitude either side: about 17 km, then about 100 km. */
const SEARCH_REACH=[0.15,0.9],SEARCH_ENOUGH=4;
let searchSeq=0;
/* Photon (OpenStreetMap data): made for search as you type, forgiving of misspellings ("Culvers", "Wallgreens"), and it
   favours places near a point. Its answer in the shape placeText() reads. */
async function photonSearch(q,near){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),6000);
  try{
    const r=await fetch(`https://photon.komoot.io/api/?limit=8&lang=en&q=${encodeURIComponent(q)}`+(near?`&lat=${near[0].toFixed(5)}&lon=${near[1].toFixed(5)}&zoom=11&location_bias_scale=0.2`:''),{signal:ctl.signal});
    if(!r.ok)throw new Error('search answered '+r.status);
    const j=await r.json();
    return (j.features||[]).filter(f=>f&&f.geometry&&Array.isArray(f.geometry.coordinates)).map(f=>{const p=f.properties||{},c=f.geometry.coordinates;
      const town=p.city||p.locality||p.district||p.county||'',street=p.street?((p.housenumber?p.housenumber+' ':'')+p.street):'';
      return {name:p.name||'',category:p.osm_key||'',lat:c[1],lon:c[0],address:{house_number:p.housenumber,road:p.street,city:town,state:p.state,postcode:p.postcode},
        display_name:[p.name||street,p.name?street:'',town,p.state].filter(Boolean).join(', ')}});
  }finally{clearTimeout(timer)}
}
async function search(q){
  if(!q)return;
  if(DEMO){const v=q.toLowerCase();showHits(DEMO.places.filter(p=>(p.name+' '+(p.sub||'')).toLowerCase().includes(v)));return}
  const seq=++searchSeq,near=searchNear();
  let found=null;
  try{found=await photonSearch(q,near)}catch(e){found=null}
  if(seq!==searchSeq)return;                                            // the visitor has typed on: drop this search
  try{
    if(!found||!found.length){found=await nominatimSearch(q,near,seq);if(found===null)return}
    // Order: places whose name is what was typed come first, nearest of them on top; then the looser matches in the order
    // the search service ranked them. (Nearest-first alone put a "…Airport Road" clinic above the airport itself.)
    const plain=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,''),want=plain(q);
    const hits=found.map((p,i)=>{const parts=p.display_name.split(', '),t=placeText(p),ll=[+p.lat,+p.lon],d=near?hav(near,ll):null,nm=plain(p.name);
      return {name:t.label||parts[0],sub:(d===null?'':fmtDist(d)+' away · ')+parts.slice(1,4).join(', '),ll,q:t.q,d,i,
        exact:want.length>=3&&nm.length>=3&&(nm===want||nm.startsWith(want)||want.startsWith(nm))}});
    hits.sort((a,b)=>a.exact!==b.exact?(a.exact?-1:1):a.exact&&near?a.d-b.d:a.i-b.i);
    showHits(hits)}
  catch(e){if(seq===searchSeq)toast('Search is unavailable right now.')}
}
/* The fallback: Nominatim, which matches whole words as typed. Returns null if the visitor typed on meanwhile. */
async function nominatimSearch(q,near,seq){
  const base=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q=${encodeURIComponent(q)}`;
  const ask=async url=>{const j=await (await fetch(url)).json();return Array.isArray(j)?j:[]};
  const found=[],seen=new Set(),add=list=>{for(const p of list){const k=p.place_id||p.lat+','+p.lon;if(!seen.has(k)){seen.add(k);found.push(p)}}};
  if(near){
    let box='';
    for(const reach of SEARCH_REACH){const dLon=reach/Math.cos(near[0]*Math.PI/180);
      box=`&viewbox=${(near[1]-dLon).toFixed(4)},${(near[0]+reach).toFixed(4)},${(near[1]+dLon).toFixed(4)},${(near[0]-reach).toFixed(4)}`;
      add(await ask(base+box+'&bounded=1'));
      if(seq!==searchSeq)return null;
      if(found.length>=SEARCH_ENOUGH)break}
    if(!found.length){add(await ask(base+box));if(seq!==searchSeq)return null}
  }else{add(await ask(base));if(seq!==searchSeq)return null}
  if(near)found.sort((x,y)=>hav(near,[+x.lat,+x.lon])-hav(near,[+y.lat,+y.lon]));   // exact-word matches: nearest first
  return found;
}

/* Who makes this possible. OpenStreetMap's licence requires its credit (also on the map itself, on every screen);
   the others are free services run by volunteers and companies, credited here by name. */
const CREDITS=`<details class="opts" id="credits"><summary>About and credits</summary>
  <p class="hint">Draw My Route was <b>Alaina Salas</b>'s idea: a way to choose the roads you take, instead of the ones a maps app picks for you.</p>
  <p class="hint">Map, roads, places and addresses: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, under the Open Database Licence.</p>
  <p class="hint">Map pictures from <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">OpenStreetMap</a>. Routing by <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> and <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener">Valhalla</a> (servers run by <a href="https://www.fossgis.de/" target="_blank" rel="noopener">FOSSGIS</a>). Place search by <a href="https://photon.komoot.io/" target="_blank" rel="noopener">Photon</a> (komoot) and <a href="https://nominatim.org/" target="_blank" rel="noopener">Nominatim</a>. Road data through the <a href="https://overpass-api.de/" target="_blank" rel="noopener">Overpass API</a>. Map display by <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>.</p>
  <p class="hint">Draw My Route is not connected with Google or Apple. It only builds links that open in their maps apps.</p>
</details>`;

/* ---------------- Sheet ---------------- */
function linkBlocks(r){
  const g=splitParts(r.origin,r.dest,r.stops,r.names),here=i=>S.fromHere&&i===0,av=!!r.avoid;
  const ptitle=(i,n,p)=>n>1?`<div class="ptitle">Part ${i+1} of ${n} · ${p.w.length} stop${p.w.length===1?'':'s'} · open in</div>`:'<div class="ptitle">Open in</div>';
  return g.map((p,i)=>`<div class="part">${ptitle(i,g.length,p)}<div class="row"><a class="btn google" href="${esc(googleLink(p,here(i),av))}" target="_blank" rel="noopener">Google Maps</a><a class="btn apple" href="${esc(appleLink(p,here(i),av))}" target="_blank" rel="noopener">Apple Maps</a></div>
    <div class="row"><button class="btn small" data-copy="g${i}">Copy Google link</button><button class="btn small" data-copy="a${i}">Copy Apple link</button></div></div>`).join('')
    +(av?`<p class="hint">Both links turn on <b>Avoid highways</b> for this trip.</p>`:'');
}
function editRoute(){clearResult();S.result=null;S.mode='draw';if(S.line&&S.desired)S.line.setLatLngs(S.desired.coords);drawPoints();drawZones();render()}
function render(){
  const m=S.mode;$('top').hidden=m==='viewer'||m==='result'||m==='working';   // the From/To boxes belong to drawing: off the map otherwise
  sheet.classList.toggle('compact',m==='result'||m==='viewer');           // a shorter sheet, so the route stays in view above it
  if(m==='draw'){
    const R=S.desired,n=S.pts.length,nz=S.zones.length,av=S.tool==='avoid'&&n>=2,touch=matchMedia('(pointer:coarse)').matches;
    if(!av)S.tool='route';
    sheet.innerHTML=`<h2>${av?'Tap a road to avoid':n<2?'Where are you going?':'Shape your route'}</h2>
      <p class="sub">${av?'Tap a road you would rather not drive on and the route moves off it. Tap a ✕ to undo.'
        :n===0?'Type where you are starting from in the box above, tap the map, or use your location.':n===1?'Now set where you are going, in the box above or by tapping the map.'
        :`${touch?'Press and hold the orange line, then drag it':'Drag the orange line'} onto the roads you want. Tap a pin to remove it.`}</p>
      ${local.status==='loading'&&n>1&&!av?'<p class="hint" id="roads">Loading nearby roads so the line can follow your finger…</p>':''}
      <p class="hint" id="tripline">${S.busy?'Fitting your route to the roads…':R?`<b>${fmtTime(R.duration)}</b> · ${fmtDist(R.distance)}${R.loops?` · ${R.loops} loop ramp${R.loops===1?'':'s'}`:''}${nz?` · ${nz} road${nz===1?'':'s'} avoided`:''}`:''}</p>
      ${n===0&&!DEMO?'<div class="row"><button class="btn" id="b-here">◎ Start from my location</button></div><p class="hint">Your location is only requested if you tap that button.</p>':''}
      <div class="row"><button class="btn primary" id="b-build" ${R&&!S.busy&&S.snap?'':'disabled'}>Send to Google or Apple Maps</button></div>
      <div class="row tools"><button class="btn small ${av?'primary':''}" id="b-avoid" ${n>1?'':'disabled'}>${av?'Done marking':'✕ Avoid a road'+(nz?` (${nz})`:'')}</button><button class="btn small" id="b-rev" ${n>1?'':'disabled'}>⇅ Reverse</button><button class="btn small" id="b-clear" ${n||S.toWait?'':'disabled'}>Clear</button></div>
      ${DEMO?'<p class="hint">Demo map: Waukesha, WI and I-94. The hosted version works anywhere.</p>':''}
      ${n<2&&!DEMO?CREDITS:''}`;
    $('b-build').onclick=build;
    if($('b-here'))$('b-here').onclick=useMyLocation;
    $('b-avoid').onclick=()=>{S.tool=av?'route':'avoid';render()};
    $('b-rev').onclick=()=>{S.pts.reverse();[S.fromLabel,S.toLabel]=[S.toLabel,S.fromLabel];[S.fromQ,S.toQ]=[S.toQ,S.fromQ];changed()};
    $('b-clear').onclick=()=>{S.pts=[];S.zones=[];S.fromLabel=S.toLabel=S.fromQ=S.toQ='';S.toWait=null;S.tool='route';drawZones();changed()};
  }
  else if(m==='working'){
    sheet.innerHTML=`<h2>Finding your stops</h2><p class="sub" id="prog">Testing the fastest route…</p><p class="hint">Draw My Route checks the route Google and Apple would most likely pick, and adds a stop wherever it would leave your path.</p>`;
  }
  else if(m==='result'){
    const r=S.result,parts=splitParts(r.origin,r.dest,r.stops,r.names),pct=Math.floor(r.match*100),ns=r.stops.length,sn=`${ns} stop${ns===1?'':'s'}`;
    const good=r.avoidOnly?r.crossed===0:r.match>=0.97,nzs=r.zones===1?'road you marked':`${r.zones} roads you marked`;
    // The stops are plumbing: they are how Google and Apple are kept on the route, not something the driver cares about.
    // So the screen says the route is ready and offers the two apps; how it works is folded away under "Details".
    const stopsWords=r.avoidOnly?(ns?`${sn} keep${ns===1?'s':''} the maps apps off the ${nzs}; everywhere else they are free to pick their own roads.`:'The fastest route already stays off those roads, so the links simply go from start to destination.')
      :(ns?`${sn} keep${ns===1?'s':''} Google Maps and Apple Maps on your route: they are asked to pass through ${ns===1?'that point':'those points'} in order.`:'The fastest route already follows your route, so the links simply go from start to destination.');
    sheet.innerHTML=`<h2>Your route is ready</h2>
      ${parts.length>1?`<p class="hint">A long route: it comes in ${parts.length} parts. Open the next part when you reach the end of the one before (⇥ on the map).</p>`:''}
      ${linkBlocks(r)}
      <div class="row"><button class="btn small" id="b-edit">← Edit route</button><button class="btn small" id="b-new">New route</button></div>
      ${good?'':(r.avoidOnly?`<div class="match warn"><b>${r.crossed}</b> road${r.crossed===1?'':'s'} you marked ${r.crossed===1?'is':'are'} still on the expected drive. Go back and drag your route around ${r.crossed===1?'it':'them'}.</div>`
        :`<div class="match warn">The maps apps may not follow all of this route (about <b>${pct}%</b> expected). Go back and drag the line where the dashed line strays, or choose a firmer setting under Details.</div>`)}
      ${r.same<0.9?'<p class="hint">Between your pins, the maps apps are expected to use some different side streets from the line you shaped. The orange line shows what is being sent. Go back and add a pin on any road that matters to you.</p>':''}
      ${ns?`<p class="hint">On the way, the maps app will announce ${ns===1?'a pass-through point':ns+' pass-through points'} that keep${ns===1?'s':''} it on your route. Just keep driving; if it pauses, tap Continue or Resume.</p>`:''}
      ${DEMO?'':`<input class="field" id="f-note" maxlength="140" placeholder="Add a note for whoever gets this (optional)" aria-label="Note to include when sharing" value="${esc(S.note)}">
      <div class="row"><button class="btn primary" id="b-share">Share this route</button></div>
      <p class="hint">Anyone with the shared link can see this route, including where it starts and ends.</p>`}
      <div id="copybox" hidden><input class="field" id="copyfield" readonly aria-label="Link to copy"></div>
      <details class="opts" id="more" ${S.moreOpen?'open':''}><summary>Details and options</summary>
        ${r.names&&(r.names.o||r.names.d)?`<p class="hint">${r.names.o?`From <b>${esc(r.names.o)}</b>`:'From your pin'} to ${r.names.d?`<b>${esc(r.names.d)}</b>`:'your pin'}.</p>`:''}
        <p class="hint">${stopsWords}${good&&!r.avoidOnly?` Expected match with your route: ${pct}%.`:''}${good&&r.avoidOnly&&r.zones?` Expected to stay off ${r.zones===1?'the':'all'} ${nzs}.`:''}</p>
        <div class="legend"><span><i></i>Your route</span><span><i class="pred"></i>Expected drive in Google/Apple</span>${ns?'<span><i class="dot"></i>Pass-through point</span>':''}${r.zones?'<span><i class="x"></i>Road to avoid</span>':''}</div>
        <p class="ptitle" style="margin:10px 0 4px">How firmly to hold the route</p>
        <div class="seg" role="tablist" aria-label="How firmly to hold the route">${Object.keys(LEVELS).map(k=>`<button role="tab" data-level="${k}" aria-selected="${S.level===k}" class="${S.level===k?'on':''}">${LEVELS[k].label}</button>`).join('')}</div>
        <p class="hint">${(LEVELS[S.level]||LEVELS.few).note}${r.checked==='failed'?' The second routing engine was unavailable just now, so this was checked with one engine only.':''}</p>
        ${r.blocked?`<p class="hint">${r.blocked} ✕ ${r.blocked===1?'is':'are'} on your own route, so ${r.blocked===1?'it was':'they were'} ignored.</p>`:''}
        ${S.zones.length&&S.pts.length<=2?`<label class="toggle"><input type="checkbox" id="t-strict" ${S.strict?'checked':''}> Follow my whole drawn route exactly (more pass-through points)</label>`:''}
        <label class="toggle"><input type="checkbox" id="t-here" ${S.fromHere?'checked':''}> Start from the driver's current location (your start becomes the first pass-through point)</label>
        <p class="hint">${ns?`Pass-through points are sent as map coordinates (numbers such as ${r.stops[0][0].toFixed(4)}, ${r.stops[0][1].toFixed(4)}), never as place names, so they are easy to tell from the real destination. `:''}Apple Maps links need iOS 18.4 or later. Phone browsers without the Google Maps app only show the first 3 points.</p>
      </details>`;
    $('more').ontoggle=e=>{S.moreOpen=e.target.open;const r2=sheet.getBoundingClientRect();document.documentElement.style.setProperty('--sheet-h',r2.height+'px')};
    sheet.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const k=b.dataset.copy,i=+k.slice(1),here=S.fromHere&&i===0;copyText(k[0]==='g'?googleLink(parts[i],here,r.avoid):appleLink(parts[i],here,r.avoid),b)});
    if($('f-note'))$('f-note').oninput=e=>{S.note=e.target.value};
    if($('b-share'))$('b-share').onclick=async e=>{const link=shareLink();
      if(navigator.share){try{await navigator.share({title:'My route',text:S.note.trim()||'Open this route in Google Maps or Apple Maps',url:link});return}catch(err){if(err.name==='AbortError')return}}
      copyText(link,e.currentTarget)};
    $('t-here').onchange=e=>{S.fromHere=e.target.checked;store('wps.fromHere',S.fromHere);render()};
    sheet.querySelectorAll('[data-level]').forEach(b=>b.onclick=()=>{if(S.level===b.dataset.level)return;S.level=b.dataset.level;store('dmr.level',S.level);build()});
    if($('t-strict'))$('t-strict').onchange=e=>{S.strict=e.target.checked;build()};
    $('b-edit').onclick=editRoute;
    $('b-new').onclick=()=>{S.pts=[];S.zones=[];S.fromLabel=S.toLabel=S.fromQ=S.toQ='';S.toWait=null;S.note='';S.tool='route';editRoute();changed()};
  }
  else if(m==='viewer'){
    const v=S.viewer,parts=splitParts(v.o,v.d,v.s,{o:v.on,d:v.dn});
    sheet.innerHTML=`<h2>${esc(v.n||'Shared route')}</h2>${v.t?`<p class="note">${esc(v.t)}</p>`:''}${v.on||v.dn?`<p class="hint">${v.on?`From <b>${esc(v.on)}</b>`:'From the green pin'} to ${v.dn?`<b>${esc(v.dn)}</b>`:'the red pin'}.</p>`:''}<p class="sub">Someone drew this route for you. Open it in your maps app and it will follow the orange line.</p>
      ${linkBlocks({origin:v.o,dest:v.d,stops:v.s,avoid:!!v.aa,names:{o:v.on,d:v.dn}})}
      <label class="toggle"><input type="checkbox" id="t-here" ${S.fromHere?'checked':''}> Start from my current location</label>
      <p class="hint">${v.s.length?`On the way, the maps app will announce ${v.s.length===1?'a pass-through point':v.s.length+' pass-through points'} that keep${v.s.length===1?'s':''} it on the route. Just keep driving; if it pauses, tap Continue or Resume. `:''}Apple Maps links need iOS 18.4 or later.</p>
      <div class="row" style="margin-top:8px"><a class="btn small" href="${esc(location.href.split('#')[0])}">Draw your own route</a></div>`;
    $('t-here').onchange=e=>{S.fromHere=e.target.checked;render()};
    sheet.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const k=b.dataset.copy,i=+k.slice(1),here=S.fromHere&&i===0;
      const g=splitParts(v.o,v.d,v.s,{o:v.on,d:v.dn});copyText(k[0]==='g'?googleLink(g[i],here,!!v.aa):appleLink(g[i],here,!!v.aa),b)});
  }
  const r=sheet.getBoundingClientRect();document.documentElement.style.setProperty('--sheet-h',r.height+'px');
}

/* ---------------- Open a shared link ---------------- */
/* A share link's contents come from whoever made the link, so nothing in it is trusted: every coordinate must be a real
   one, lists and text have limits, and anything unexpected makes the whole link "damaged". Text is only ever shown escaped. */
function cleanShare(v){
  const ll=p=>Array.isArray(p)&&p.length===2&&typeof p[0]==='number'&&typeof p[1]==='number'&&isFinite(p[0])&&isFinite(p[1])&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180;
  const text=(t,max)=>typeof t==='string'?t.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  if(!v||typeof v!=='object'||!ll(v.o)||!ll(v.d))throw 0;
  const s=v.s===undefined?[]:v.s,z=v.z===undefined?[]:v.z;
  if(!Array.isArray(s)||s.length>60||!s.every(ll)||!Array.isArray(z)||z.length>60||!z.every(ll))throw 0;
  if(v.p!==undefined&&(typeof v.p!=='string'||v.p.length>20000))throw 0;
  return {o:v.o,d:v.d,s,z,p:v.p||'',aa:v.aa?1:0,n:text(v.n,60),t:text(v.t,140),on:text(v.on,200),dn:text(v.dn,200)};
}
function openViewer(){
  try{const v=cleanShare(JSON.parse(b64u.dec(location.hash.slice(3))));S.viewer=v;S.mode='viewer';S.fromHere=false;
    const path=decPoly(v.p||'');if(path.length>1)L.polyline(path,{color:css('--drawn'),weight:7}).addTo(map);
    let n=0;splitParts(v.o,v.d,v.s,{o:v.on,d:v.dn}).forEach((p,pi,arr)=>{p.w.forEach(w=>{++n;L.marker(w,{icon:pinIcon('','fake'),interactive:false}).addTo(map)});if(pi<arr.length-1)L.marker(p.d,{icon:pinIcon('⇥','split'),interactive:false}).addTo(map),n++});
    (v.z||[]).forEach(z=>{L.circle(z,{radius:40,color:css('--danger'),weight:2,fillOpacity:.22,interactive:false}).addTo(map);L.marker(z,{icon:pinIcon('✕','avoid'),interactive:false}).addTo(map)});
    L.marker(v.o,{icon:pinIcon('A','start')}).addTo(map);L.marker(v.d,{icon:pinIcon('B','end')}).addTo(map);
    render();fitRoute(path.length>1?path:[v.o,v.d]);return true}
  catch(e){toast('This share link is damaged. Ask for a new one.');return false}
}

if(!DEMO&&location.hash.startsWith('#r=')&&openViewer()){}else{render();
  if(DEMO&&DEMO.sample){S.pts=DEMO.sample.slice();S.zones=(DEMO.sampleZones||[]).slice();drawZones();S.fitNext=true;changed();}
}

/* Handle for the automated tests in tests/ (not used by the app itself). */
window.DMR={map,S,local,live,lineMatch,placeText,pullChoice,despur,LEVELS,setEnd,fitRoute,snapToRoad,route,valhallaRoute,findStops,splitParts,googleLink,appleLink,encPoly,decPoly,changed,build,shareLink};
})();
