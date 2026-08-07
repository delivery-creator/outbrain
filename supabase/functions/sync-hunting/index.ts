// ============================================================
// OutBrain — Edge Function: sync-hunting
// Lê a aba DADOS_HUNTING da planilha de Hunting no Google Sheets e faz a
// carga na tabela `hunting_vagas`. Alimenta a aba "Hunting" do index.html.
//
// Cada LINHA da planilha = uma VAGA.
//
// REGRA DE IMPORTAÇÃO (a única filtragem feita aqui):
//   entram apenas linhas cuja coluna BU seja "Outforce" ou "Onebrain".
//   Qualquer outra BU (Fast, CSC, Kolivo…) é ignorada.
//   Também são descartadas linhas vazias e linhas sem Cliente.
//
// A planilha é a FONTE DA VERDADE: a cada sync bem-sucedido a tabela é
// esvaziada e reinserida (some quem saiu da planilha).
//
// As colunas são localizadas pelo NOME no cabeçalho (normalizado: sem
// acento, minúsculo, espaços colapsados), não pela posição — assim a
// planilha pode ganhar/reordenar colunas sem quebrar o sync.
//
// CACHE: se já houve um sync OK há menos de HUNTING_CACHE_MIN minutos, a
// função responde `{ ok:true, cache:true }` sem chamar o Google. Use
// body `{"force":true}` (o botão ↻ do front e o cron mandam force) para
// ignorar o cache.
//
// Secrets (Supabase > Project Settings > Edge Functions):
//   SB_URL                 -> URL do projeto Supabase             (já existe)
//   SB_SERVICE_ROLE_KEY    -> service_role key (ignora RLS)        (já existe)
//   GOOGLE_SA_EMAIL        -> client_email da service account      (já existe)
//   GOOGLE_SA_PRIVATE_KEY  -> private_key da service account       (já existe)
//   HUNTING_SHEET_ID       -> opcional; default abaixo             (opcional)
//   HUNTING_TAB            -> opcional, default "DADOS_HUNTING"    (opcional)
//   HUNTING_RANGE          -> opcional, default "A1:Z2000"         (opcional)
//   HUNTING_CACHE_MIN      -> opcional, default 10 (minutos)       (opcional)
//
// Deploy: supabase functions deploy sync-hunting
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SHEET_ID_DEFAULT = "1dKn6TLrgnp-WmjvyRzjbfHC_OY2pzXLR0tFbuwr7QU8";
const TAB_DEFAULT = "DADOS_HUNTING";

// ---------- Google auth (JWT RS256) — igual às outras syncs ----------
async function getGoogleAccessToken(email: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const pem = privateKeyPem.replace(/\\n/g, "\n");
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Falha no token Google: " + JSON.stringify(data));
  return data.access_token;
}

// ---------- helpers de texto ----------
function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim().toLowerCase();
}
function txt(s: unknown): string | null {
  const t = String(s ?? "").trim();
  return t ? t : null;
}
function a1Range(range: string): string {
  const bang = range.lastIndexOf("!");
  if (bang < 0) return range;
  let sheet = range.slice(0, bang);
  const cells = range.slice(bang + 1);
  if (!/^'.*'$/.test(sheet) && /[^A-Za-z0-9_]/.test(sheet)) {
    sheet = "'" + sheet.replace(/'/g, "''") + "'";
  }
  return `${sheet}!${cells}`;
}

// ---------- parsers ----------
// Datas da planilha: "09/12/2025", "12/01/26", ou serial do Sheets (45999).
// Qualquer coisa fora disso (negativos, "27/042026", texto) vira null —
// a planilha tem sujeira nessas colunas e é melhor não calcular do que
// calcular errado.
function parseData(v: unknown): string | null {
  const t = String(v ?? "").trim();
  if (!t) return null;

  const br = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (br) {
    const d = Number(br[1]);
    const m = Number(br[2]);
    let y = Number(br[3]);
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2000 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    // rejeita datas "que viram o mês" (ex.: 31/02)
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }

  // ISO já pronto
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return t.slice(0, 10);

  // serial do Google Sheets (dias desde 30/12/1899); ignora negativos
  const n = Number(t.replace(",", "."));
  if (isFinite(n) && n > 1 && n < 80000) {
    const ms = Math.round(n) * 86400000 + Date.UTC(1899, 11, 30);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

function parseNum(v: unknown): number | null {
  let t = String(v ?? "").replace(/[^\d.,-]/g, "").trim();
  if (!t) return null;
  const temVirgula = t.includes(","), temPonto = t.includes(".");
  if (temVirgula && temPonto) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (temVirgula) {
    t = t.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(t);
  return isFinite(n) ? n : null;
}

function parseInteiro(v: unknown): number {
  const n = parseNum(v);
  return n != null && n > 0 ? Math.round(n) : 0;
}

// BU canônica. A planilha tem variações e typos reais ("Ouforce",
// "Onebrain", "OneBrain"), então normalizamos por prefixo em vez de
// comparar string exata — senão vagas válidas seriam descartadas.
// Qualquer outra BU (Fast, CSC, Kolivo…) devolve null e a linha é ignorada.
function canonBU(v: unknown): string | null {
  const n = norm(v).replace(/\s/g, "");
  if (!n) return null;
  if (n.startsWith("onebrain") || n.startsWith("one brain")) return "OneBrain";
  if (n.startsWith("outforce") || n.startsWith("ouforce") || n.startsWith("outfroce")) return "Outforce";
  return null;
}

const STATUS_CANON = ["Aberta", "Fechada", "Congelada", "Cancelada", "Enviada"];
function canonStatus(v: unknown): string | null {
  const n = norm(v);
  if (!n) return null;
  const hit = STATUS_CANON.find((s) => n.startsWith(norm(s)));
  return hit ?? txt(v);
}

function canonTipoVaga(v: unknown): string | null {
  const n = norm(v);
  if (!n) return null;
  if (n.startsWith("vaga nova") || n === "nova") return "Vaga Nova";
  if (n.startsWith("replace")) return "Replace";
  return null;
}

// ---------- mapeamento de colunas por NOME do cabeçalho ----------
// chave interna -> nomes aceitos (normalizados). O 1º match vence; se não
// houver match exato, tenta "o header começa com" (cabeçalhos truncados).
const COLUNAS: Record<string, string[]> = {
  posicao:       ["posicao", "posição", "cargo"],
  valor_hora:    ["valor hora", "valor/hora", "valor da hora"],
  so_maquina:    ["so maquina", "so/maquina", "so", "maquina"],
  modalidade:    ["hunting, csc ou outsourcing", "hunting csc ou outsourcing", "modalidade"],
  bu:            ["bu", "unidade", "unidade de negocio"],
  prioridade:    ["prioridade"],
  temperatura:   ["temperatura"],
  cliente:       ["cliente"],
  tipo_vaga:     ["vaga nova ou replace", "tipo de vaga"],
  valor_salario: ["valor salario", "valor salário", "salario", "faixa salarial"],
  contratado:    ["contratado"],
  recrutador:    ["recrutador", "recrutadora"],
  gestor:        ["gestor", "gestora"],
  status:        ["status"],
  sla_planilha:  ["sla (dias corridos)", "sla dias corridos", "sla"],
  prazo:         ["prazo"],
  aberta_em:     ["aberta em", "data de abertura", "abertura"],
  fechada_em:    ["fechada em", "data de fechamento", "fechamento"],
  enviada_em:    ["enviada em", "data de envio", "envio"],
  congelada_em:  ["congelada em"],
  qtd_perfis:    ["quantidade de perfis", "qtd de perfis", "qtde de perfis", "perfis enviados"],
};

function mapearColunas(header: string[]): { idx: Record<string, number>; faltando: string[] } {
  const heads = header.map((h) => norm(h));
  const idx: Record<string, number> = {};
  for (const [chave, nomes] of Object.entries(COLUNAS)) {
    const alvos = nomes.map(norm);
    let pos = heads.findIndex((h) => h && alvos.includes(h));
    if (pos < 0) pos = heads.findIndex((h) => h && alvos.some((a) => h.startsWith(a)));
    if (pos >= 0) idx[chave] = pos;
  }
  // só estas são realmente indispensáveis para os indicadores
  const obrigatorias = ["bu", "cliente", "status", "aberta_em"];
  const faltando = obrigatorias.filter((c) => idx[c] === undefined);
  return { idx, faltando };
}

// ---------- leitura da planilha ----------
async function lerAba(token: string, sheetId: string, tab: string, cells: string) {
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const meta = await metaResp.json();
  const titles: string[] = (meta.sheets || [])
    .map((s: { properties?: { title?: string } }) => s?.properties?.title)
    .filter(Boolean) as string[];
  if (!titles.length) {
    throw new Error(
      "Planilha inacessível ou sem abas — confira o ID e o compartilhamento com a service account. Resp: " +
        JSON.stringify(meta).slice(0, 300),
    );
  }
  const nrm = (s: string) => s.normalize("NFC").trim().toLowerCase();
  const aba = titles.find((t) => nrm(t) === nrm(tab));
  if (!aba) throw new Error(`Aba "${tab}" não encontrada (abas: ${titles.join(", ")})`);

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(a1Range(`${aba}!${cells}`))}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const sheet = await resp.json();
  if (!resp.ok) throw new Error("Google Sheets: " + JSON.stringify(sheet).slice(0, 300));
  if (!sheet.values || !sheet.values.length) throw new Error(`Sem dados na aba "${aba}"`);
  return { values: sheet.values as string[][], aba, abas: titles };
}

// ---------- transformação ----------
type Vaga = Record<string, unknown>;

function montarLinhas(values: string[][]): {
  linhas: Vaga[];
  header: string[];
  lidas: number;
  ignoradas: number;
  bus_ignoradas: Record<string, number>;
} {
  const header = values[0] || [];
  const { idx, faltando } = mapearColunas(header);
  if (faltando.length) {
    throw new Error(
      `Colunas obrigatórias não encontradas no cabeçalho: ${faltando.join(", ")}. Cabeçalho lido: ${header.join(" | ")}`,
    );
  }
  const get = (row: string[], chave: string) => (idx[chave] === undefined ? "" : row[idx[chave]] ?? "");

  const linhas: Vaga[] = [];
  const bus_ignoradas: Record<string, number> = {};
  let lidas = 0, ignoradas = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    // linha totalmente vazia -> nem conta
    if (!row.some((c) => String(c ?? "").trim())) continue;
    lidas++;

    const bu = canonBU(get(row, "bu"));
    const cliente = txt(get(row, "cliente"));
    if (!bu || !cliente) {
      ignoradas++;
      const rotulo = !bu ? (txt(get(row, "bu")) ?? "(BU vazia)") : "(sem cliente)";
      bus_ignoradas[rotulo] = (bus_ignoradas[rotulo] || 0) + 1;
      continue;
    }

    linhas.push({
      linha: r + 1, // nº real da linha na planilha (1-based, com cabeçalho)
      posicao: txt(get(row, "posicao")),
      valor_hora: parseNum(get(row, "valor_hora")),
      so_maquina: txt(get(row, "so_maquina")),
      modalidade: txt(get(row, "modalidade")),
      bu,
      prioridade: txt(get(row, "prioridade")),
      temperatura: txt(get(row, "temperatura")),
      cliente,
      tipo_vaga: canonTipoVaga(get(row, "tipo_vaga")),
      valor_salario: txt(get(row, "valor_salario")),
      contratado: txt(get(row, "contratado")),
      recrutador: txt(get(row, "recrutador")),
      gestor: txt(get(row, "gestor")),
      status: canonStatus(get(row, "status")),
      sla_planilha: txt(get(row, "sla_planilha")),
      prazo: txt(get(row, "prazo")),
      aberta_em: parseData(get(row, "aberta_em")),
      fechada_em: parseData(get(row, "fechada_em")),
      enviada_em: parseData(get(row, "enviada_em")),
      congelada_em: parseData(get(row, "congelada_em")),
      qtd_perfis: parseInteiro(get(row, "qtd_perfis")),
    });
  }
  return { linhas, header, lidas, ignoradas, bus_ignoradas };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const t0 = Date.now();
  const SB_URL = Deno.env.get("SB_URL")!;
  const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
  const supa = createClient(SB_URL, SB_KEY);

  let origem = "manual";
  let force = false;
  try {
    const body = await req.json().catch(() => ({}));
    origem = String(body?.origem ?? "manual");
    force = body?.force === true;
  } catch { /* sem body */ }

  const registrarLog = async (campos: Record<string, unknown>) => {
    try { await supa.from("hunting_sync_log").insert(campos); } catch { /* log nunca derruba o sync */ }
  };

  try {
    const SA_EMAIL = Deno.env.get("GOOGLE_SA_EMAIL")!;
    const SA_KEY = Deno.env.get("GOOGLE_SA_PRIVATE_KEY")!;
    const SHEET_ID = Deno.env.get("HUNTING_SHEET_ID") ?? SHEET_ID_DEFAULT;
    const TAB = Deno.env.get("HUNTING_TAB") ?? TAB_DEFAULT;
    const CELLS = Deno.env.get("HUNTING_RANGE") ?? "A1:Z2000";
    const CACHE_MIN = Number(Deno.env.get("HUNTING_CACHE_MIN") ?? 10);

    // CACHE — evita bater no Google a cada clique/refresh do dashboard
    if (!force && CACHE_MIN > 0) {
      const desde = new Date(Date.now() - CACHE_MIN * 60000).toISOString();
      const { data: recente } = await supa
        .from("hunting_sync_log")
        .select("executado_em, importadas")
        .eq("ok", true)
        .gte("executado_em", desde)
        .order("executado_em", { ascending: false })
        .limit(1);
      if (recente && recente.length) {
        return json({
          ok: true,
          cache: true,
          sincronizado_em: recente[0].executado_em,
          total: recente[0].importadas,
          mensagem: `Sync recente (< ${CACHE_MIN} min). Use force:true para forçar.`,
        });
      }
    }

    const token = await getGoogleAccessToken(SA_EMAIL, SA_KEY);
    const { values, aba, abas } = await lerAba(token, SHEET_ID, TAB, CELLS);
    const { linhas, header, lidas, ignoradas, bus_ignoradas } = montarLinhas(values);

    // planilha é a fonte da verdade: limpa e reinsere
    const del = await supa.from("hunting_vagas").delete().gte("linha", 0);
    if (del.error) throw new Error("delete: " + del.error.message);

    // inserção em lotes (planilha pode crescer)
    const LOTE = 500;
    for (let i = 0; i < linhas.length; i += LOTE) {
      const ins = await supa.from("hunting_vagas").insert(linhas.slice(i, i + LOTE));
      if (ins.error) throw new Error("insert: " + ins.error.message);
    }

    const clientes = [...new Set(linhas.map((l) => l.cliente as string))].sort();
    const duracao = Date.now() - t0;
    await registrarLog({
      ok: true, origem, linhas_lidas: lidas, importadas: linhas.length,
      ignoradas, duracao_ms: duracao,
      detalhe: { aba, clientes, bus_ignoradas },
    });

    return json({
      ok: true,
      cache: false,
      total: linhas.length,
      linhas_lidas: lidas,
      ignoradas,
      bus_ignoradas,
      clientes,
      aba, abas, header,
      duracao_ms: duracao,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (e) {
    const erro = String((e as Error)?.message ?? e);
    await registrarLog({ ok: false, origem, duracao_ms: Date.now() - t0, erro });
    return json({ ok: false, erro }, 500);
  }
});
