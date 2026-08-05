// ============================================================
// OutBrain — Edge Function: sync-forecast
// Lê as planilhas de FORECAST no Google Sheets (layout LARGO: coluna A =
// Cliente, e uma coluna por mês — "janeiro/26" ... "dezembro/26") e faz a
// carga na tabela `forecast` (ano, unidade, cliente, mes, valor). Alimenta a
// aba "Forecast" do index.html (realizado + forecast vs meta).
//
// UMA planilha com uma ABA por unidade (BU): "forecast_Onebrain" e
// "forecast_Outforce". Cada aba é a fonte da verdade da sua unidade/ano — por
// isso, para cada unidade lida com sucesso, apagamos as linhas daquele
// (ano, unidade) e reinserimos (remove clientes/meses que saíram e o SEED).
//
// Leitura da planilha: MESMO método da sync-mapa/sync-faturamento — Google
// service account (JWT RS256). Secrets do Google/Supabase são globais do
// projeto, então REUSA a mesma service account; basta:
//   1) compartilhar a planilha com o e-mail GOOGLE_SA_EMAIL (Leitor), e
//   2) criar o secret FORECAST_SHEET_ID.
//
// Secrets (Supabase > Project Settings > Edge Functions):
//   SB_URL                   -> URL do projeto Supabase            (já existe)
//   SB_SERVICE_ROLE_KEY      -> service_role key (ignora RLS)       (já existe)
//   GOOGLE_SA_EMAIL          -> client_email da service account     (já existe)
//   GOOGLE_SA_PRIVATE_KEY    -> private_key da service account      (já existe)
//   FORECAST_SHEET_ID        -> ID da planilha de forecast (da URL) (NOVO)
//   FORECAST_TAB_ONEBRAIN    -> opcional, default "forecast_Onebrain"
//   FORECAST_TAB_OUTFORCE    -> opcional, default "forecast_Outforce"
//   FORECAST_RANGE           -> opcional, default "A1:R300"         (opcional)
//   FORECAST_ANO             -> opcional; senão deriva do cabeçalho / 2026
//
// Deploy: supabase functions deploy sync-forecast
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- Google auth (JWT RS256) — igual à sync-mapa ----------
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

// ---------- helpers ----------
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

const MESES = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
// header "janeiro/26" -> 1 ; "CNPJ" / "Cliente" -> 0 (não é mês)
function mesDoHeader(h: string): number {
  const n = norm(h);
  for (let i = 0; i < 12; i++) if (n.startsWith(MESES[i])) return i + 1;
  return 0;
}
// deriva o ano do sufixo "/26" -> 2026 ; senão 0
function anoDoHeader(h: string): number {
  const m = String(h).match(/\/\s*(\d{2,4})/);
  if (!m) return 0;
  const y = Number(m[1]);
  return y < 100 ? 2000 + y : y;
}
// linhas que NÃO são cliente (totais/placeholder)
const SKIP_CLIENTE = new Set(["", "receitas", "receita", "cliente", "total", "totais"]);

// lê a 1ª aba (ou a configurada no range) de uma planilha e devolve os valores
async function lerPlanilha(token: string, sheetId: string, range: string): Promise<{ values: string[][]; aba: string; abas: string[] }> {
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const meta = await metaResp.json();
  const titles: string[] = (meta.sheets || [])
    .map((s: { properties?: { title?: string } }) => s?.properties?.title)
    .filter(Boolean) as string[];
  if (!titles.length) {
    throw new Error("Planilha inacessível ou sem abas — confira o ID e o compartilhamento com a service account. Resp: " + JSON.stringify(meta).slice(0, 300));
  }
  const bang = range.lastIndexOf("!");
  const cells = bang >= 0 ? range.slice(bang + 1) : range;
  const wanted = bang >= 0 ? range.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : "";
  const nrm = (s: string) => s.normalize("NFC").trim().toLowerCase();
  let aba: string;
  if (wanted) {
    const match = titles.find((t) => nrm(t) === nrm(wanted));
    if (!match) throw new Error(`Aba "${wanted}" não encontrada (abas: ${titles.join(", ")})`);
    aba = match;
  } else {
    aba = titles[0];
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(a1Range(`${aba}!${cells}`))}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const sheet = await resp.json();
  if (!sheet.values || !sheet.values.length) {
    throw new Error(`Sem dados na aba "${aba}" (abas: ${titles.join(", ")}). Resp: ` + JSON.stringify(sheet).slice(0, 200));
  }
  return { values: sheet.values as string[][], aba, abas: titles };
}

// converte o layout largo em registros { ano, cliente, mes, valor }.
// A planilha pode ter meses de mais de um ano (ex.: set/25…dez/26), então o
// ano vem de CADA coluna ("setembro/25"->2025, "setembro/26"->2026).
function parseForecast(values: string[][]): { registros: { ano: number; cliente: string; mes: number; valor: number }[]; header: string[]; anos: number[] } {
  const header = values[0] || [];
  const colInfo: { col: number; mes: number; ano: number }[] = [];
  header.forEach((h, col) => {
    const mes = mesDoHeader(h);
    if (mes) colInfo.push({ col, mes, ano: anoDoHeader(h) });
  });
  const registros: { ano: number; cliente: string; mes: number; valor: number }[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const cliente = (row[0] || "").trim();
    if (SKIP_CLIENTE.has(norm(cliente))) continue;
    for (const { col, mes, ano } of colInfo) {
      if (!ano) continue; // coluna de mês sem ano no cabeçalho -> ignora
      const valor = parseValor(row[col]);
      if (valor > 0) registros.push({ ano, cliente, mes, valor });
    }
  }
  const anos = [...new Set(colInfo.map((c) => c.ano).filter(Boolean))];
  return { registros, header, anos };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SB_URL = Deno.env.get("SB_URL")!;
    const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
    const SA_EMAIL = Deno.env.get("GOOGLE_SA_EMAIL")!;
    const SA_KEY = Deno.env.get("GOOGLE_SA_PRIVATE_KEY")!;
    const SHEET_ID = Deno.env.get("FORECAST_SHEET_ID");
    const CELLS = Deno.env.get("FORECAST_RANGE") ?? "A1:R300";
    const ANO_ENV = Number(Deno.env.get("FORECAST_ANO") || 0);
    if (!SHEET_ID) return json({ ok: false, erro: "FORECAST_SHEET_ID não configurado" }, 500);

    // uma planilha, uma aba por unidade
    const fontes: { unidade: string; tab: string }[] = [
      { unidade: "OneBrain", tab: Deno.env.get("FORECAST_TAB_ONEBRAIN") ?? "forecast_Onebrain" },
      { unidade: "Outforce", tab: Deno.env.get("FORECAST_TAB_OUTFORCE") ?? "forecast_Outforce" },
    ];

    const supa = createClient(SB_URL, SB_KEY);
    const token = await getGoogleAccessToken(SA_EMAIL, SA_KEY);

    const resultado: Record<string, unknown>[] = [];
    let totalInserido = 0;

    for (const { unidade, tab } of fontes) {
      try {
        const { values, aba, abas } = await lerPlanilha(token, SHEET_ID, `${tab}!${CELLS}`);
        let { registros, header } = parseForecast(values);
        if (ANO_ENV) registros = registros.filter((r) => r.ano === ANO_ENV); // opcional: só um ano

        const linhas = registros.map((x) => ({ ano: x.ano, unidade, cliente: x.cliente, mes: x.mes, valor: x.valor }));
        const anos = [...new Set(linhas.map((l) => l.ano))].sort();

        // fonte da verdade por (ano, unidade): limpa cada ano presente e reinsere
        for (const a of anos) {
          const del = await supa.from("forecast").delete().eq("ano", a).eq("unidade", unidade);
          if (del.error) throw new Error("delete: " + del.error.message);
        }
        if (linhas.length) {
          const ins = await supa.from("forecast").upsert(linhas, { onConflict: "ano,unidade,cliente,mes" });
          if (ins.error) throw new Error("upsert: " + ins.error.message);
        }
        totalInserido += linhas.length;
        const clientes = [...new Set(linhas.map((l) => l.cliente))];
        resultado.push({ unidade, ok: true, anos, aba, abas, registros: linhas.length, clientes, header });
      } catch (e) {
        resultado.push({ unidade, ok: false, erro: String((e as Error)?.message ?? e) });
      }
    }

    const ok = resultado.some((r) => r.ok);
    return json({
      ok,
      total: totalInserido,
      fontes: resultado,
      sincronizado_em: new Date().toISOString(),
    }, ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message ?? e) }, 500);
  }
});
