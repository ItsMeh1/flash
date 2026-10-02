/* Flash — sandbox.js
 * This string is injected as the FIRST <script> in every proxied page.
 * It runs inside the sandboxed iframe and:
 *  - traps navigation (clicks, forms, location, history, window.open)
 *  - bridges fetch/XHR/WebSocket/EventSource/Worker back to the parent
 *    via postMessage so only the WISP socket is ever visible on the wire
 *  - spoofs cookie/storage/UA/WebRTC surface per Flash settings
 *
 * Keep it dependency-free and small; it must survive hostile pages.
 */
(function (global) {
  "use strict";

  function build(ctx) {
    const base = JSON.stringify(ctx.baseUrl);
    const tabId = JSON.stringify(ctx.tabId);
    const spoofUA = ctx.settings && ctx.settings.spoofUA;
    const customUA = JSON.stringify(((ctx.settings && (ctx.settings.pageUA || ctx.settings.customUA)) || ""));
    const featOff = global.FLASH_FEATURES && global.FLASH_FEATURES.webrtc === false;
    const blockWebRTC = !featOff && !!(ctx.settings && ctx.settings.blockWebRTC);
    const zoom = Math.min(200, Math.max(50, +ctx.zoom || 100));

    return `(function(){
"use strict";
try{if(${zoom}!==100)document.documentElement.style.zoom=${zoom}+"%";}catch(e){}
var BASE=${base}, TAB=${tabId};
var NS="FLASH";
function msg(type,data){try{parent.postMessage({__flash:1,tab:TAB,type:type,data:data||{}},"*");}catch(e){}}
window.__flashGo=function(u){try{msg("navigate",{url:String(u)});}catch(e){}};
function abs(u){try{return new URL(u,BASE).href;}catch(e){return u;}}
function isNav(u){if(!u)return false;u=String(u).trim();if(/^(data:|blob:|javascript:|mailto:|tel:|flash:)/i.test(u))return false;return true;}
// routeNav: every programmatic navigation funnels through here.
// - http(s) → parent re-loads it through the tunnel
// - about:/blob:/data: → reload the current tunneled page (never leak a raw URL)
// - anything else (mailto:, tel:) → native behavior, harmless in the sandbox
// - relative URLs resolve against the real page origin first
function routeNav(raw,nativeFn){
  var s=String(raw==null?"":raw);
  var m=/^([a-z][a-z0-9+.-]*):/i.exec(s);
  if(m){
    var scheme=m[1].toLowerCase();
    if(scheme==="http"||scheme==="https"){msg("navigate",{url:s});return;}
    if(scheme==="about"||scheme==="blob"||scheme==="data"){msg("navigate",{url:BASE});return;}
    try{if(nativeFn)nativeFn(s);}catch(e){}
    return;
  }
  var f=abs(s);
  if(isNav(f)){msg("navigate",{url:f});}
  else{try{if(nativeFn)nativeFn(s);}catch(e){}}
}
// --- click trapping (capture, before page handlers) ---
// Left click: same tab. _blank / ctrl-meta-shift-click / middle-click:
// new Flash tab (never a raw browser tab — that would hit the filter raw).
document.addEventListener("click",function(e){
  var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
  if(!a)return;
  var href=a.getAttribute("href");if(!href)return;
  if(/^(mailto:|tel:)/i.test(href))return; // let the OS handle these natively
  // hash-only nav within same page: allow natively
  try{var cur=new URL(location.href),nxt=new URL(href,BASE);if(cur.origin===nxt.origin&&cur.pathname===nxt.pathname&&cur.search===nxt.search&&nxt.hash){return;}}catch(e){}
  e.preventDefault();e.stopPropagation();
  var m=/^([a-z][a-z0-9+.-]*):/i.exec(href);
  if(m){
    var sc=m[1].toLowerCase();
    if(sc==="http"||sc==="https"){
      if(a.getAttribute("target")==="_blank"||e.ctrlKey||e.metaKey||e.shiftKey){msg("popup",{url:href});}
      else{msg("navigate",{url:href});}
      return;
    }
    if(sc==="about"||sc==="blob"||sc==="data"){msg("navigate",{url:BASE});return;}
    return;
  }
  var full=abs(href);
  if(!isNav(full))return;
  if(a.getAttribute("target")==="_blank"||e.ctrlKey||e.metaKey||e.shiftKey){msg("popup",{url:full});}
  else{msg("navigate",{url:full});}
},true);
document.addEventListener("auxclick",function(e){
  if(e.button!==1)return; // middle-click: must not open a raw tab
  var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
  if(!a)return;
  var href=a.getAttribute("href");if(!href)return;
  if(/^(mailto:|tel:)/i.test(href))return;
  e.preventDefault();e.stopPropagation();
  var m=/^([a-z][a-z0-9+.-]*):/i.exec(href);
  if(m&&(m[1].toLowerCase()==="http"||m[1].toLowerCase()==="https")){msg("popup",{url:href});return;}
  var full=abs(href);
  if(isNav(full))msg("popup",{url:full});
},true);
// --- gesture recorder: redirectors (Bing /ck/a, search beacons) rewrite the
// href on mousedown and then navigate via an untrappable location setter.
// Our capture listener runs FIRST, so we still see the pre-rewrite target.
// Never prevents default — pure observation for leak recovery.
document.addEventListener("mousedown",function(e){
  if(e.button!==0&&e.button!==1)return;
  try{
    var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(!a)return;
    var href=a.getAttribute("href");if(!href)return;
    if(/^(mailto:|tel:|javascript:)/i.test(href))return;
    var m=/^([a-z][a-z0-9+.-]*):/i.exec(href);
    var full=m?href:abs(href);
    if(isNav(full))msg("gesture",{url:full});
  }catch(err){}
},true);
// --- late-tag stripper: SPAs that inject meta refresh / base / hint links
// after load would otherwise redirect outside the tunnel. Remove on sight.
try{
  var _badTag=function(n){
    if(!n||!n.tagName)return false;
    var t=n.tagName.toLowerCase();
    if(t==="meta"){var h=(n.getAttribute("http-equiv")||"").toLowerCase();return h==="refresh"||h==="content-security-policy";}
    if(t==="base")return true;
    if(t==="link"){var r=(n.getAttribute("rel")||"").toLowerCase().trim();if(r==="preconnect"||r==="dns-prefetch"||r==="prerender"||r==="prefetch"||r==="modulepreload")return true;if(r==="preload"){var as=(n.getAttribute("as")||"").toLowerCase().trim();if(as==="font")return true;}}
    return false;
  };
  new MutationObserver(function(muts){
    for(var i=0;i<muts.length;i++){
      var nodes=muts[i].addedNodes;
      for(var j=0;j<nodes.length;j++){
        var n=nodes[j];
        if(_badTag(n)){try{n.remove();}catch(e){}continue;}
        if(n.querySelectorAll){
          var inner=n.querySelectorAll("meta[http-equiv],base,link[rel]");
          for(var k=0;k<inner.length;k++){if(_badTag(inner[k])){try{inner[k].remove();}catch(e2){}}}
        }
      }
    }
  }).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}
// --- form trapping ---
document.addEventListener("submit",function(e){
  var f=e.target;if(!f||f.tagName!=="FORM")return;
  e.preventDefault();e.stopPropagation();
  try{
    var action=f.getAttribute("action")||BASE;
    var method=(f.method||"GET").toUpperCase();
    var fd=new FormData(f);var qs=new URLSearchParams(fd).toString();
    if(method==="GET"){
      var g=abs(action);g+=(g.indexOf("?")>-1?"&":"?")+qs;
      routeNav(g,null);
    }
    else{
      var p=abs(action);
      if(!isNav(p)){msg("navigate",{url:BASE});return;}
      msg("form-post",{url:p,body:qs});
    }
  }catch(err){msg("navigate",{url:BASE});}
},true);
// --- location / history / open ---
try{
  var _assign=location.assign.bind(location),_replace=location.replace.bind(location);
  var _pa=null,_pr=null;
  try{
    _pa=Location.prototype.assign;_pr=Location.prototype.replace;
    Location.prototype.assign=function(u){var f=abs(u);if(isNav(f)){msg("navigate",{url:f});return;}return _pa.call(this,u);};
    Location.prototype.replace=function(u){var f=abs(u);if(isNav(f)){msg("navigate",{url:f});return;}return _pr.call(this,u);};
  }catch(e){}
  location.assign=function(u){var self=this;routeNav(u,function(s){_assign.call(self,s);});};
  location.replace=function(u){var self=this;routeNav(u,function(s){_replace.call(self,s);});};
}catch(e){}
try{
  var _open=window.open;
  window.open=function(u){if(u&&isNav(abs(u))){msg("popup",{url:abs(u)});return null;}return _open.apply(this,arguments);};
}catch(e){}
try{
  var _push=history.pushState,_rep=history.replaceState;
  // Same origin+path (state sync, dismissals, tracking params): apply natively,
  // no refetch — treating these as navigations is what reboots SPAs in a loop.
  function samePage(u){
    try{
      var n=new URL(String(u),BASE),b=new URL(BASE);
      return n.origin===b.origin&&n.pathname===b.pathname;
    }catch(e){return false;}
  }
  history.pushState=function(s,t,u){if(u==null)return _push.apply(this,arguments);var self=this,args=arguments;if(samePage(u)){try{_push.apply(self,args);}catch(e){}return;}routeNav(String(u),function(){_push.apply(self,args);});};
  history.replaceState=function(s,t,u){if(u==null)return _rep.apply(this,arguments);var self=this,args=arguments;if(samePage(u)){try{_rep.apply(self,args);}catch(e){}return;}routeNav(String(u),function(){_rep.apply(self,args);});};
}catch(e){}
try{
  // Native reload on a blob document would re-request a revoked URL and die.
  // Route it as a real re-proxy instead. Same-URL reloads arriving while the
  // parent is still enriching are dropped there (live enrichment fixes the page);
  // rapid repeats after that trip the parent's loop breaker instead of
  // spinning forever.
  location.reload=function(){msg("navigate",{url:BASE});};
  try{Location.prototype.reload=function(){msg("navigate",{url:BASE});};}catch(e){}
}catch(e){}
window.addEventListener("popstate",function(){msg("navigate",{url:BASE});});
// --- leaving tripwire: direct assignments (location.href = …) cannot be
// redefined, so if the frame ever starts leaving toward a real URL, report it
// and let the parent re-capture it through the tunnel. srcdoc rewrites read
// back as about:srcdoc and are ignored by the https check.
var _leaving=false;
function tripwire(){
  if(_leaving)return;
  var u=null;try{u=String(location.href);}catch(e){return;}
  if(!u||!/^https?:/i.test(u))return;
  _leaving=true;msg("leaving",{url:u});
}
window.addEventListener("beforeunload",tripwire);
window.addEventListener("pagehide",tripwire);
// --- fetch / XHR bridge (parent fetches via WISP, returns bytes) ---
var _seq=0;var _pending={};
window.addEventListener("message",function(e){
  var m=e.data;if(!m||m.__flash!==2||m.tab!==TAB)return;
  if(m.type==="inspect-start"){inspStart();return;}
  if(m.type==="inspect-stop"){inspStop();return;}
  if(m.type==="inspect-snapshot"){
    try{
      msg("dom-snapshot",{id:m.id,html:document.documentElement.outerHTML.slice(0,20000)});
    }catch(err){}
    return;
  }
  if(m.type==="text-extract"){
    try{
      var heads=[],paras=[];
      var hs=document.querySelectorAll("h1,h2,h3");
      for(var hi=0;hi<hs.length&&heads.length<12;hi++){
        var ht=(hs[hi].innerText||"").replace(/\\s+/g," ").trim();
        if(ht)heads.push({level:hs[hi].tagName.toLowerCase(),text:ht.slice(0,140)});
      }
      var ps=document.querySelectorAll("p");
      for(var pi=0;pi<ps.length&&paras.length<8;pi++){
        var pt=(ps[pi].innerText||"").replace(/\\s+/g," ").trim();
        if(pt.length>40)paras.push(pt.slice(0,220));
      }
      msg("text-result",{id:m.id,title:document.title,heads:heads,paras:paras});
    }catch(err){}
    return;
  }
  if(m.type==="find"){
    var found=false;
    try{
      var q=String(m.query||"");
      if(q) found=!!window.find(q,false,!!m.backwards,true);
    }catch(err){}
    msg("find-result",{id:m.id,found:found});
    return;
  }
  if(m.type==="zoom"){
    try{
      var lv=Math.min(200,Math.max(50,+m.level||100));
      document.documentElement.style.zoom=lv+"%";
    }catch(err){}
    return;
  }
  if(m.type==="img-patch"){
    // Live image upgrade from the parent: swap tunneled data: URLs into the
    // running page without re-parsing anything. Unmatched URLs are simply
    // absent (page moved on) — never an error.
    try{
      var items=m.items||[];
      for(var pi=0;pi<items.length;pi++){
        var it=items[pi];if(!it||!it.url||!it.data)continue;
        var sel="";
        try{sel='img[src="'+String(it.url).split('"').join('')+'"]';}catch(e){continue;}
        var els=null;try{els=document.querySelectorAll(sel);}catch(e){continue;}
        for(var qi=0;qi<els.length;qi++){
          try{els[qi].setAttribute("src",it.data);}catch(e){}
          try{els[qi].removeAttribute("srcset");}catch(e){}
        }
      }
    }catch(err){}
    return;
  }
  if(m.type==="frame-patch"){
    // Live subframe upgrade: drop the tunneled srcdoc into the running page.
    // srcdoc takes precedence over src, so the leftover URL is harmless.
    try{
      var fsel="";
      try{fsel='iframe[src="'+String(m.url).split('"').join('')+'"]';}catch(e){}
      if(!fsel)return;
      var frs=null;try{frs=document.querySelectorAll(fsel);}catch(e){return;}
      for(var fi=0;fi<frs.length;fi++){
        try{
          frs[fi].setAttribute("srcdoc",String(m.srcdoc||""));
          frs[fi].setAttribute("sandbox","allow-scripts allow-forms");
        }catch(e){}
      }
    }catch(err){}
    return;
  }
  var p=_pending[m.id];if(p){delete _pending[m.id];p(m);}
});
// --- element inspector: hover-highlight + click-capture, reported up ---
var _inspOn=false,_inspLast=null,_inspMove=null,_inspClick=null;
function inspClear(){try{if(_inspLast){_inspLast.style.outline=_inspLast.__flashOutline||"";_inspLast=null;}}catch(e){}}
function inspStop(){
  _inspOn=false;
  try{window.removeEventListener("mousemove",_inspMove,true);}catch(e){}
  try{window.removeEventListener("click",_inspClick,true);}catch(e){}
  inspClear();
}
function inspStart(){
  if(_inspOn)return;_inspOn=true;
  _inspMove=function(e){
    try{
      var el=e.target||null;
      if(!el||!el.tagName||el===document.documentElement||el===document.body){inspClear();return;}
      if(el===_inspLast)return;
      inspClear();_inspLast=el;
      el.__flashOutline=el.style.outline;
      el.style.outline="2px solid #5b8cff";
      el.style.outlineOffset="1px";
    }catch(err){}
  };
  _inspClick=function(e){
    e.preventDefault();e.stopPropagation();
    var node=null;
    try{node=describeNode(e.target);}catch(err){}
    inspStop();
    msg("inspect-result",{node:node});
  };
  window.addEventListener("mousemove",_inspMove,true);
  window.addEventListener("click",_inspClick,true);
}
function describeNode(el){
  var o={tag:"?",id:"",classes:"",attrs:[],text:"",rect:null,styles:{},path:[],html:""};
  try{
    if(!el||!el.tagName)return o;
    o.tag=el.tagName.toLowerCase();
    o.id=el.id||"";
    try{o.classes=String(el.className&&el.className.baseVal!==undefined?el.className.baseVal:(el.className||""));}catch(e){o.classes="";}
    var at=el.attributes||[];
    for(var i=0;i<at.length&&o.attrs.length<20;i++){
      try{o.attrs.push([at[i].name,String(at[i].value).slice(0,160)]);}catch(e){}
    }
    try{o.text=String(el.innerText||"").replace(/\\s+/g," ").trim().slice(0,140);}catch(e){}
    try{var r=el.getBoundingClientRect();o.rect={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}catch(e){}
    try{
      var cs=getComputedStyle(el);
      var pick=["display","position","color","background-color","font-size","font-family","font-weight","line-height","width","height","box-sizing","overflow","z-index","padding-top","padding-right","padding-bottom","padding-left","margin-top","margin-right","margin-bottom","margin-left","border-top-width","border-right-width","border-bottom-width","border-left-width"];
      for(var j=0;j<pick.length;j++){try{o.styles[pick[j]]=cs.getPropertyValue(pick[j]);}catch(e){}}
    }catch(e){}
    try{
      var p=el,n=0;var chain=[];
      while(p&&p.tagName&&n<6){chain.unshift(p.tagName.toLowerCase()+(p.id?"#"+p.id:""));p=p.parentElement;n++;}
      o.path=chain;
    }catch(e){}
    try{o.html=String(el.outerHTML||"").slice(0,2000);}catch(e){}
  }catch(e){}
  return o;
}
function parentFetch(url,opts){
  return new Promise(function(res,rej){
    var id=++_seq;_pending[id]=function(m){if(m.ok){res(m);}else{rej(new Error(m.error||"bridge failed"));}};
    msg("subfetch",{id:id,url:abs(String(url)),opts:opts||{}});
    setTimeout(function(){if(_pending[id]){delete _pending[id];rej(new Error("bridge timeout"));}},30000);
  });
}
// Serialize request bodies into postMessage-safe shapes. Returns
// {body} for strings/ArrayBuffers/URLSearchParams (and file-free FormData as
// urlencoded), or {native:1} for anything richer (File/Blob/streams) which
// falls back to a native attempt instead of corrupting the upload.
function packBody(body){
  if(body==null||body==="")return{body:null};
  try{
    if(typeof body==="string")return{body:body};
    if(typeof ArrayBuffer!=="undefined"&&body instanceof ArrayBuffer)return{body:body,bin:1};
    if(typeof ArrayBuffer!=="undefined"&&ArrayBuffer.isView&&ArrayBuffer.isView(body)){
      return{body:body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength),bin:1};
    }
    if(typeof URLSearchParams!=="undefined"&&body instanceof URLSearchParams)return{body:body.toString()};
    if(typeof FormData!=="undefined"&&body instanceof FormData){
      var entries=[];try{body.forEach(function(v,k){entries.push([k,v]);});}catch(e){return{native:1};}
      var parts=[],i,pair,hasFile=false;
      for(i=0;i<entries.length;i++){pair=entries[i];
        if((typeof File!=="undefined"&&pair[1] instanceof File)||(typeof Blob!=="undefined"&&pair[1] instanceof Blob)){hasFile=true;break;}
        parts.push(encodeURIComponent(pair[0])+"="+encodeURIComponent(pair[1]));
      }
      if(hasFile)return{native:1};
      return{body:parts.join("&"),formUrlencoded:1};
    }
  }catch(e){}
  return{native:1};
}
function decodeBytes(b){try{return new TextDecoder().decode(b);}catch(e){var s="";for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return s;}}
function bytesFromReply(m){return new Uint8Array(m.b64?atob(m.b64).split("").map(function(c){return c.charCodeAt(0);}):[]);}
try{
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    var u=typeof input==="string"?input:(input&&input.url);
    if(!u)return _fetch.apply(this,arguments);
    var full=abs(String(u));
    // Only http(s) goes through the tunnel. Anything else (about:, data:,
    // blob:) keeps native semantics — never feed the transport a bad URL.
    if(!/^https?:/i.test(full))return _fetch.apply(this,arguments);
    var opts={method:(init&&init.method)||"GET",headers:{}};
    try{if(init&&init.headers){if(init.headers.forEach){init.headers.forEach(function(v,k){opts.headers[k]=v;});}else{Object.assign(opts.headers,init.headers);}}}catch(e){}
    var packed=packBody(init&&init.body);
    if(packed.native)return _fetch.apply(this,arguments);
    opts.body=packed.body;if(packed.bin)opts.bin=1;
    if(packed.formUrlencoded){
      var hasCT=false;for(var k in opts.headers){if(String(k).toLowerCase()==="content-type"){hasCT=true;break;}}
      if(!hasCT)opts.headers["Content-Type"]="application/x-www-form-urlencoded;charset=UTF-8";
    }
    return parentFetch(full,opts).then(function(m){
      return new Response(bytesFromReply(m),{status:m.status||200,headers:m.headers||{}});
    }).catch(function(){return _fetch.apply(this,arguments);}.bind(this));
  };
}catch(e){}
try{
  // Async XHR rides the same bridge (native XHR would go direct: filtered
  // nets kill it, open nets leak the destination). Sync XHR keeps a native
  // attempt — deprecated API, best effort only.
  var _XHR=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){
    var listeners={};
    var st={readyState:0,status:0,statusText:"",response:null,responseText:"",responseHeaders:{},method:"GET",url:"",asyncX:true,headers:{},rtype:"",aborted:false,withCred:false,timeout:0,upload:null};
    st.upload={addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
    function fire(type){
      var ev={type:type,target:api};
      var h=api["on"+type];if(typeof h==="function"){try{h.call(api,ev);}catch(e){}}
      var arr=listeners[type]||[];for(var i=0;i<arr.length;i++){try{arr[i].call(api,ev);}catch(e){}}
    }
    function setState(s){st.readyState=s;fire("readystatechange");}
    function nativeFallback(body){
      try{
        var nx=new _XHR();nx.open(st.method,st.url,true);
        for(var k in st.headers){try{nx.setRequestHeader(k,st.headers[k]);}catch(e){}}
        nx.onreadystatechange=function(){
          st.readyState=nx.readyState;st.status=nx.status;st.statusText=nx.statusText;
          st.responseText=nx.responseText;try{st.response=nx.response;}catch(e){st.response=st.responseText;}
          fire("readystatechange");
          if(nx.readyState===4){fire(nx.status?"load":"error");fire("loadend");}
        };
        nx.send(body);
      }catch(e){setState(4);fire("error");fire("loadend");}
    }
    var api={
      get readyState(){return st.readyState;},
      get status(){return st.status;},
      get statusText(){return st.statusText;},
      get response(){return st.response;},
      get responseText(){return typeof st.responseText==="string"?st.responseText:"";},
      get responseURL(){return st.url;},
      get responseType(){return st.rtype;},
      set responseType(v){st.rtype=String(v||"");},
      get withCredentials(){return st.withCred;},
      set withCredentials(v){st.withCred=!!v;},
      get timeout(){return st.timeout;},
      set timeout(v){st.timeout=+v||0;},
      get upload(){return st.upload;},
      open:function(method,url,asyncX){st.method=String(method||"GET").toUpperCase();st.url=abs(String(url));st.asyncX=asyncX!==false;st.headers={};st.aborted=false;setState(1);},
      setRequestHeader:function(k,v){st.headers[String(k)]=String(v);},
      getResponseHeader:function(k){var v=st.responseHeaders[String(k).toLowerCase()];return v==null?null:String(v);},
      getAllResponseHeaders:function(){var o="";for(var k in st.responseHeaders){o+=k+": "+st.responseHeaders[k]+"\\r\\n";}return o;},
      overrideMimeType:function(){},
      abort:function(){st.aborted=true;setState(0);fire("abort");fire("loadend");},
      addEventListener:function(t,f){(listeners[t]=listeners[t]||[]).push(f);},
      removeEventListener:function(t,f){var a=listeners[t];if(a){var i=a.indexOf(f);if(i>=0)a.splice(i,1);}},
      dispatchEvent:function(){return true;},
      send:function(body){
        if(!st.asyncX){nativeFallback(body);return;}
        var packed=packBody(body);
        if(packed.native){nativeFallback(body);return;}
        var opts={method:st.method,headers:st.headers,body:packed.body};
        if(packed.bin)opts.bin=1;
        if(packed.formUrlencoded){
          var hasCT=false;for(var k in opts.headers){if(String(k).toLowerCase()==="content-type"){hasCT=true;break;}}
          if(!hasCT)opts.headers["Content-Type"]="application/x-www-form-urlencoded;charset=UTF-8";
        }
        setState(1);
        var timer=setTimeout(function(){if(st.readyState!==4){st.aborted=true;setState(4);fire("timeout");fire("loadend");}},st.timeout||30000);
        parentFetch(st.url,opts).then(function(m){
          clearTimeout(timer);if(st.aborted)return;
          var bytes=bytesFromReply(m);
          st.status=m.status||0;st.statusText="";
          st.responseHeaders={};var hh=m.headers||{};for(var k in hh){st.responseHeaders[String(k).toLowerCase()]=hh[k];}
          var rt=st.rtype;
          if(rt===""||rt==="text"){st.responseText=decodeBytes(bytes);st.response=st.responseText;}
          else if(rt==="json"){st.responseText=decodeBytes(bytes);try{st.response=JSON.parse(st.responseText);}catch(e){st.response=null;}}
          else if(rt==="arraybuffer"){st.responseText="";st.response=bytes.buffer;}
          else if(rt==="blob"){st.responseText="";try{st.response=new Blob([bytes]);}catch(e){st.response=null;}}
          else if(rt==="document"){st.responseText=decodeBytes(bytes);try{st.response=new DOMParser().parseFromString(st.responseText,"text/html");}catch(e){st.response=null;}}
          else{st.responseText=decodeBytes(bytes);st.response=st.responseText;}
          setState(2);setState(3);setState(4);
          fire(st.status?"load":"error");fire("loadend");
        }).catch(function(){clearTimeout(timer);if(st.aborted)return;setState(4);fire("error");fire("loadend");});
      }
    };
    return api;
  };
  try{window.XMLHttpRequest.prototype=_XHR.prototype;}catch(e){}
}catch(e){}
/* FEATURE:webrtc:begin */
try{if(${blockWebRTC ? "1" : "0"}){window.RTCPeerConnection=function(){throw new Error("WebRTC blocked by Flash");};window.webkitRTCPeerConnection=window.RTCPeerConnection;}}catch(e){}
/* FEATURE:webrtc:end */
// --- storage / cookie spoof (per-origin illusion) ---
try{
  var _ua=navigator.userAgent;
  var _finalUA=${spoofUA ? "(("+customUA+")||_ua)" : "_ua"};
  Object.defineProperty(navigator,"userAgent",{get:function(){return _finalUA;},configurable:true});
}catch(e){}
try{Object.defineProperty(document,"cookie",{get:function(){return "";},set:function(){},configurable:true});}catch(e){}
// --- document.write guard: legal during initial parse, but ads calling it
// after load would wipe the whole tunneled document into a blank page.
try{
  var _dw=document.write.bind(document),_dwl=document.writeln.bind(document);
  document.write=function(){if(document.readyState==="loading")return _dw.apply(this,arguments);};
  document.writeln=function(){if(document.readyState==="loading")return _dwl.apply(this,arguments);};
}catch(e){}
// --- dynamic subresource interception (runtime-injected tags) ---
// Tags added by page JS after parse (loader bundles, injected stylesheets)
// would fetch NATIVELY from the blob frame: module scripts + fonts die on
// CORS (null origin), killing app pages like DDG's SERP. A MutationObserver
// re-routes the CORS-sensitive kinds through the parent bridge:
//  - type=module scripts: fetched as text, swapped for inline copies.
//    (Classic scripts load fine natively via no-cors, so they are never
//    touched — zero double-execution risk. Module fetches always fail CORS
//    from a null origin, so replacing them is strictly an upgrade.)
//  - stylesheets: fetched as text with font files inlined as data: URLs,
//    swapped for <style>. (Native CSS would load, but its fonts wouldn't.)
// Bounded per page; any failure leaves the node for its native attempt.
var _dynCount=0;var _dynMax=40;var _dynChain=Promise.resolve();
function _dynOk(){return _dynCount<_dynMax;}
function _dynHttp(u){return new RegExp("^https?://","i").test(String(u||""));}
function _dynTextFrom(m){
  try{
    var bin=atob(m.b64||"");var bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return new TextDecoder("utf-8",{fatal:false}).decode(bytes);
  }catch(e){return "";}
}
function _dynAbs(u,base){try{return new URL(u,base).href;}catch(e){return u;}}
var _dynFontMime={woff2:"font/woff2",woff:"font/woff",ttf:"font/ttf",otf:"font/otf",eot:"application/vnd.ms-fontobject"};
function _dynInlineFonts(cssText,cssUrl){
  var jobs=[],seen={};
  var re=/url\\(\\s*["']?([^'"")]+)["']?\\s*\\)/gi,m;
  while((m=re.exec(cssText))){
    var raw=String(m[1]).trim();
    if(/^(data:|blob:|#)/i.test(raw))continue;
    var absolute=_dynAbs(raw,cssUrl);
    var bare=absolute.split("?")[0].split("#")[0];
    if(!/\\.(woff2?|ttf|otf|eot)$/i.test(bare))continue;
    if(seen[absolute])continue;seen[absolute]=1;
    jobs.push({raw:raw,url:absolute});
    if(jobs.length>=6)break;
  }
  var chain=Promise.resolve(cssText);
  jobs.forEach(function(job){
    chain=chain.then(function(css){
      return parentFetch(job.url,{method:"GET",headers:{}}).then(function(m){
        var bin=m.b64||"";
        if(!bin||bin.length>410000)return css;
        var ext=(job.url.split("?")[0].split("#")[0].split(".").pop()||"").toLowerCase();
        return css.split(job.raw).join("data:"+(_dynFontMime[ext]||"font/woff2")+";base64,"+bin);
      }).catch(function(){return css;});
    });
  });
  return chain;
}
function _dynModule(node){
  var src=node.getAttribute("src")||"";
  if(!_dynHttp(src)||node.hasAttribute("data-flash")||node.__flashDyn)return;
  var tp=String(node.getAttribute("type")||"").toLowerCase();
  if(tp.indexOf("module")===-1)return;
  node.__flashDyn=1;_dynCount++;
  var run=function(){
    if(!node.parentNode)return Promise.resolve();
    return parentFetch(src,{method:"GET",headers:{}}).then(function(m){
      if(!node.parentNode)return;
      var js=_dynTextFrom(m);
      if(!js||!js.trim())return;
      var s2=document.createElement("script");
      var at=node.attributes;
      for(var i=0;i<at.length;i++){
        var nm=String(at[i].name).toLowerCase();
        if(nm==="src")continue;
        try{s2.setAttribute(at[i].name,at[i].value);}catch(e){}
      }
      s2.setAttribute("data-flash","dyn");
      s2.textContent=js;
      try{node.parentNode.insertBefore(s2,node);}catch(e){return;}
      try{node.parentNode.removeChild(node);}catch(e){}
    }).catch(function(){});
  };
  if(node.hasAttribute("async")){run();}
  else{_dynChain=_dynChain.then(run).catch(function(){});}
}
function _dynSheet(node){
  var href=node.getAttribute("href")||"";
  var rel=String(node.getAttribute("rel")||"").toLowerCase();
  if(rel.indexOf("stylesheet")===-1||!_dynHttp(href)||node.hasAttribute("data-flash"))return;
  if(node.__flashDyn)return;node.__flashDyn=1;_dynCount++;
  _dynChain=_dynChain.then(function(){
    if(!node.parentNode)return;
    return parentFetch(href,{method:"GET",headers:{}}).then(function(m){
      var css=_dynTextFrom(m);
      if(!css||!node.parentNode)return;
      return _dynInlineFonts(css,abs(href)).then(function(css2){
        if(!node.parentNode)return;
        var st=document.createElement("style");
        st.setAttribute("data-flash","dyn");
        var media=node.getAttribute("media");
        if(media)st.setAttribute("media",media);
        st.textContent=css2;
        try{node.parentNode.insertBefore(st,node);}catch(e){return;}
        try{node.parentNode.removeChild(node);}catch(e){}
      });
    }).catch(function(){});
  }).catch(function(){});
}
function _dynNode(n){
  if(!_dynOk()||!n||!n.tagName)return;
  var t=String(n.tagName).toUpperCase();
  if(t==="SCRIPT")_dynModule(n);
  else if(t==="LINK")_dynSheet(n);
  else if(t==="STYLE")_dynStyle(n);
}
// Loader-injected <style> blocks (webpack style-loader et al): the CSS text
// is already inline, but its @font-face URLs would load natively and die on
// CORS. Rewrite just the font URLs through the bridge, in place. No execution
// ordering issues, so no chain needed — but still bounded.
function _dynStyle(node){
  if(node.hasAttribute("data-flash"))return;
  if(node.__flashDyn)return;
  var css=node.textContent||"";
  if(!css||css.indexOf("@font-face")===-1)return;
  node.__flashDyn=1;_dynCount++;
  var base=BASE;
  try{if(document.baseURI)base=document.baseURI;}catch(e){}
  _dynInlineFonts(css,base).then(function(out){
    if(out&&out!==css){try{node.textContent=out;}catch(e){}}
  }).catch(function(){});
}
var _dynObs=null;
try{
  (function _dynScan(root){
    if(!root||!root.querySelectorAll)return;
    var list=root.querySelectorAll("script[src],link[href],style");
    for(var i=0;i<list.length;i++)_dynNode(list[i]);
  })(document);
  _dynObs=new MutationObserver(function(muts){
    if(!_dynOk()){try{_dynObs.disconnect();}catch(e){}return;}
    for(var i=0;i<muts.length;i++){
      var added=muts[i].addedNodes||[];
      for(var j=0;j<added.length;j++){
        var n=added[j];
        if(!n||n.nodeType!==1)continue;
        _dynNode(n);
        if(n.querySelectorAll){
          var inner=n.querySelectorAll("script[src],link[href],style");
          for(var k=0;k<inner.length;k++)_dynNode(inner[k]);
        }
      }
    }
  });
  _dynObs.observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}
// --- inspector + title relay ---
try{
  new MutationObserver(function(){try{parent.postMessage({__flash:1,tab:TAB,type:"title",data:{title:document.title}},"*");}catch(e){}}).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}
msg("ready",{url:location.href,title:document.title});
})();`;
  }

  global.FlashRuntime = { build };
})(typeof window !== "undefined" ? window : globalThis);
