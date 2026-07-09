// ============================================================
// OutBrain — Edge Function: sync-mapa
// Lê a planilha do mapa no Google Sheets (colunas Cliente, Faturamento,
// Endereço, BU), geocodifica o Endereço via Nominatim/OSM (endereço →
// lat/lng + cidade/UF) e faz upsert em `faturamento_geo`. Alimenta a
// página "Mapa" do index.html.
//
// Leitura da planilha: MESMO método da sync-faturamento — Google service
// account (JWT RS256). Os secrets do Google e do Supabase são globais do
// projeto, então esta função REUSA a mesma service account; basta:
//   1) compartilhar a planilha do mapa com o e-mail GOOGLE_SA_EMAIL, e
//   2) criar os secrets MAPA_SHEET_ID e MAPA_SHEET_RANGE.
//
// Secrets (Supabase > Project Settings > Edge Functions):
//   SB_URL                  -> URL do projeto Supabase           (já existe)
//   SB_SERVICE_ROLE_KEY     -> service_role key (ignora RLS)      (já existe)
//   GOOGLE_SA_EMAIL         -> client_email da service account    (já existe)
//   GOOGLE_SA_PRIVATE_KEY   -> private_key da service account     (já existe)
//   MAPA_SHEET_ID           -> ID da planilha do mapa (da URL)    (NOVO)
//   MAPA_SHEET_RANGE        -> ex.: "Página1!A1:D100"             (NOVO)
//
// Deploy: supabase functions deploy sync-mapa
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Google auth (JWT RS256) — igual à sync-faturamento ----------
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

// ---------- helpers de valor / colunas ----------

// "R$ 1.234.567,89" / "1234567" / "1,234,567.89" -> number
function parseValor(s: string): number {
  if (!s) return 0;
  let t = String(s).replace(/[^\d.,-]/g, "").trim();
  if (!t) return 0;
  const temVirgula = t.includes(","), temPonto = t.includes(".");
  if (temVirgula && temPonto) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (temVirgula) {
    t = t.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(t);
  return isFinite(n) ? n : 0;
}

function norm(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

// Notação A1: nomes de aba com acento/espaço/caractere especial precisam vir
// entre aspas simples (ex.: 'Página1'!A1:D200). Cita o nome da aba se necessário.
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
function acharCol(header: string[], ...nomes: string[]): number {
  const H = header.map(norm);
  for (const nome of nomes) { const i = H.indexOf(norm(nome)); if (i >= 0) return i; }
  for (const nome of nomes) { const i = H.findIndex((h) => h.includes(norm(nome))); if (i >= 0) return i; }
  return -1;
}

// ---------- geocoding (Nominatim/OSM) ----------

const UF_POR_ESTADO: Record<string, string> = {
  "acre": "AC", "alagoas": "AL", "amapá": "AP", "amazonas": "AM",
  "bahia": "BA", "ceará": "CE", "distrito federal": "DF", "espírito santo": "ES",
  "goiás": "GO", "maranhão": "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
  "minas gerais": "MG", "pará": "PA", "paraíba": "PB", "paraná": "PR",
  "pernambuco": "PE", "piauí": "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", "rondônia": "RO",
  "roraima": "RR", "santa catarina": "SC", "são paulo": "SP",
  "sergipe": "SE", "tocantins": "TO",
};
const UF_NOME: Record<string, string> = Object.fromEntries(
  Object.entries(UF_POR_ESTADO).map(([nome, sig]) => [sig, nome.replace(/\b\w/g, (c) => c.toUpperCase())]),
);
function ufDe(estado?: string): string | null {
  if (!estado) return null;
  return UF_POR_ESTADO[estado.trim().toLowerCase()] ?? null;
}

// Extrai UF (2 letras), CEP (8 dígitos) e a CIDADE do texto livre do endereço.
// Formato típico: "...BAIRRO Cidade - UF UF 00000-000 Brasil". A cidade é o
// trecho antes de " - UF", pegando tokens da direita até bater num token
// TODO-EM-MAIÚSCULO (que costuma ser o bairro).
function extraiEndereco(addr: string): { uf: string | null; cep: string | null; cidade: string | null } {
  const mUF = addr.match(/-\s*([A-Z]{2})\b/);
  const uf = mUF ? mUF[1] : null;
  const mCep = addr.match(/\b(\d{5})-?(\d{3})\b/);
  const cep = mCep ? mCep[1] + mCep[2] : null;
  let cidade: string | null = null;
  const mCid = addr.match(/([A-Za-zÀ-ÿ.'’\s]+?)\s*-\s*[A-Z]{2}\b/);
  if (mCid) {
    const toks = mCid[1].trim().split(/\s+/);
    const out: string[] = [];
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i];
      const allCaps = t.toUpperCase() === t && t.replace(/[^A-ZÀ-Ý]/g, "").length >= 3;
      if (allCaps && out.length) break;
      out.unshift(t);
      if (allCaps) break;
    }
    cidade = out.join(" ") || null;
  }
  return { uf, cep, cidade };
}

async function nominatim(params: Record<string, string>) {
  const url = "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "1", ...params });
  const res = await fetch(url, {
    headers: { "User-Agent": "outbrain-dashboard/1.0 (sync-mapa)", "Accept-Language": "pt-BR" },
  });
  await sleep(1100); // política Nominatim: máx ~1 req/s
  if (!res.ok) return null;
  const arr = await res.json().catch(() => null);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const h = arr[0], a = h.address || {};
  return {
    lat: Number(h.lat),
    lng: Number(h.lon),
    cidade: a.city || a.town || a.village || a.municipality || a.county || null,
    estado: a.state || null,
    uf: ufDe(a.state),
  };
}

// Geocodifica com fallback: CEP → "Cidade, Estado" → "última palavra, Estado".
// Valida a UF do resultado contra a UF extraída (evita cidade homônima em
// outro estado). Retorna null se nenhuma tentativa passar.
async function geocode(endereco: string) {
  const { uf, cep, cidade } = extraiEndereco(endereco);
  const tentativas: Record<string, string>[] = [];
  if (cep) tentativas.push({ postalcode: cep, country: "Brazil" });
  if (cidade && uf) tentativas.push({ q: `${cidade}, ${UF_NOME[uf]}, Brasil`, countrycodes: "br" });
  if (cidade && uf) {
    const ult = cidade.split(/\s+/).slice(-1)[0];
    if (ult && ult !== cidade) tentativas.push({ q: `${ult}, ${UF_NOME[uf]}, Brasil`, countrycodes: "br" });
  }
  for (const p of tentativas) {
    const r = await nominatim(p);
    if (r && isFinite(r.lat) && isFinite(r.lng) && (!uf || r.uf === uf)) {
      return { ...r, uf: r.uf || uf, cidade: r.cidade || cidade };
    }
  }
  return null;
}

// ---------- handler ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SB_URL = Deno.env.get("SB_URL")!;
    const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
    const SA_EMAIL = Deno.env.get("GOOGLE_SA_EMAIL")!;
    const SA_KEY = Deno.env.get("GOOGLE_SA_PRIVATE_KEY")!;
    const SHEET_ID = Deno.env.get("MAPA_SHEET_ID")!;
    const SHEET_RANGE = Deno.env.get("MAPA_SHEET_RANGE") ?? "Página1!A1:D200";
    if (!SHEET_ID) return json({ ok: false, erro: "MAPA_SHEET_ID não configurado" }, 500);

    const supa = createClient(SB_URL, SB_KEY);

    // 1) lê a planilha via API do Google (mesma service account do faturamento)
    const token = await getGoogleAccessToken(SA_EMAIL, SA_KEY);

    // Resolve o nome REAL da aba pelos metadados do Google — robusto a acento,
    // forma Unicode (NFC/NFD) e caixa. Evita "Unable to parse range" quando o
    // "á" digitado no secret difere do "á" guardado no nome da aba.
    const metaResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const meta = await metaResp.json();
    const titles: string[] = (meta.sheets || []).map((s: { properties?: { title?: string } }) => s?.properties?.title).filter(Boolean) as string[];
    if (!titles.length) {
      return json({ ok: false, erro: "Planilha inacessível ou sem abas — confira MAPA_SHEET_ID e se a planilha foi compartilhada com a service account. Resp: " + JSON.stringify(meta).slice(0, 300) }, 400);
    }
    const bang = SHEET_RANGE.lastIndexOf("!");
    const cells = bang >= 0 ? SHEET_RANGE.slice(bang + 1) : SHEET_RANGE;
    const wanted = bang >= 0 ? SHEET_RANGE.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : "";
    const nrm = (s: string) => s.normalize("NFC").trim().toLowerCase();
    const aba = titles.find((t) => nrm(t) === nrm(wanted)) || titles[0];

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(a1Range(`${aba}!${cells}`))}`;
    const sheetResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const sheet = await sheetResp.json();
    if (!sheet.values || !sheet.values.length) {
      return json({ ok: false, erro: `Sem dados na aba "${aba}" (abas encontradas: ${titles.join(", ")}). Resp: ` + JSON.stringify(sheet).slice(0, 200) }, 400);
    }
    const values = sheet.values as string[][];

    // Detecta cabeçalho (Cliente/Faturamento/Endereço/BU). Se não houver,
    // assume posição fixa A=Cliente, B=Faturamento, C=Endereço, D=BU.
    const primeira = values[0] || [];
    const temHeader = /cliente|endere|faturamento|\bbu\b|unidade/.test(norm(primeira.join(" ")));
    const ci = { cliente: 0, faturamento: 1, endereco: 2, bu: 3 };
    let dataRows = values;
    if (temHeader) {
      ci.cliente = acharCol(primeira, "Cliente", "Nome");
      ci.faturamento = acharCol(primeira, "Faturamento", "Valor");
      ci.endereco = acharCol(primeira, "Endereço", "Endereco", "Localização", "Localizacao");
      ci.bu = acharCol(primeira, "BU", "Unidade", "Marca");
      if (ci.cliente < 0) ci.cliente = 0;
      if (ci.faturamento < 0) ci.faturamento = 1;
      if (ci.endereco < 0) ci.endereco = 2;
      if (ci.bu < 0) ci.bu = 3;
      dataRows = values.slice(1);
    }

    // 2) cache atual, chaveado por (cliente|bu) — o mesmo cliente pode aparecer
    // em mais de uma BU (ex.: "Attivo" em Fast e Kolivo).
    const { data: atuais } = await supa
      .from("faturamento_geo")
      .select("cliente, bu, endereco, lat, lng, cidade, uf, estado");
    const cache = new Map((atuais || []).map((r) => [`${r.cliente}|${r.bu || ""}`, r]));

    let geocodificados = 0, doCache = 0, falhas = 0;
    const naoGeocodados: string[] = [];
    const registros: Record<string, unknown>[] = [];

    for (const row of dataRows) {
      const cliente = (row[ci.cliente] || "").trim();
      if (!cliente) continue;
      const endereco = (row[ci.endereco] || "").trim();
      const faturamento = parseValor(row[ci.faturamento]);
      const bu = (row[ci.bu] || "").trim();

      const prev = cache.get(`${cliente}|${bu}`);
      let geo = null as null | { lat: number; lng: number; cidade: string | null; estado: string | null; uf: string | null };
      let geo_status = "pendente";

      const cacheValido = prev && prev.lat != null && prev.endereco === endereco;
      if (cacheValido) {
        geo = { lat: Number(prev!.lat), lng: Number(prev!.lng), cidade: prev!.cidade, estado: prev!.estado, uf: prev!.uf };
        geo_status = "ok";
        doCache++;
      } else if (endereco) {
        try {
          geo = await geocode(endereco); // já respeita o rate-limit internamente
          if (geo && isFinite(geo.lat) && isFinite(geo.lng)) { geo_status = "ok"; geocodificados++; }
          else { geo_status = "falha"; falhas++; naoGeocodados.push(`${cliente} (${bu})`); }
        } catch (_e) {
          geo_status = "falha"; falhas++; naoGeocodados.push(`${cliente} (${bu})`);
        }
      } else {
        geo_status = "falha"; falhas++; naoGeocodados.push(`${cliente} (${bu})`);
      }

      registros.push({
        cliente,
        faturamento,
        bu,
        endereco: endereco || null,
        cidade: geo?.cidade ?? null,
        uf: geo?.uf ?? null,
        estado: geo?.estado ?? null,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        geo_status,
        updated_at: new Date().toISOString(),
      });
    }

    // 3) upsert por (cliente, bu)
    const { error } = await supa
      .from("faturamento_geo")
      .upsert(registros, { onConflict: "cliente,bu" });
    if (error) return json({ ok: false, erro: error.message }, 500);

    return json({
      ok: true,
      total: registros.length,
      geocodificados,
      do_cache: doCache,
      falhas,
      nao_geocodados: naoGeocodados,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message ?? e) }, 500);
  }
});
