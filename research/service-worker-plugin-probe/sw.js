const boot=crypto.randomUUID();
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>e.waitUntil((async()=>{try{
 const cache=await caches.open('plugins');
 if(e.data.op==='install'){ const r=await fetch('/plugin.js'); await cache.put('/installed-plugin',r); }
 if(e.data.op==='esm') { await import('/esm.js'); }
 if(e.data.op==='late') { importScripts('/late.js'); }
 const stored=await cache.match('/installed-plugin');
 const plugin=new Function(await stored.text())();
 e.ports[0].postMessage({ok:true,boot,name:plugin.name,result:await plugin.execute(41)});
}catch(err){e.ports[0].postMessage({ok:false,boot,error:err.name+': '+err.message})}})()));