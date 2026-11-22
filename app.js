/* Draw My Route
   Draw a route -> find the fewest "fake" stops that force Google Maps / Apple Maps onto it -> share links. */
(function(){
'use strict';
const DEMO = window.DMR_DEMO || null;          // embedded Waukesha map + road graph (offline demo build)
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
  let r;try{r=await fetch(url)}catch(e){throw new Error("Can't reach the routing service. Check your connection and try again.")}
  if(r.status===429){if(tries>=3)throw new Error('The routing service is busy right now. Wait a minute and try again.');await sleep(1500*(tries+1));return getJSON(url,tries+1)}
  try{return await r.json()}catch(e){throw new Error('The routing service is having trouble. Try again in a minute.')}
}
let lastCall=0;
async function osrmRoute(pts){
  const wait=lastCall+350-Date.now();if(wait>0)await sleep(wait);lastCall=Date.now();
  const s=pts.map(p=>p[1].toFixed(6)+','+p[0].toFixed(6)).join(';');
  const j=await getJSON(`https://router.project-osrm.org/route/v1/driving/${s}?overview=full&geometries=geojson&steps=true`);
  if(j.code!=='Ok')throw new Error(j.code==='NoRoute'||j.code==='NoSegment'?'No drivable route between two of your points.':(j.message||'No route found'));
  const rt=j.routes[0];
  let hwy=false;
  rt.legs.forEach(l=>l.steps.forEach(st=>(st.intersections||[]).forEach(i=>{if((i.bearings||[]).length>=3)addInter([i.location[1],i.location[0]]);if((i.classes||[]).includes('motorway'))hwy=true})));
  return {coords:rt.geometry.coordinates.map(c=>[c[1],c[0]]),distance:rt.distance,duration:rt.duration,hwy};
}

/* Hosted, avoid-highways predictions: public Valhalla router (OSRM's public server can't avoid highways). */
let lastV=0;
function dec6(s){const pts=[];let i=0,la=0,lo=0;const d=()=>{let r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&0x1f)<<sh;sh+=5}while(b>=0x20);return r&1?~(r>>1):r>>1};
  while(i<s.length){la+=d();lo+=d();pts.push([la/1e6,lo/1e6])}return pts}
async function valhallaRoute(pts){
  const wait=lastV+1100-Date.now();if(wait>0)await sleep(wait);lastV=Date.now();
  const q={locations:pts.map(p=>({lat:+p[0].toFixed(6),lon:+p[1].toFixed(6),type:'break'})),costing:'auto',costing_options:{auto:{use_highways:0}},directions_options:{units:'kilometers'}};
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
   until it follows your route the whole way. */
async function findStops(desiredLL, opts, onProgress){
  setRef(desiredLL[0]);
  const D=resample(desiredLL.map(P),10),Dix=indexLine(D.pts);
  const origin=desiredLL[0],dest=desiredLL[desiredLL.length-1];
  const stops=[];let cand,C,score=0,iter=0,hits=[];const maxIter=opts.maxStops*2+10;
  const ZR=opts.zoneR||40;
  const allZ=(opts.zones||[]).map(z=>({ll:z,p:P(z)}));
  const blocked=allZ.filter(z=>distToLine(Dix,z.p)<=ZR);          // spots on your own route can't be avoided
  const Z=allZ.filter(z=>!blocked.includes(z));
  const avoidOnly=Z.length>0&&!opts.strict;
  const evaluate=async()=>{
    cand=await route([origin,...stops.map(s=>s.ll),dest],{avoid:opts.avoid});
    C=resample(cand.coords.map(P),10);const Cix=indexLine(C.pts);
    const dOn=D.pts.map(p=>distToLine(Cix,p)<=TOL),cOn=C.pts.map(p=>distToLine(Dix,p)<=TOL);
    const frac=a=>a.filter(Boolean).length/a.length;
    score=Math.min(frac(dOn),frac(cOn));
    hits=[];C.pts.forEach((p,j)=>{for(const z of Z)if(hyp(p,z.p)<=ZR){hits.push(j);break}});
    return {dOn,cOn};
  };
  const stretches=(on,along,minLen)=>{const out=[];let i=0;while(i<on.length){if(on[i]){i++;continue}let j=i;while(j<on.length&&!on[j])j++;
    if(along[j-1]-along[i]+10>=minLen)out.push([i,j-1]);i=j}return out};
  const placeIn=(i0,i1)=>{ // candidate positions inside a stretch of YOUR route, best first
    const a0=D.along[i0],a1=D.along[i1],mid=(a0+a1)/2,len=Math.max(a1-a0,10),c=[];
    for(let i=i0;i<=i1;i++){const al=D.along[i];if(len>60&&(al-a0<18||a1-al<18))continue;
      const ll=U(D.pts[i]),di=Math.min(interDist(ll),70);c.push({i,s:di-25*Math.abs(al-mid)/len})}
    if(!c.length)c.push({i:Math.round((i0+i1)/2),s:0});
    return c.sort((x,y)=>y.s-x.s).map(x=>x.i);
  };
  const addStop=(i0,i1)=>{const cands=placeIn(i0,i1),i=cands[0];
    stops.push({i,ll:U(D.pts[i]),along:D.along[i],cands,k:0});stops.sort((a,b)=>a.along-b.along)};
  while(iter++<maxIter){
    onProgress&&onProgress(stops.length);
    const {dOn,cOn}=await evaluate();
    if(avoidOnly?hits.length===0:score>=0.995)break;
    if(stops.length>=opts.maxStops)break;
    const near=p=>{let b=0,bd=Infinity;D.pts.forEach((q,i)=>{const d=hyp(p,q);if(d<bd){bd=d;b=i}});return b};
    if(avoidOnly){
      // Only fix the place where the predicted route runs into a spot you marked.
      let j0=hits[0],j1=hits[0];while(j0>0&&!cOn[j0-1])j0--;while(j1<C.pts.length-1&&!cOn[j1+1])j1++;
      let ia=near(C.pts[Math.max(0,j0-1)]),ib=near(C.pts[Math.min(C.pts.length-1,j1+1)]);if(ia>ib)[ia,ib]=[ib,ia];
      if(D.along[ib]-D.along[ia]>40){addStop(ia,ib);continue}
    }
    const gaps=stretches(dOn,D.along,20);
    if(gaps.length&&!avoidOnly){addStop(gaps[0][0],gaps[0][1]);continue}
    // Your route is covered, but the simulated one makes an extra detour (often a U-turn around a stop).
    const det=stretches(cOn,C.along,20);if(!det.length)break;
    const [j0,j1]=det[0],pa=C.pts[Math.max(0,j0-1)],pb=C.pts[Math.min(C.pts.length-1,j1+1)];
    let ia=near(pa),ib=near(pb);if(ia>ib)[ia,ib]=[ib,ia];
    if(D.along[ib]-D.along[ia]>40){addStop(ia,ib);continue}
    // A spur: move the stop closest to it to its next-best spot, or drop it.
    let s=null,sd=Infinity;for(const st of stops){for(let j=j0;j<=j1;j++){const d=hyp(D.pts[st.i],C.pts[j]);if(d<sd){sd=d;s=st}}}
    if(!s)break;
    s.k++;if(s.k<Math.min(s.cands.length,6)){s.i=s.cands[s.k];s.ll=U(D.pts[s.i]);s.along=D.along[s.i]}else stops.splice(stops.indexOf(s),1);
  }
  // Optional safety stops: break up long stretches where Google or Apple might pick a different road than OSM routing does.
  if(opts.safety&&!avoidOnly&&score>=0.95){let added=0;
    while(stops.length<opts.maxStops&&added<4){const anchors=[0,...stops.map(s=>s.along),D.len];let gi=-1,gl=0;
      for(let i=1;i<anchors.length;i++){const g=anchors[i]-anchors[i-1];if(g>gl){gl=g;gi=i}}
      if(gl<2000)break;const m=(anchors[gi-1]+anchors[gi])/2;let i0=D.along.findIndex(a=>a>=m-250),i1=D.along.findIndex(a=>a>=m+250);if(i1<0)i1=D.pts.length-1;
      addStop(i0,i1);added++}
    if(added)await evaluate()}
  return {origin,dest,stops:stops.map(s=>s.ll),cand,score,length:D.len,avoidOnly,avoid:!!opts.avoid,zones:Z.length,blocked:blocked.length,
    crossed:Z.filter(z=>C.pts.some(p=>hyp(p,z.p)<=ZR)).length};
}

/* ---------------- Links ---------------- */
const f6=ll=>ll[0].toFixed(6)+','+ll[1].toFixed(6);
function splitParts(origin,dest,stops){const parts=[];let o=origin,i=0;
  for(;;){const rest=stops.slice(i);if(rest.length<=PART_MAX){parts.push({o,w:rest,d:dest});break}parts.push({o,w:rest.slice(0,PART_MAX),d:rest[PART_MAX]});o=rest[PART_MAX];i+=PART_MAX+1}
  return parts}
function googleLink(p,fromHere,avoid){const e=s=>encodeURIComponent(s);
  let w=p.w.slice();if(fromHere)w=[p.o,...w];
  return 'https://www.google.com/maps/dir/?api=1'+(fromHere?'':'&origin='+e(f6(p.o)))+'&destination='+e(f6(p.d))+'&travelmode=driving&dir_action=navigate'+(avoid?'&avoid=highways':'')+(w.length?'&waypoints='+w.map(x=>e(f6(x))).join('%7C'):'')}
function appleLink(p,fromHere,avoid){const e=s=>encodeURIComponent(s);
  let w=p.w.slice();if(fromHere)w=[p.o,...w];
  return 'https://maps.apple.com/directions?'+(fromHere?'':'source='+e(f6(p.o))+'&')+'destination='+e(f6(p.d))+w.map(x=>'&waypoint='+e(f6(x))).join('')+'&mode=driving'+(avoid?'&avoid=highways':'')}

/* polyline encode/decode (Google's algorithm) for share links */
function encPoly(pts){let out='',pl=0,pn=0;const enc=v=>{v=v<0?~(v<<1):v<<1;let s='';while(v>=0x20){s+=String.fromCharCode((0x20|(v&0x1f))+63);v>>=5}return s+String.fromCharCode(v+63)};
  for(const [la,lo] of pts){const a=Math.round(la*1e5),b=Math.round(lo*1e5);out+=enc(a-pl)+enc(b-pn);pl=a;pn=b}return out}
function decPoly(s){const pts=[];let i=0,la=0,lo=0;const dec=()=>{let r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&0x1f)<<sh;sh+=5}while(b>=0x20);return r&1?~(r>>1):r>>1};
  while(i<s.length){la+=dec();lo+=dec();pts.push([la/1e5,lo/1e5])}return pts}
const b64u={enc:s=>btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),dec:s=>decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/'))))};

/* ---------------- Map ---------------- */
const BOUNDS = DEMO ? L.latLngBounds([42.975,-88.285],[43.045,-88.185]) : null;
const map=L.map('map',{zoomControl:false,attributionControl:true,minZoom:DEMO?11:3}).setView([43.0117,-88.2315],14);
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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
  if(navigator.geolocation&&!location.hash.startsWith('#r='))navigator.geolocation.getCurrentPosition(p=>{if(!S.pts.length)map.setView([p.coords.latitude,p.coords.longitude],14)},()=>{},{timeout:6000});
}

/* ---------------- State ---------------- */
const S={mode:'draw',pts:[],snap:true,desired:null,markers:[],line:null,busy:0,result:null,resLayers:[],safety:load('wps.safety2',false),tool:'route',zones:[],zoneLayers:[],strict:false,fromHere:load('wps.fromHere',false),name:''};
const sheet=$('sheet');

function pinIcon(label,cls){return L.divIcon({className:'',html:`<div class="pin ${cls}">${label}</div>`,iconSize:[26,26],iconAnchor:[13,13]})}
function drawPoints(){
  S.markers.forEach(m=>map.removeLayer(m));S.markers=[];
  if(S.mode!=='draw')return;
  S.pts.forEach((p,i)=>{const last=i===S.pts.length-1&&i>0;
    const m=L.marker(p,{draggable:true,icon:pinIcon(i===0?'A':last?'B':i,i===0?'start':last?'end':'mid'),zIndexOffset:500}).addTo(map);
    m.on('dragend',e=>{const ll=e.target.getLatLng();S.pts[i]=[ll.lat,ll.lng];changed()});
    m.on('click',()=>{const div=document.createElement('div');div.className='pop';div.innerHTML=`<b>Point ${i===0?'A (start)':last?'B (end)':i}</b><button class="btn small danger">Remove point</button>`;
      div.querySelector('button').onclick=()=>{map.closePopup();S.pts.splice(i,1);changed()};m.bindPopup(div,{closeButton:false}).openPopup()});
    S.markers.push(m)});
}
const ZONE_R=40;
function drawZones(){
  S.zoneLayers.forEach(l=>map.removeLayer(l));S.zoneLayers=[];
  const editable=S.mode==='draw';
  S.zones.forEach((z,i)=>{
    S.zoneLayers.push(L.circle(z,{radius:ZONE_R,color:css('--danger'),weight:2,fillColor:css('--danger'),fillOpacity:.22,interactive:false}).addTo(map));
    const m=L.marker(z,{icon:pinIcon('✕','avoid'),interactive:editable,zIndexOffset:400}).addTo(map);
    if(editable)m.on('click',()=>{const div=document.createElement('div');div.className='pop';div.innerHTML='<b>Stay off this road</b><button class="btn small danger">Remove</button>';
      div.querySelector('button').onclick=()=>{map.closePopup();S.zones.splice(i,1);drawZones();render()};m.bindPopup(div,{closeButton:false}).openPopup()});
    S.zoneLayers.push(m)});
}
let rt;function changed(){drawPoints();clearTimeout(rt);rt=setTimeout(recompute,200);render()}
async function recompute(){
  if(S.line){map.removeLayer(S.line);S.line=null}
  if(S.pts.length<2){S.desired=null;render();return}
  const id=++S.busy;render();
  try{let r;
    if(S.snap)r=await route(S.pts);
    else{let d=0;for(let i=1;i<S.pts.length;i++)d+=hav(S.pts[i-1],S.pts[i]);r={coords:S.pts.slice(),distance:d,duration:d/13}}
    if(id!==S.busy)return;S.desired=r;
  }catch(e){if(id!==S.busy)return;S.desired=null;toast(e.message||'Could not fit your route to roads.')}
  S.busy=0;
  if(S.desired)S.line=L.polyline(S.desired.coords,{color:css('--drawn'),weight:7,opacity:.95}).addTo(map);
  render();
  if(S.fitNext&&S.desired){S.fitNext=false;fitRoute(S.desired.coords)}
}
map.on('click',e=>{
  if(S.mode!=='draw')return;$('results').hidden=true;
  const p=[e.latlng.lat,e.latlng.lng];
  if(S.tool==='avoid'){S.zones.push(p);drawZones();render();return}
  let idx=S.pts.length;
  if(S.pts.length>=2&&!$('t-end')?.checked){let best=hav(S.pts[S.pts.length-1],p);
    for(let i=0;i<S.pts.length-1;i++){const add=hav(S.pts[i],p)+hav(p,S.pts[i+1])-hav(S.pts[i],S.pts[i+1]);if(add<best){best=add;idx=i+1}}}
  S.pts.splice(idx,0,p);changed();
});

/* ---------------- Build links ---------------- */
async function build(){
  if(!S.desired)return;
  S.mode='working';render();
  try{
    const base={maxStops:40,safety:S.safety,zones:S.zones,zoneR:ZONE_R,strict:S.strict};
    const prog=pre=>n=>{const el=$('prog');if(el)el.textContent=pre+(n?`testing with ${n} stop${n>1?'s':''}…`:'testing the fastest route…')};
    const res=await findStops(S.desired.coords,base,prog('Google and Apple: '));
    const ok=r=>r.avoidOnly?r.crossed===0:r.score>=0.97;
    let pick=res;
    if(res.stops.length>0&&S.desired.hwy===false){
      try{const av=await findStops(S.desired.coords,{...base,avoid:true,safety:false,maxStops:Math.max(0,res.stops.length-1)},prog('With Avoid highways: '));
        if(ok(av)&&(av.stops.length<res.stops.length||!ok(res)))pick=av;}
      catch(e){/* keep the regular plan */}
    }
    S.result=pick;S.mode='result';showResult();render();fitRoute(S.desired.coords);return;
  }catch(e){toast(e.message||'Something went wrong. Try again.');S.mode='draw';drawPoints();if(S.desired&&!S.line)S.line=L.polyline(S.desired.coords,{color:css('--drawn'),weight:7}).addTo(map)}
  render();
}
function fitRoute(coords){if(!coords||coords.length<2)return;const h=sheet.offsetHeight;map.fitBounds(L.latLngBounds(coords),{paddingTopLeft:[28,84],paddingBottomRight:[28,h+20],maxZoom:17})}
function clearResult(){S.resLayers.forEach(l=>map.removeLayer(l));S.resLayers=[]}
function showResult(){
  clearResult();const r=S.result;if(!r)return;
  S.markers.forEach(m=>map.removeLayer(m));S.markers=[];drawZones();
  if(S.line){S.line.setStyle({opacity:.95});}
  S.resLayers.push(L.polyline(r.cand.coords,{color:css('--accent'),weight:3,dashArray:'6 7',opacity:.9}).addTo(map));
  const parts=splitParts(r.origin,r.dest,r.stops);let n=0;
  parts.forEach((p,pi)=>{p.w.forEach(w=>{n++;S.resLayers.push(L.marker(w,{icon:pinIcon(n,'fake'),interactive:false}).addTo(map))});
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
  const r=S.result;const simp=simplify(S.desired.coords.map(P),6).map(U);
  const data={v:1,n:S.name||'',o:r.origin.map(x=>+x.toFixed(6)),d:r.dest.map(x=>+x.toFixed(6)),s:r.stops.map(s=>s.map(x=>+x.toFixed(6))),z:S.zones.map(s=>s.map(x=>+x.toFixed(5))),...(r.avoid?{aa:1}:{}),p:encPoly(simp),m:+r.score.toFixed(3)};
  return location.href.split('#')[0]+'#r='+b64u.enc(JSON.stringify(data));
}

/* ---------------- Search ---------------- */
let qT;
$('q').addEventListener('input',e=>{$('qclear').hidden=!e.target.value;clearTimeout(qT);const v=e.target.value.trim();if(v.length<2){$('results').hidden=true;return}qT=setTimeout(()=>search(v),DEMO?50:450)});
$('q').addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(qT);search(e.target.value.trim())}});
$('qclear').onclick=()=>{$('q').value='';$('qclear').hidden=true;$('results').hidden=true};
let tempMarker=null;
function showHits(hits){const el=$('results');el.innerHTML='';
  if(!hits.length)el.innerHTML='<button disabled>No matches. Try a street or place name.</button>';
  hits.slice(0,8).forEach(h=>{const b=document.createElement('button');b.innerHTML=`${esc(h.name)}<small>${esc(h.sub||'')}</small>`;
    b.onclick=()=>{el.hidden=true;$('q').blur();map.setView(h.ll,16);if(tempMarker)map.removeLayer(tempMarker);
      const div=document.createElement('div');div.className='pop';div.innerHTML=`<b>${esc(h.name)}</b><button class="btn small primary">Add to my route</button>`;
      div.querySelector('button').onclick=()=>{map.removeLayer(tempMarker);tempMarker=null;if(S.mode!=='draw')editRoute();S.pts.push(h.ll);changed()};
      tempMarker=L.marker(h.ll,{icon:pinIcon('＋','split')}).addTo(map).bindPopup(div,{closeButton:false}).openPopup()};el.appendChild(b)});
  el.hidden=false}
async function search(q){
  if(!q)return;
  if(DEMO){const v=q.toLowerCase();showHits(DEMO.places.filter(p=>(p.name+' '+(p.sub||'')).toLowerCase().includes(v)));return}
  const c=map.getCenter();
  try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=8&q=${encodeURIComponent(q)}&viewbox=${c.lng-0.5},${c.lat+0.4},${c.lng+0.5},${c.lat-0.4}`);
    const j=await r.json();showHits(j.map(p=>{const parts=p.display_name.split(', ');return {name:parts[0],sub:parts.slice(1,4).join(', '),ll:[+p.lat,+p.lon]}}))}
  catch(e){toast('Search is unavailable right now.')}
}

/* ---------------- Sheet ---------------- */
function linkBlocks(r){
  const g=splitParts(r.origin,r.dest,r.stops),here=i=>S.fromHere&&i===0,av=!!r.avoid;
  const ptitle=(i,n,p)=>n>1?`<div class="ptitle">Part ${i+1} of ${n} · ${p.w.length} stop${p.w.length===1?'':'s'}</div>`:'';
  return g.map((p,i)=>`<div class="part">${ptitle(i,g.length,p)}<div class="row"><a class="btn google" href="${esc(googleLink(p,here(i),av))}" target="_blank" rel="noopener">Open in Google Maps</a><a class="btn apple" href="${esc(appleLink(p,here(i),av))}" target="_blank" rel="noopener">Open in Apple Maps</a></div>
    <div class="row"><button class="btn small" data-copy="g${i}">Copy Google link</button><button class="btn small" data-copy="a${i}">Copy Apple link</button></div></div>`).join('')
    +(av?`<p class="hint">Both links turn on <b>Avoid highways</b> for this trip, which ${r.stops.length?'saves stops':'means no stops at all'}.</p>`:'');
}
function editRoute(){clearResult();S.result=null;S.mode='draw';drawPoints();drawZones();render()}
function render(){
  const m=S.mode;$('top').hidden=m==='viewer';
  if(m==='draw'){
    const R=S.desired,n=S.pts.length;
    const nz=S.zones.length,av=S.tool==='avoid';
    sheet.innerHTML=`<h2>${av?'Mark roads to stay off':'Draw your route'}</h2>
      <div class="seg" role="tablist"><button id="tool-route" role="tab" aria-selected="${!av}" class="${av?'':'on'}">Route points</button><button id="tool-avoid" role="tab" aria-selected="${av}" class="${av?'on':''}">Stay off${nz?` (${nz})`:''}</button></div>
      <p class="sub">${av?(n<2?'Draw your route first, then come back here.':'Tap each road you want to stay off, right where Google or Apple would send you. Tap a ✕ to remove it. Fewer marks means fewer stops.')
        :n===0?'Tap the map where you want to start.':n===1?'Now tap where you want to end up.':'Tap to add a spot your route must pass through. Drag points to adjust; tap a point to remove it.'}</p>
      ${R?`<div class="stats"><div><b>${fmtDist(R.distance)}</b><span>Distance</span></div><div><b>${fmtTime(R.duration)}</b><span>Drive time</span></div><div><b>${n}</b><span>Your points</span></div></div>`:''}
      ${S.busy?'<p class="hint">Fitting your route to the roads…</p>':''}
      <div class="row"><button class="btn primary" id="b-build" ${R&&!S.busy&&S.snap?'':'disabled'}>${nz?'Make share links (fewest stops)':'Make share links'}</button></div>
      <details class="opts"><summary>Options</summary>
        <label class="toggle"><input type="checkbox" id="t-snap" ${S.snap?'checked':''}> Follow roads between my points</label>
        <label class="toggle"><input type="checkbox" id="t-end"> New points always go at the end</label>
      </details>
      <div class="row tools"><button class="btn small" id="b-undo" ${n?'':'disabled'}>↶ Undo</button><button class="btn small" id="b-rev" ${n>1?'':'disabled'}>⇅ Reverse</button><button class="btn small" id="b-clear" ${n?'':'disabled'}>Clear</button></div>
      ${DEMO?'<p class="hint">Demo map: Waukesha, WI and I-94. The hosted version works anywhere.</p>':''}`;
    $('b-build').onclick=build;
    $('tool-route').onclick=()=>{S.tool='route';render()};
    $('tool-avoid').onclick=()=>{S.tool='avoid';render();if(S.pts.length>=2&&!S.zones.length)toast('Tap a road to mark it ✕')};
    $('t-snap').onchange=e=>{S.snap=e.target.checked;recompute()};
    $('b-undo').onclick=()=>{S.pts.pop();changed()};
    $('b-rev').onclick=()=>{S.pts.reverse();changed()};
    $('b-clear').onclick=()=>{S.pts=[];changed()};
  }
  else if(m==='working'){
    sheet.innerHTML=`<h2>Finding your stops</h2><p class="sub" id="prog">Testing the fastest route…</p><p class="hint">Draw My Route checks the route Google and Apple would most likely pick, and adds a stop wherever it would leave your path.</p>`;
  }
  else if(m==='result'){
    const r=S.result,parts=splitParts(r.origin,r.dest,r.stops),pct=Math.round(r.score*100),ns=r.stops.length,sn=`${ns} stop${ns===1?'':'s'}`;
    const good=r.avoidOnly?r.crossed===0:r.score>=0.97,nzs=r.zones===1?'road you marked':`${r.zones} roads you marked`;
    sheet.innerHTML=`<h2>${r.avoidOnly?(ns?`${sn} keep${ns===1?'s':''} them off the ${nzs}`:`No stops needed`):(ns?`${sn} keep${ns===1?'s':''} them on your route`:'No stops needed')}</h2>
      <p class="sub">${r.avoidOnly?(ns?'Everywhere else, Google and Apple are free to pick their own roads.':'The fastest route already stays off those roads, so the links just go from A to B.')
        :(ns?'Google Maps and Apple Maps will route through these points in order, which keeps them on your path.':'The fastest route already follows your path, so the links just go from A to B.')}</p>
      ${r.avoidOnly?`<div class="match ${good?'good':'warn'}">${good?`<b>✓</b> Predicted to stay off ${r.zones===1?'the':'all'} ${nzs}`:`<b>${r.crossed}</b> marked spot${r.crossed===1?' is':'s are'} still on the predicted route. Draw your route around ${r.crossed===1?'it':'them'}.`}</div>`
        :`<div class="match ${good?'good':'warn'}"><b>${pct}%</b> predicted match with your route${good?'':'. Try moving one of your points onto a main road, or add a point where the dashed line strays.'}</div>`}
      <div class="legend"><span><i></i>Your drawing</span><span><i class="pred"></i>Predicted drive in Google/Apple</span>${r.zones?'<span><i class="x"></i>Stay off</span>':''}</div>
      ${r.blocked?`<p class="hint">${r.blocked} ✕ ${r.blocked===1?'is':'are'} on your own route, so ${r.blocked===1?'it was':'they were'} ignored.</p>`:''}
      ${parts.length>1?`<p class="hint" style="margin:0 0 8px">Your route needs more than ${PART_MAX} stops, so it's split into ${parts.length} parts. Open part 2 when you reach the end of part 1 (⇥).</p>`:''}
      ${linkBlocks(r)}
      ${DEMO?'':`<div class="row"><button class="btn primary" id="b-share">Share one link for both</button></div>`}
      <div id="copybox" hidden><input class="field" id="copyfield" readonly aria-label="Link to copy"></div>
      <details class="opts"><summary>Options</summary>
        ${S.zones.length?`<label class="toggle"><input type="checkbox" id="t-strict" ${S.strict?'checked':''}> Follow my whole drawn route exactly (more stops)</label>`:''}
        <label class="toggle"><input type="checkbox" id="t-here" ${S.fromHere?'checked':''}> Start from the driver's current location (your start becomes the first stop)</label>
        ${r.avoidOnly?'':`<label class="toggle"><input type="checkbox" id="t-safe" ${S.safety?'checked':''}> Add backup stops on long stretches (more reliable, more announcements)</label>`}
      </details>
      <p class="hint">${ns?`Google and Apple treat each in-between point as a stop and will announce it. Just keep driving; if the app pauses, tap Continue or Resume. `:''}Apple Maps links need iOS 18.4 or later. Phone browsers without the Google Maps app only show the first 3 stops.</p>
      <div class="row" style="margin-top:8px"><button class="btn small" id="b-edit">Edit route</button><button class="btn small" id="b-new">New route</button></div>`;
    sheet.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const k=b.dataset.copy,i=+k.slice(1),here=S.fromHere&&i===0;copyText(k[0]==='g'?googleLink(parts[i],here,r.avoid):appleLink(parts[i],here,r.avoid),b)});
    if($('b-share'))$('b-share').onclick=async e=>{const link=shareLink();
      if(navigator.share){try{await navigator.share({title:'My route',text:'Open this route in Google Maps or Apple Maps',url:link});return}catch(err){if(err.name==='AbortError')return}}
      copyText(link,e.currentTarget)};
    $('t-here').onchange=e=>{S.fromHere=e.target.checked;store('wps.fromHere',S.fromHere);render()};
    if($('t-safe'))$('t-safe').onchange=e=>{S.safety=e.target.checked;store('wps.safety2',S.safety);build()};
    if($('t-strict'))$('t-strict').onchange=e=>{S.strict=e.target.checked;build()};
    $('b-edit').onclick=editRoute;
    $('b-new').onclick=()=>{S.pts=[];S.zones=[];S.tool='route';editRoute();changed()};
  }
  else if(m==='viewer'){
    const v=S.viewer,parts=splitParts(v.o,v.d,v.s);
    sheet.innerHTML=`<h2>${esc(v.n||'Shared route')}</h2><p class="sub">Someone drew this route for you. Open it in your maps app and it will follow the orange line${v.s.length?` using ${v.s.length} in-between stop${v.s.length>1?'s':''}`:''}.</p>
      ${linkBlocks({origin:v.o,dest:v.d,stops:v.s,avoid:!!v.aa})}
      <label class="toggle"><input type="checkbox" id="t-here" ${S.fromHere?'checked':''}> Start from my current location</label>
      <p class="hint">${v.s.length?'The app will announce each in-between stop. Just keep driving; if it pauses, tap Continue or Resume. ':''}Apple Maps links need iOS 18.4 or later.</p>
      <div class="row" style="margin-top:8px"><a class="btn small" href="${esc(location.href.split('#')[0])}">Draw your own route</a></div>`;
    $('t-here').onchange=e=>{S.fromHere=e.target.checked;render()};
    sheet.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const k=b.dataset.copy,i=+k.slice(1),here=S.fromHere&&i===0;
      const g=splitParts(v.o,v.d,v.s);copyText(k[0]==='g'?googleLink(g[i],here,!!v.aa):appleLink(g[i],here,!!v.aa),b)});
  }
  const r=sheet.getBoundingClientRect();document.documentElement.style.setProperty('--sheet-h',r.height+'px');
}

/* ---------------- Open a shared link ---------------- */
function openViewer(){
  try{const v=JSON.parse(b64u.dec(location.hash.slice(3)));if(!v.o||!v.d)throw 0;S.viewer=v;S.mode='viewer';S.fromHere=false;
    const path=decPoly(v.p||'');if(path.length>1)L.polyline(path,{color:css('--drawn'),weight:7}).addTo(map);
    let n=0;splitParts(v.o,v.d,v.s).forEach((p,pi,arr)=>{p.w.forEach(w=>L.marker(w,{icon:pinIcon(++n,'fake'),interactive:false}).addTo(map));if(pi<arr.length-1)L.marker(p.d,{icon:pinIcon('⇥','split'),interactive:false}).addTo(map),n++});
    (v.z||[]).forEach(z=>{L.circle(z,{radius:40,color:css('--danger'),weight:2,fillOpacity:.22,interactive:false}).addTo(map);L.marker(z,{icon:pinIcon('✕','avoid'),interactive:false}).addTo(map)});
    L.marker(v.o,{icon:pinIcon('A','start')}).addTo(map);L.marker(v.d,{icon:pinIcon('B','end')}).addTo(map);
    render();fitRoute(path.length>1?path:[v.o,v.d]);return true}
  catch(e){toast('This share link is damaged. Ask for a new one.');return false}
}

if(!DEMO&&location.hash.startsWith('#r=')&&openViewer()){}else{render();
  if(DEMO&&DEMO.sample){S.pts=DEMO.sample.slice();S.zones=(DEMO.sampleZones||[]).slice();drawZones();S.fitNext=true;changed();}
}

/* Handle for the automated tests in tests/ (not used by the app itself). */
window.DMR={map,S,route,findStops,splitParts,googleLink,appleLink,encPoly,decPoly,changed,build,shareLink};
})();
