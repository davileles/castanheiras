// ── Integração com o Banco Inter Empresas ────────────────────────────────────
// A API do Inter exige mTLS: certificado de cliente na própria conexão TLS.
// Isso derruba duas opções de imediato — o navegador não pode chamar (não tem
// como carregar o certificado sem expô-lo numa página pública) e o `fetch`
// global do Node não aceita `https.Agent`. Por isso aqui é o módulo `https`
// puro: funciona, e não entra dependência nova no projeto.
//
// O certificado e a chave chegam em base64 nas variáveis de ambiente, porque
// PEM é multilinha e variável de ambiente com quebra de linha costuma chegar
// corrompida no Railway. PEM cru também é aceito, para quem colar direto.
const https = require('https');

const BASE = process.env.INTER_BASE || 'https://cdpj.partners.bancointer.com.br';
const CLIENT_ID = process.env.INTER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.INTER_CLIENT_SECRET || '';
const CONTA = (process.env.INTER_CONTA || '').replace(/\D/g, '');
const SCOPE = process.env.INTER_SCOPE || 'extrato.read';

function pem(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.includes('-----BEGIN')) return s.replace(/\\n/g, '\n');
  try {
    const dec = Buffer.from(s, 'base64').toString('utf8');
    return dec.includes('-----BEGIN') ? dec : null;
  } catch { return null; }
}

const CERT = pem(process.env.INTER_CERT);
const KEY = pem(process.env.INTER_KEY);

function configurado() {
  return { CLIENT_ID: !!CLIENT_ID, CLIENT_SECRET: !!CLIENT_SECRET, CERT: !!CERT, KEY: !!KEY, CONTA: CONTA || null, ok: !!(CLIENT_ID && CLIENT_SECRET && CERT && KEY) };
}

// Requisição crua com mTLS. Devolve status + corpo sempre, mesmo em erro: o
// Inter manda mensagens úteis no corpo dos 4xx e engoli-las custa horas.
function requisitar(metodo, caminho, { corpo, headers, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(caminho.startsWith('http') ? caminho : BASE + caminho);
    const payload = corpo == null ? null : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const req = https.request({
      method: metodo,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      cert: CERT,
      key: KEY,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(headers || {})
      },
      timeout
    }, (res) => {
      let dados = '';
      res.on('data', (c) => { dados += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(dados); } catch {}
        resolve({ status: res.statusCode, json, texto: json ? null : dados.slice(0, 600) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout na chamada ao Inter')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Token vive ~1h. Guardado só em memória: reinício do serviço pede outro, e
// nada de credencial encosta em disco.
let cache = { token: null, expira: 0, escopos: null };

async function token(forcar) {
  const cfg = configurado();
  if (!cfg.ok) throw new Error('Integração com o Inter não configurada (faltam ' + Object.entries(cfg).filter(([k, v]) => v === false).map(([k]) => k).join(', ') + ')');
  if (!forcar && cache.token && Date.now() < cache.expira) return cache.token;

  const corpo = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: SCOPE,
    grant_type: 'client_credentials'
  }).toString();

  const r = await requisitar('POST', '/oauth/v2/token', {
    corpo,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error(`Token recusado pelo Inter (${r.status}): ${JSON.stringify(r.json || r.texto)}`);
  }
  // Margem de 60s para não usar um token que expira no meio do voo.
  cache = {
    token: r.json.access_token,
    expira: Date.now() + Math.max(0, (Number(r.json.expires_in) || 3600) - 60) * 1000,
    escopos: r.json.scope || null
  };
  return cache.token;
}

async function autenticado(metodo, caminho, opts = {}) {
  const t = await token();
  return requisitar(metodo, caminho, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t}`,
      // Obrigatório quando a integração está associada a mais de uma conta.
      ...(CONTA ? { 'x-conta-corrente': CONTA } : {}),
      ...(opts.headers || {})
    }
  });
}

// O Inter já versionou o caminho do extrato mais de uma vez e a referência
// oficial é renderizada por JS (não dá para ler de fora). Em vez de fixar um
// palpite, tentamos os candidatos uma vez e guardamos o que respondeu — o
// diagnóstico vira dado, não tentativa e erro manual.
const CANDIDATOS_EXTRATO = [
  '/banking/v2/extrato/completo',
  '/banking/v3/extrato/completo',
  '/banking/v2/extrato',
  '/banking/v3/extrato'
];
const CANDIDATOS_SALDO = ['/banking/v2/saldo', '/banking/v3/saldo'];
let rotaExtrato = null, rotaSaldo = null;

function periodoPadrao(dias) {
  const fim = new Date();
  const inicio = new Date(fim.getTime() - (dias || 7) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { inicio: iso(inicio), fim: iso(fim) };
}

async function descobrir() {
  const p = periodoPadrao(3);
  const out = { extrato: [], saldo: [] };
  for (const c of CANDIDATOS_EXTRATO) {
    const r = await autenticado('GET', `${c}?dataInicio=${p.inicio}&dataFim=${p.fim}&pagina=0&tamanhoPagina=10`);
    out.extrato.push({ caminho: c, status: r.status, amostra: r.status === 200 ? Object.keys(r.json || {}) : (r.json && (r.json.title || r.json.message || r.json.detail)) || r.texto });
    if (r.status === 200 && !rotaExtrato) rotaExtrato = c;
  }
  for (const c of CANDIDATOS_SALDO) {
    const r = await autenticado('GET', c);
    out.saldo.push({ caminho: c, status: r.status });
    if (r.status === 200 && !rotaSaldo) rotaSaldo = c;
  }
  return { ...out, escolhido: { extrato: rotaExtrato, saldo: rotaSaldo } };
}

async function saldo() {
  if (!rotaSaldo) await descobrir();
  if (!rotaSaldo) throw new Error('Nenhum endpoint de saldo respondeu — rode /inter/status');
  const r = await autenticado('GET', rotaSaldo);
  if (r.status !== 200) throw new Error(`Saldo (${r.status}): ${JSON.stringify(r.json || r.texto)}`);
  return r.json;
}

// Percorre a paginação até o fim. O Inter limita a janela de consulta, então
// períodos longos devem ser quebrados por quem chama.
async function extrato(inicio, fim) {
  if (!rotaExtrato) await descobrir();
  if (!rotaExtrato) throw new Error('Nenhum endpoint de extrato respondeu — rode /inter/status');
  const itens = [];
  let pagina = 0, total = 1;
  while (pagina < total && pagina < 50) {
    const r = await autenticado('GET', `${rotaExtrato}?dataInicio=${inicio}&dataFim=${fim}&pagina=${pagina}&tamanhoPagina=100`);
    if (r.status !== 200) throw new Error(`Extrato (${r.status}): ${JSON.stringify(r.json || r.texto)}`);
    const j = r.json || {};
    const lote = j.transacoes || j.content || j.itens || (Array.isArray(j) ? j : []);
    itens.push(...lote);
    total = Number(j.totalPaginas || j.totalPages || 1) || 1;
    pagina += 1;
    if (!lote.length) break;
  }
  return { rota: rotaExtrato, inicio, fim, total: itens.length, itens };
}

// Mesma função de hash do front-end, para o id da transação sobreviver a
// qualquer caminho: o `idTransacao` do Inter é estável e único, então importar
// duas vezes o mesmo período nunca duplica lançamento.
function hashCurto(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 'I' + (h >>> 0).toString(36);
}

// Traduz a transação do Inter para o formato que a tela de importação já
// consome — o mesmo que sai do parser de OFX. Assim a API vira só mais uma
// fonte, sem tocar na classificação nem na conferência.
function normalizar(t) {
  const det = t.detalhes || {};
  const credito = String(t.tipoOperacao || '').toUpperCase() === 'C';
  const data = String(t.dataTransacao || t.dataInclusao || '').slice(0, 10);
  const valor = Math.abs(Number(String(t.valor).replace(',', '.')) || 0);

  // No crédito o nome do pagador é o que o classificador usa para achar o
  // morador; no débito, a descrição é o que casa com as regras de categoria.
  const nome = credito ? (det.nomePagador || t.descricao) : (t.descricao || det.nomeRecebedor);
  const partes = [];
  if (nome) partes.push(String(nome).trim());
  const extra = String(det.descricaoPix || '').trim();
  if (extra && !partes.join(' ').includes(extra)) partes.push(extra);

  return {
    id: hashCurto(t.idTransacao || (data + valor + (nome || ''))),
    data,
    descricao: partes.join(' — ') || String(t.titulo || 'Movimentação'),
    valor,
    credito,
    origem: 'inter',
    // Chave estável de identificação do pagador — bem melhor que o nome, que
    // vem escrito de um jeito a cada mês. Ainda não é usada na classificação.
    cpf: String((credito ? det.cpfCnpjPagador : det.cpfCnpjRecebedor) || '').replace(/\D/g, '') || null,
    tipoTransacao: t.tipoTransacao || null
  };
}

async function transacoes(inicio, fim) {
  const r = await extrato(inicio, fim);
  return { ...r, itens: r.itens.map(normalizar).filter(t => t.data && t.valor > 0) };
}

module.exports = { configurado, token, descobrir, saldo, extrato, transacoes, normalizar, periodoPadrao, cacheInfo: () => ({ temToken: !!cache.token, expiraEm: cache.expira ? new Date(cache.expira).toISOString() : null, escopos: cache.escopos }) };
