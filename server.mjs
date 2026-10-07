// DEVBOX — serveur unique, zéro dépendance (Node >= 22.13, SQLite intégré).
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const env=process.env,PORT=+env.PORT||8080,DATA=path.resolve(env.DATA_DIR||'./data'),ROOT=env.ROOT_DOMAIN||'localhost',
SUFFIX=env.PUBLIC_SUFFIX||ROOT,SCHEME=env.PUBLIC_SCHEME||'https',OWNER=(env.OWNER_EMAIL||'').toLowerCase(),GCID=env.GOOGLE_CLIENT_ID||'',PUB=path.resolve('public');
fs.mkdirSync(path.join(DATA,'sites'),{recursive:true});
const db=new DatabaseSync(path.join(DATA,'devbox.db'));
db.exec(`pragma journal_mode=wal;
create table if not exists users(id integer primary key,email text unique not null,handle text unique not null,hash text not null,role text not null default 'USER',xp integer not null default 0,streak integer not null default 0,last_day text,prem_level integer not null default 0,prem_until integer,max_sites integer not null default 1,created integer not null);
create table if not exists sessions(th text primary key,uid integer not null,exp integer not null);
create table if not exists projects(id integer primary key,uid integer not null,name text not null,slug text unique not null,files text not null,live integer not null default 0,created integer not null);
create table if not exists deploys(id integer primary key,pid integer not null,uid integer not null,version integer not null,status text not null,err text,ok integer not null default 0,created integer not null);
create table if not exists logs(did integer not null,ts integer not null,line text not null);
create index if not exists logs_d on logs(did);
create table if not exists challenges(id integer primary key,slug text unique not null,title text not null,body text not null,ah text not null,xp integer not null,uid integer not null,created integer not null);
create table if not exists parts(cid integer not null,uid integer not null,score integer not null,ts integer not null,primary key(cid,uid));
create table if not exists badges(uid integer not null,code text not null,ts integer not null,primary key(uid,code));
create table if not exists audit(ts integer not null,uid integer,action text not null,detail text);`);
const now=()=>Date.now(),q=(s,...a)=>db.prepare(s).get(...a),qa=(s,...a)=>db.prepare(s).all(...a),x=(s,...a)=>db.prepare(s).run(...a);
class E extends Error{constructor(c,m,code){super(m);this.c=c;this.code=code}}
const audit=(u,a,d)=>x('insert into audit values(?,?,?,?)',now(),u,a,String(d));
// ---- RBAC (vérifié uniquement ici, côté serveur)
const RANK=['USER','PREMIUM_USER','CONTENT_MANAGER','CHALLENGE_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN','OWNER'];
const PERMS={OWNER:['*'],SUPER_ADMIN:['users','roles','challenges','premium','deploys'],ADMIN:['users','challenges','premium','deploys'],MODERATOR:['deploys'],CONTENT_MANAGER:['challenges'],CHALLENGE_MANAGER:['challenges']};
const can=(u,p)=>{const a=PERMS[u.role]||[];return a.includes('*')||a.includes(p)};
const prem=u=>u.prem_level>0&&u.prem_until>now(),lvl=xp=>Math.floor(Math.sqrt(xp/50))+1;
const pub=u=>({id:u.id,handle:u.handle,email:u.email,role:u.role,xp:u.xp,level:lvl(u.xp),streak:u.streak,perms:PERMS[u.role]||[],premium:{active:prem(u),level:u.prem_level,until:u.prem_until,maxSites:prem(u)?u.max_sites:1}});
// ---- auth
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const hp=(pw,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+crypto.scryptSync(pw,salt,32).toString('hex');
const vp=(pw,h)=>{const[s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(hp(pw,s).split(':')[1],'hex'),Buffer.from(k,'hex'))};
const cookie=(req,k)=>(req.headers.cookie||'').split(/;\s*/).map(c=>c.split('=')).find(c=>c[0]===k)?.[1];
const userOf=req=>{const t=cookie(req,'sid');if(!t)return null;const s=q('select uid,exp from sessions where th=?',sha(t));return s&&s.exp>now()?q('select * from users where id=?',s.uid):null};
const hits=new Map();setInterval(()=>{for(const[k,v]of hits)if(v[1]<now())hits.delete(k)},6e4).unref();
const limit=(k,n,ms)=>{const t=now(),h=hits.get(k);if(!h||h[1]<t){hits.set(k,[1,t+ms]);return}if(++h[0]>n)throw new E(429,'Trop de tentatives, réessayez plus tard')};
function session(res,uid){const t=crypto.randomBytes(32).toString('hex');x('insert into sessions values(?,?,?)',sha(t),uid,now()+30*864e5);
 res.setHeader('set-cookie',`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SCHEME==='https'?'; Secure':''}`)}
function badge(uid,c){return Number(x('insert or ignore into badges values(?,?,?)',uid,c,now()).changes)>0}
function award(uid,n,why){x('update users set xp=xp+? where id=?',n,uid);audit(uid,'xp',why+':'+n)}
function touch(uid){const u=q('select last_day,streak from users where id=?',uid),t=new Date().toISOString().slice(0,10);if(u.last_day===t)return;
 const y=new Date(now()-864e5).toISOString().slice(0,10),s=u.last_day===y?u.streak+1:1;x('update users set last_day=?,streak=? where id=?',t,s,uid);if(s>=7&&badge(uid,'streak7'))award(uid,100,'streak7')}
function makeUser(email,handle,hash){email=email.toLowerCase();const role=email===OWNER&&!q("select 1 from users where role='OWNER'")?'OWNER':'USER';
 try{const r=x('insert into users(email,handle,hash,role,created) values(?,?,?,?,?)',email,handle,hash,role,now());return q('select * from users where id=?',r.lastInsertRowid)}
 catch{throw new E(409,'Email ou pseudo déjà utilisé')}}
// ---- déploiement
const RES=new Set(['app','www','api','admin','devbox','mail','static','assets','s','c','u','dev','ftp','ns1','ns2']);
const siteUrl=s=>`${SCHEME}://${s}.${SUFFIX}`;
const EXT=/\.(html|css|js|mjs|json|svg|txt|md|xml|webmanifest)$/i;
function validate(f){if(!f||typeof f!=='object'||Array.isArray(f))throw new E(400,'files doit être un objet {chemin: contenu}');const k=Object.keys(f);if(!k.length||k.length>60)throw new E(400,'Entre 1 et 60 fichiers');let n=0;
 for(const p of k){if(!/^[\w\-.\/]{1,120}$/.test(p)||p.startsWith('/')||p.split('/').some(s=>s===''||s==='.'||s==='..'))throw new E(400,'Chemin invalide : '+p);
  if(!EXT.test(p))throw new E(400,'Type non autorisé : '+p);if(typeof f[p]!=='string')throw new E(400,'Contenu texte attendu : '+p);n+=f[p].length}
 if(n>2e6)throw new E(400,'Projet trop gros (2 Mo max)');if(!('index.html' in f))throw new E(400,'index.html est requis à la racine')}
function mkslug(name){let b=name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,28);if(b.length<3)b=('projet-'+b).replace(/-+$/,'');
 let s=b;while(RES.has(s)||q('select 1 from projects where slug=?',s))s=b+'-'+crypto.randomBytes(2).toString('hex');return s}
function quota(u,pid){const n=q('select count(*) n from projects where uid=? and live>0 and id!=?',u.id,pid).n,max=prem(u)?u.max_sites:1;
 if(n>=max)throw new E(402,prem(u)?`Limite atteinte : ${max} site(s) en ligne pour votre niveau Premium.`:'Un seul site en ligne avec le compte gratuit. Premium permet d\'en publier davantage.','PREMIUM_REQUIRED')}
function activate(pid,did){db.exec('begin');try{x("update deploys set status='SUPERSEDED' where pid=? and status='LIVE'",pid);x("update deploys set status='LIVE' where id=?",did);x('update projects set live=? where id=?',did,pid);db.exec('commit')}catch(e){db.exec('rollback');throw e}}
let chain=Promise.resolve();const enqueue=f=>{chain=chain.then(f).catch(e=>console.error(e))},tick=()=>new Promise(r=>setImmediate(r)),log=(d,l)=>x('insert into logs values(?,?,?)',d,now(),l);
async function run(did,files){const d=q('select * from deploys where id=?',did),p=q('select * from projects where id=?',d.pid),st=(s,l)=>{x('update deploys set status=? where id=?',s,did);log(did,`[${s}] ${l}`)};
 try{st('BUILDING',`Écriture de ${Object.keys(files).length} fichier(s) (v${d.version})`);
  const dir=path.join(DATA,'sites',p.slug,'v'+d.version);fs.rmSync(dir,{recursive:true,force:true});
  for(const[k,v]of Object.entries(files)){const f=path.join(dir,k);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,v)}
  await tick();st('TESTING','Vérification des fichiers référencés par index.html');
  if(!files['index.html'].trim())throw new Error('index.html est vide');
  const miss=[...files['index.html'].matchAll(/(?:src|href)=["']?([^"'\s>#?]+)/g)].map(m=>m[1]).filter(r=>!r.includes(':')&&!r.startsWith('//')).map(r=>r.replace(/^(\.\/|\/)/,'')).filter(r=>r&&!(r in files)&&!(r.replace(/\/$/,'')+'/index.html' in files));
  if(miss.length)throw new Error('Fichier référencé introuvable : '+miss[0]);
  if(/localhost|127\.0\.0\.1/.test(Object.values(files).join('\n')))log(did,'[WARN] Le projet mentionne localhost/127.0.0.1 : inaccessible pour vos visiteurs');
  await tick();st('DEPLOYING','Activation de la version');activate(p.id,did);log(did,'[LIVE] '+siteUrl(p.slug));x('update deploys set ok=1 where id=?',did);
  if(q('select count(*) n from deploys where pid=? and ok=1',p.id).n===1){award(d.uid,50,'premier déploiement');badge(d.uid,'first_deploy')}touch(d.uid)}
 catch(e){x("update deploys set status='FAILED',err=? where id=?",e.message,did);log(did,'[FAILED] '+e.message)}}
// ---- API
const R=[],r=(m,p,a,f)=>R.push([m,new RegExp('^'+p.replace(/:(\w+)/g,'(?<$1>[^/]+)')+'$'),a,f]);
const own=(u,id,perm)=>{const p=q('select * from projects where id=?',id);if(!p)throw new E(404,'Projet introuvable');if(p.uid!==u.id&&!(perm&&can(u,perm)))throw new E(403,'Accès refusé');return p};
const view=p=>({id:p.id,name:p.name,slug:p.slug,live:p.live,url:p.live?siteUrl(p.slug):null,files:JSON.parse(p.files)});
const nm=s=>String(s??'').trim().toLowerCase();
r('GET','/api/config',0,()=>({root:ROOT,suffix:SUFFIX,google:GCID||null,payments:false}));
r('POST','/api/auth/register',0,({b,res,ip})=>{limit('a'+ip,20,6e5);const email=nm(b.email),h=nm(b.handle);
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw new E(400,'Email invalide');if(!/^[a-z0-9_]{3,20}$/.test(h))throw new E(400,'Pseudo : 3 à 20 caractères (a-z, 0-9, _)');
 if(String(b.password||'').length<8)throw new E(400,'Mot de passe : 8 caractères minimum');const u=makeUser(email,h,hp(b.password));session(res,u.id);touch(u.id);return{user:pub(q('select * from users where id=?',u.id))}});
r('POST','/api/auth/login',0,({b,res,ip})=>{limit('a'+ip,20,6e5);const u=q('select * from users where email=?',nm(b.email));
 if(!u||!vp(String(b.password||''),u.hash))throw new E(401,'Email ou mot de passe incorrect');session(res,u.id);touch(u.id);return{user:pub(q('select * from users where id=?',u.id))}});
r('POST','/api/auth/google',0,async({b,res,ip})=>{if(!GCID)throw new E(501,'Connexion Google non configurée (GOOGLE_CLIENT_ID manquant)');limit('a'+ip,20,6e5);
 const t=await(await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(String(b.credential||'')))).json();
 if(t.aud!==GCID||t.email_verified!=='true')throw new E(401,'Jeton Google invalide');let u=q('select * from users where email=?',t.email.toLowerCase());
 if(!u){let h=t.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,14).padEnd(3,'_');while(q('select 1 from users where handle=?',h))h=h.slice(0,14)+crypto.randomInt(1e5);u=makeUser(t.email,h,hp(crypto.randomBytes(24).toString('hex')))}
 session(res,u.id);touch(u.id);return{user:pub(u)}});
r('POST','/api/auth/logout',0,({req,res})=>{const t=cookie(req,'sid');if(t)x('delete from sessions where th=?',sha(t));res.setHeader('set-cookie','sid=; Max-Age=0; Path=/');return{ok:true}});
r('GET','/api/me',1,({u})=>({user:pub(u),badges:qa('select code from badges where uid=?',u.id).map(b=>b.code)}));
r('GET','/api/projects',1,({u})=>({projects:qa('select * from projects where uid=? order by id desc',u.id).map(view)}));
r('POST','/api/projects',1,({u,b})=>{const name=String(b.name||'').trim().slice(0,60);if(name.length<2)throw new E(400,'Nom trop court');validate(b.files);
 if(q('select count(*) n from projects where uid=?',u.id).n>=(prem(u)?100:5))throw new E(402,'Limite de projets atteinte','PREMIUM_REQUIRED');
 const id=x('insert into projects(uid,name,slug,files,created) values(?,?,?,?,?)',u.id,name,mkslug(name),JSON.stringify(b.files),now()).lastInsertRowid;return{project:view(q('select * from projects where id=?',id))}});
r('PUT','/api/projects/:id',1,({u,b,p})=>{own(u,p.id);validate(b.files);x('update projects set files=? where id=?',JSON.stringify(b.files),p.id);return{ok:true}});
r('POST','/api/projects/:id/deploy',1,({u,p})=>{const pr=own(u,p.id);limit('d'+u.id,30,36e5);quota(u,pr.id);const files=JSON.parse(pr.files);validate(files);
 const v=(q('select max(version) m from deploys where pid=?',pr.id).m||0)+1,id=Number(x("insert into deploys(pid,uid,version,status,created) values(?,?,?,'QUEUED',?)",pr.id,u.id,v,now()).lastInsertRowid);
 log(id,'[QUEUED] Déploiement v'+v+' en file');enqueue(()=>run(id,files));return{deploy:{id,version:v,status:'QUEUED'}}});
r('POST','/api/projects/:id/stop',1,({u,p})=>{const pr=own(u,p.id,'deploys');if(pr.live){x("update deploys set status='STOPPED' where id=?",pr.live);log(pr.live,'[STOPPED] Arrêté par '+u.handle)}x('update projects set live=0 where id=?',pr.id);audit(u.id,'stop',pr.slug);return{ok:true}});
r('GET','/api/projects/:id/deploys',1,({u,p})=>{own(u,p.id,'deploys');return{deploys:qa('select id,version,status,err,created from deploys where pid=? order by id desc limit 30',p.id)}});
r('GET','/api/deploys/:id/logs',1,({u,p})=>{const d=q('select * from deploys where id=?',p.id);if(!d)throw new E(404,'Introuvable');own(u,d.pid,'deploys');return{logs:qa('select ts,line from logs where did=? order by rowid',d.id)}});
r('POST','/api/deploys/:id/activate',1,({u,p})=>{const d=q('select * from deploys where id=?',p.id);if(!d)throw new E(404,'Introuvable');const pr=own(u,d.pid);
 if(!['SUPERSEDED','STOPPED','LIVE'].includes(d.status))throw new E(400,'Cette version ne peut pas être activée (statut '+d.status+')');
 if(!fs.existsSync(path.join(DATA,'sites',pr.slug,'v'+d.version)))throw new E(410,'Fichiers de cette version absents');quota(u,pr.id);activate(pr.id,d.id);log(d.id,'[LIVE] Version réactivée');return{ok:true}});
r('GET','/api/challenges',0,()=>({challenges:qa('select c.slug,c.title,c.xp,(select count(*) from parts where cid=c.id) participants from challenges c order by c.id desc')}));
r('GET','/api/challenges/:slug',0,({u,p})=>{const c=q('select id,slug,title,body,xp from challenges where slug=?',p.slug);if(!c)throw new E(404,'Challenge introuvable');
 return{challenge:{...c,id:undefined,participants:q('select count(*) n from parts where cid=?',c.id).n,done:u?!!q('select 1 from parts where cid=? and uid=?',c.id,u.id):false}}});
r('POST','/api/challenges',1,({u,b})=>{if(!can(u,'challenges'))throw new E(403,'Permission requise : challenges');const t=String(b.title||'').trim(),a=nm(b.answer),xp=Math.min(200,Math.max(5,+b.xp||20));
 if(t.length<3||!b.body||!a)throw new E(400,'Titre, énoncé et réponse attendus');let s=mkslug(t);while(q('select 1 from challenges where slug=?',s))s+='-'+crypto.randomInt(99);
 x('insert into challenges(slug,title,body,ah,xp,uid,created) values(?,?,?,?,?,?,?)',s,t,String(b.body).slice(0,4000),sha(s+':'+a),xp,u.id,now());audit(u.id,'challenge',s);return{slug:s}});
r('POST','/api/challenges/:slug/submit',1,({u,b,p})=>{limit('ch'+u.id,15,36e5);const c=q('select * from challenges where slug=?',p.slug);if(!c)throw new E(404,'Challenge introuvable');
 if(sha(c.slug+':'+nm(b.answer))!==c.ah)return{ok:false};if(q('select 1 from parts where cid=? and uid=?',c.id,u.id))return{ok:true,already:true};
 x('insert into parts values(?,?,?,?)',c.id,u.id,100,now());award(u.id,c.xp,'challenge:'+c.slug);if(badge(u.id,'first_challenge'))award(u.id,25,'badge');touch(u.id);return{ok:true,xp:c.xp}});
r('GET','/api/leaderboard',0,()=>({top:qa('select handle,xp from users order by xp desc,id limit 50').map(t=>({...t,level:lvl(t.xp)}))}));
r('GET','/api/u/:handle',0,({p})=>{const t=q('select id,handle,xp,streak,role from users where handle=?',p.handle.toLowerCase());if(!t)throw new E(404,'Profil introuvable');
 return{profile:{handle:t.handle,xp:t.xp,level:lvl(t.xp),streak:t.streak,staff:t.role!=='USER'&&t.role!=='PREMIUM_USER',badges:qa('select code from badges where uid=?',t.id).map(b=>b.code),sites:q('select count(*) n from projects where uid=? and live>0',t.id).n}}});
r('GET','/api/admin/users',1,({u})=>{if(!can(u,'users'))throw new E(403,'Permission requise : users');return{users:qa('select id,handle,email,role,xp,prem_level,prem_until,max_sites,created from users order by id desc limit 200')}});
r('POST','/api/admin/role',1,({u,b})=>{if(!can(u,'roles'))throw new E(403,'Permission requise : roles');const t=q('select * from users where id=?',+b.uid);if(!t)throw new E(404,'Utilisateur introuvable');
 if(!RANK.includes(b.role))throw new E(400,'Rôle inconnu');const me=RANK.indexOf(u.role),own=u.role==='OWNER';if(t.id===u.id)throw new E(403,'Impossible de modifier son propre rôle');
 if(!own&&(RANK.indexOf(t.role)>=me||RANK.indexOf(b.role)>=me))throw new E(403,'Vous ne pouvez gérer que des rôles inférieurs au vôtre');x('update users set role=? where id=?',b.role,t.id);audit(u.id,'role',t.handle+'→'+b.role);return{ok:true}});
r('POST','/api/admin/premium',1,({u,b})=>{if(!can(u,'premium'))throw new E(403,'Permission requise : premium');const t=q('select * from users where id=?',+b.uid);if(!t)throw new E(404,'Utilisateur introuvable');
 const level=Math.min(3,Math.max(0,+b.level||0)),until=level?Date.parse(b.until):null,ms=Math.min(50,Math.max(1,+b.maxSites||1));if(level&&!(until>now()))throw new E(400,'Date d\'expiration future requise');
 x('update users set prem_level=?,prem_until=?,max_sites=? where id=?',level,until,ms,t.id);audit(u.id,'premium',`${t.handle}:${level}:${b.until}:${ms}`);return{ok:true}});
r('POST','/api/billing/checkout',1,()=>{throw new E(501,'Paiement non configuré : aucun fournisseur de paiement n\'est relié. Premium est accordé par un administrateur.')});
// ---- HTTP
const j=(res,c,o)=>{res.writeHead(c,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(o))};
const body=req=>new Promise((ok,ko)=>{let b='',n=0;req.on('data',d=>{n+=d.length;if(n>3e6){ko(new E(413,'Corps trop volumineux (3 Mo max)'));req.destroy()}else b+=d});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch{ko(new E(400,'JSON invalide'))}})});
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.xml':'application/xml','.webmanifest':'application/manifest+json'};
const send=(res,f)=>{const t=fs.statSync(f);res.writeHead(200,{'content-type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream','content-length':t.size,'x-content-type-options':'nosniff','cache-control':'no-cache'});fs.createReadStream(f).pipe(res)};
const txt=(res,c,m)=>{res.writeHead(c,{'content-type':'text/plain; charset=utf-8'});res.end(m)};
function site(res,slug,rel){const p=q('select live from projects where slug=?',slug);if(!p)return txt(res,404,'Site introuvable');if(!p.live)return txt(res,410,'Ce site est arrêté.');
 const d=q('select version from deploys where id=?',p.live);try{rel=decodeURIComponent(rel)}catch{return txt(res,400,'URL invalide')}if(rel.endsWith('/'))rel+='index.html';
 const base=path.resolve(DATA,'sites',slug,'v'+d.version);let f=path.resolve(base,'.'+rel);if(!f.startsWith(base+path.sep))return txt(res,403,'Interdit');
 for(const c of[f,f+'.html',path.join(f,'index.html')])if(fs.existsSync(c)&&fs.statSync(c).isFile())return send(res,c);txt(res,404,'Page introuvable')}
http.createServer(async(req,res)=>{try{const host=(req.headers.host||'').split(':')[0].toLowerCase(),url=new URL(req.url,'http://x'),P=url.pathname;
 if(host.endsWith('.'+ROOT)){const s=host.slice(0,-ROOT.length-1);if(!RES.has(s)&&/^[a-z0-9-]+$/.test(s))return site(res,s,P)}
 if(P.startsWith('/s/')){const[,,s,...rest]=P.split('/');if(!rest.length){res.writeHead(301,{location:P+'/'});return res.end()}return site(res,s,'/'+rest.join('/'))}
 if(P==='/health')return txt(res,200,'ok');
 if(P.startsWith('/api/')){if(req.method!=='GET'){if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new E(403,'Origine refusée');
   if(!(req.headers['content-type']||'').includes('json'))throw new E(415,'Content-Type JSON requis')}
  for(const[m,re,auth,f]of R){const mm=m===req.method&&re.exec(P);if(!mm)continue;const u=userOf(req);if(auth&&!u)throw new E(401,'Connexion requise');
   const b=req.method==='GET'?{}:await body(req);return j(res,200,await f({req,res,u,b,p:mm.groups||{},ip:req.socket.remoteAddress}))}
  throw new E(404,'Route inconnue')}
 const spa=P==='/'||/^\/(c|u)\/[^/]+$/.test(P),file=spa?'index.html':{'/manifest.webmanifest':1,'/sw.js':1,'/icon.svg':1}[P]&&P.slice(1);
 if(!file)return txt(res,404,'Introuvable');send(res,path.join(PUB,file))}
catch(e){if(e instanceof E)return j(res,e.c,{error:e.message,code:e.code});console.error(e);j(res,500,{error:'Erreur interne'})}}).listen(PORT,()=>console.log(`DEVBOX sur :${PORT} — sites publics: ${SCHEME}://<slug>.${SUFFIX}`));
