// Dana's Chromium is kernel-restricted to this loopback proxy. DNS is resolved here and
// the validated address is pinned for each connection (including HTTPS CONNECT).
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';
// Keep families separate: Node's IPv4-mapped IPv6 subnet also matches every IPv4
// address if both families share one BlockList.
const denied4 = new BlockList();
const denied6 = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied4.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]]) denied6.addSubnet(ip,bits,'ipv6');
// Azure's platform/metadata virtual IP is publicly numbered but is not public web.
denied4.addAddress('168.63.129.16','ipv4');
async function resolvePublic(host) {
  host = host.replace(/^\[|\]$/g,'').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === 'metadata.google.internal') throw new Error('private hostname denied');
  const addresses = await lookup(host,{all:true,verbatim:true});
  if (!addresses.length || addresses.some(a=>a.family===6?denied6.check(a.address,'ipv6'):denied4.check(a.address,'ipv4'))) throw new Error('private/reserved address denied');
  return addresses.find(address=>address.family===4)||addresses[0];
}
const server = http.createServer(async (request,response)=>{
  if(request.method==='GET'&&request.url==='/health'){response.end('public-only proxy ready');return;}
  try {
    const url=new URL(request.url);
    if(url.protocol!=='http:' || (url.port && url.port!=='80')) throw new Error('only public HTTP(S) ports permitted');
    const address=await resolvePublic(url.hostname);
    const headers={...request.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const upstream=http.request({hostname:address.address,family:address.family,port:80,path:url.pathname+url.search,method:request.method,headers},r=>{response.writeHead(r.statusCode,r.headers);r.pipe(response);});
    upstream.on('error',()=>{if(!response.headersSent) response.writeHead(502);response.end('upstream connection failed');});
    upstream.setTimeout(15000,()=>upstream.destroy());request.pipe(upstream);
  } catch(error){response.writeHead(403);response.end(String(error.message));}
});
server.on('connect',async(request,client,head)=>{
  // Browsers routinely disconnect a tunnel before DNS completes; attach immediately.
  client.on('error',()=>client.destroy());
  try {
    const url=new URL('https://'+request.url);
    if(url.port && url.port!=='443') throw new Error('only public HTTP(S) ports permitted');
    const address=await resolvePublic(url.hostname);
    const upstream=net.connect({host:address.address,family:address.family,port:443});
    upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
  } catch(error){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'+error.message);}
});
server.on('clientError',(_error,socket)=>socket.destroy());
server.listen(9224,'127.0.0.1',()=>console.log('Dana public-only proxy ready'));
