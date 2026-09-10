// ── API das contas do Edifício Castanheiras ──────────────────────────────────
// Serviço próprio, deliberadamente separado do ecossistema CDV: os dados aqui
// são pessoais de moradores (nome, apartamento, quem pagou e quem deve). O
// token do GitHub deste serviço enxerga um único repositório privado, e nada
// mais — nem o TSP, nem o painel CDV.
//
// A página (davileles.github.io/castanheiras) é estática e pública, então não
// pode carregar segredo nenhum: o acesso é por e-mail e só o servidor fala com
// a API do GitHub.
const express = require('express');
const cors = require('cors');
const inter = require('./inter');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO || 'davileles/castanheiras-dados';
const DADOS_PATH   = process.env.DADOS_PATH || 'dados.json';
const BRANCH       = process.env.GITHUB_BRANCH || 'main';

const BASE = {
  moradores: [],
  categorias: [],
  regras: [],
  lancamentos: [],
  // Pagamentos feitos do bolso de alguém que o condomínio precisa devolver.
  // Ficam fora de `lancamentos` de propósito: as contas são regime de caixa, e
  // a despesa só existe quando o dinheiro sai da conta.
  reembolsos: [],
  saldoInicial: {},
  acessos: [],
  // Subconjunto de `acessos` que enxerga tudo. Vazio = arquivo anterior a esta
  // separação, e aí todo mundo que tem acesso é administrador (ninguém fica
  // trancado do lado de fora na migração).
  admins: [],
  atualizadoEm: null
};

// ── GitHub ───────────────────────────────────────────────────────────────────
function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store'
  };
}
const ghUrl = () => `https://api.github.com/repos/${GITHUB_REPO}/contents/${DADOS_PATH}`;

async function ghGet() {
  const r = await fetch(`${ghUrl()}?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders() });
  if (r.status === 404) return { data: null, sha: null };
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || `GitHub respondeu ${r.status}`);
  if (!j.content) return { data: null, sha: j.sha || null };
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}

async function ghPut(dados, sha, mensagem) {
  const body = {
    message: mensagem,
    content: Buffer.from(JSON.stringify(dados, null, 1)).toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Falha ao gravar (${r.status})`);
  return j;
}

// ── Acesso ───────────────────────────────────────────────────────────────────
const email_ = (e) => String(e || '').trim().toLowerCase();

async function carregar() {
  const { data, sha } = await ghGet();
  return { dados: { ...BASE, ...(data || {}) }, sha };
}

// As duas listas aceitam string solta ou { email } — arquivos antigos gravavam
// só o endereço.
const acessosDe = (d) => (d.acessos || []).map(a => email_(typeof a === 'string' ? a : a && a.email)).filter(Boolean);
const adminsDe  = (d) => (d.admins  || []).map(a => email_(typeof a === 'string' ? a : a && a.email)).filter(Boolean);
const autorizado = (d, e) => !!email_(e) && acessosDe(d).includes(email_(e));
function ehAdmin(d, e) {
  const alvo = email_(e);
  if (!autorizado(d, alvo)) return false;
  const admins = adminsDe(d);
  return admins.length ? admins.includes(alvo) : true;
}

// A lista de e-mails nunca vai para o navegador nem volta dele: é gerida pelos
// endpoints /acessos, para um cliente desatualizado não apagá-la.
function semAcessos(d) {
  const c = { ...d };
  delete c.acessos; delete c.admins;
  return c;
}

// Versão das contas para quem NÃO é administrador. A página é estática e
// pública: esconder coluna no navegador não esconde nada de quem abre o
// DevTools, então o que identifica apartamento não pode sair daqui. Os totais
// sobrevivem — gráfico, demonstrativo e saldo continuam corretos —, só a
// autoria some.
function redigir(d) {
  const out = { ...d };
  out.moradores = [];
  out.lancamentos = (d.lancamentos || []).map(l => {
    if (/receita/.test(l.tipo || '')) return { ...l, destino: '', descricao: 'Cota condominial', obs: '' };
    if (l.origem === 'reembolso') return { ...l, descricao: 'Restituição de pagamento feito por fora' };
    return l;
  });
  out.reembolsos = (d.reembolsos || []).map(r => {
    const c = { ...r };
    delete c.apto; delete c.pessoa; delete c.criadoPor;
    return c;
  });
  return out;
}

// ── Rotas ────────────────────────────────────────────────────────────────────
const rotas = express.Router();

rotas.get('/login', async (req, res) => {
  const email = email_(req.query.email);
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const { dados } = await carregar();
    if (!autorizado(dados, email)) return res.json({ ok: false, acesso: false, motivo: 'nao_autorizado' });
    res.json({ ok: true, acesso: true, email, admin: ehAdmin(dados, email) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.get('/dados', async (req, res) => {
  const email = email_(req.query.email);
  try {
    const { dados } = await carregar();
    if (!autorizado(dados, email)) return res.status(403).json({ ok: false, erro: 'E-mail sem acesso às contas do condomínio' });
    const admin = ehAdmin(dados, email);
    res.json({ ok: true, admin, dados: semAcessos(admin ? dados : redigir(dados)) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.post('/dados', async (req, res) => {
  const email = email_(req.body && req.body.email);
  const novo = req.body && req.body.dados;
  const mensagem = (req.body && req.body.mensagem) || 'Atualiza contas do condomínio';
  if (!novo || typeof novo !== 'object') return res.status(400).json({ ok: false, erro: 'Payload sem dados' });
  try {
    // SHA sempre fresco, lido no mesmo instante da gravação: duas abas abertas
    // (ou dois síndicos) invalidam qualquer SHA guardado antes.
    const { dados: atual, sha } = await carregar();
    // Precisa ser admin: quem não é recebe os dados redigidos, e gravar de
    // volta esse payload apagaria moradores e a autoria das cotas.
    if (!ehAdmin(atual, email)) return res.status(403).json({ ok: false, erro: 'Somente administradores podem alterar as contas' });
    const final = {
      ...semAcessos(novo),
      acessos: atual.acessos || [],
      admins: atual.admins || [],
      atualizadoEm: new Date().toISOString(),
      atualizadoPor: email
    };
    await ghPut(final, sha, `${mensagem} (${email})`);
    res.json({ ok: true, dados: semAcessos(final) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.get('/acessos', async (req, res) => {
  const email = email_(req.query.email);
  try {
    const { dados } = await carregar();
    if (!ehAdmin(dados, email)) return res.status(403).json({ ok: false, erro: 'Somente administradores' });
    res.json({ ok: true, lista: acessosDe(dados).map(e => ({ email: e, admin: ehAdmin(dados, e) })) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.post('/acessos', async (req, res) => {
  const email = email_(req.body && req.body.email);
  const bruta = (req.body && req.body.lista) || [];
  if (!Array.isArray(bruta)) return res.status(400).json({ ok: false, erro: 'Lista inválida' });
  try {
    const { dados: atual, sha } = await carregar();
    if (!ehAdmin(atual, email)) return res.status(403).json({ ok: false, erro: 'Somente administradores' });
    const vistos = new Set(); const lista = [];
    for (const item of bruta) {
      const e = email_(typeof item === 'string' ? item : item && item.email);
      if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || vistos.has(e)) continue;
      vistos.add(e);
      lista.push({ email: e, admin: !!(item && item.admin) });
    }
    if (!lista.length) return res.status(400).json({ ok: false, erro: 'Cadastre ao menos um e-mail' });
    const admins = lista.filter(x => x.admin).map(x => x.email);
    if (!admins.length) return res.status(400).json({ ok: false, erro: 'É preciso ao menos um administrador' });
    // Trava anti-tranca: ninguém tira o próprio acesso de admin. Transferência
    // de síndico se faz pelo administrador que entra, não pelo que sai.
    if (!admins.includes(email)) {
      return res.status(400).json({ ok: false, erro: 'Você não pode remover o seu próprio acesso de administrador — peça a outro administrador' });
    }
    await ghPut({ ...atual, acessos: lista.map(x => x.email), admins, atualizadoEm: new Date().toISOString(), atualizadoPor: email },
      sha, `Atualiza acessos do condomínio (${email})`);
    res.json({ ok: true, lista });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ── Banco Inter ──────────────────────────────────────────────────────────────
// Leitura do extrato da conta do condomínio. Tudo aqui é somente admin: o
// extrato traz nome e CPF de quem pagou, exatamente o que a visão de morador
// não pode ver.
async function exigirAdmin(req, res) {
  const email = email_(req.query.email || (req.body && req.body.email));
  const { dados } = await carregar();
  if (!ehAdmin(dados, email)) { res.status(403).json({ ok: false, erro: 'Somente administradores' }); return null; }
  return email;
}

rotas.get('/inter/status', async (req, res) => {
  try {
    if (!await exigirAdmin(req, res)) return;
    const cfg = inter.configurado();
    if (!cfg.ok) return res.json({ ok: false, configurado: cfg, erro: 'Faltam variáveis de ambiente' });
    await inter.token();
    // A descoberta de rota roda só aqui, no diagnóstico — nas chamadas normais
    // o caminho já vem resolvido em memória.
    const rotas_ = await inter.descobrir();
    res.json({ ok: true, configurado: cfg, token: inter.cacheInfo(), rotas: rotas_ });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.get('/inter/saldo', async (req, res) => {
  try {
    if (!await exigirAdmin(req, res)) return;
    res.json({ ok: true, saldo: await inter.saldo() });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

rotas.get('/inter/extrato', async (req, res) => {
  try {
    if (!await exigirAdmin(req, res)) return;
    const p = inter.periodoPadrao(Number(req.query.dias) || 7);
    const inicio = req.query.inicio || p.inicio;
    const fim = req.query.fim || p.fim;
    res.json({ ok: true, ...(await inter.extrato(inicio, fim)) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// O front-end antigo chama /castanheiras/*; o novo pode chamar a raiz. As duas
// formas respondem, então a virada de URL não precisa ser simultânea.
app.use('/castanheiras', rotas);
app.use('/', rotas);

app.get('/health', (req, res) => res.json({
  status: 'ok', repo: GITHUB_REPO, arquivo: DADOS_PATH,
  token: GITHUB_TOKEN ? 'configurado' : 'AUSENTE',
  inter: inter.configurado()
}));

app.use((err, req, res, next) => {
  console.error('[erro]', req.method, req.path, (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, erro: (err && err.message) || 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Castanheiras API na porta ${PORT} · repo ${GITHUB_REPO}/${DADOS_PATH}`));
