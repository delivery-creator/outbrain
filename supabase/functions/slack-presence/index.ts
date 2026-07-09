// Supabase Edge Function: slack-presence
// Faz polling da presença dos alocados OneBrain no Slack e acumula os
// minutos ativos do dia em `presenca_diaria`. Deve ser chamada por um
// cron (ver supabase/sql/presenca.sql) a cada ~15 min na janela de trabalho.
//
// Variáveis de ambiente necessárias (Project Settings > Edge Functions > Secrets):
//   SLACK_BOT_TOKEN            token do bot (xoxb-...) com escopos users:read e users:read.email
//   SUPABASE_URL               (injetada automaticamente)
//   SUPABASE_SERVICE_ROLE_KEY  service role (injetada automaticamente)
//
// Deploy: supabase functions deploy slack-presence

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SLACK_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "America/Sao_Paulo";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// Data (YYYY-MM-DD), hora e dia-da-semana no fuso de São Paulo
function nowSP() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    hora: parseInt(p.hour, 10),
    weekday: p.weekday, // Mon, Tue, ...
  };
}

async function slack(method: string, params: Record<string, string>) {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const body = await req.json().catch(() => ({}));
  const pollMin: number = Number(body.pollMin) || 15;
  const force: boolean = body.force === true;

  const t = nowSP();
  const emFimDeSemana = t.weekday === "Sat" || t.weekday === "Sun";
  const foraDaJanela = t.hora < 9 || t.hora >= 18;
  if (!force && (emFimDeSemana || foraDaJanela)) {
    return new Response(JSON.stringify({ ok: true, skipped: `fora da janela (${t.weekday} ${t.hora}h)` }),
      { headers: { ...cors, "Content-Type": "application/json" } });
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  // Alocados OneBrain ativos com e-mail corporativo
  const { data: alocados, error: aErr } = await supa
    .from("alocados")
    .select("id, company_email, slack_user_id, photo_url, unidade_negocio, desligamento")
    .is("desligamento", null)
    .not("company_email", "is", null);
  if (aErr) return new Response(JSON.stringify({ ok: false, error: aErr.message }), { status: 500, headers: cors });

  const alvo = (alocados || []).filter(
    (a) => (a.unidade_negocio || "OneBrain") === "OneBrain" && a.company_email,
  );

  // Presença já registrada hoje (para acumular)
  const { data: jaHoje } = await supa
    .from("presenca_diaria").select("*").eq("data", t.data);
  const mapHoje = new Map((jaHoje || []).map((r) => [r.alocado_id, r]));

  const nowISO = new Date().toISOString();
  const upserts: any[] = [];
  let ativos = 0, semSlack = 0, erros = 0;

  const fotoDe = (u: any) => u?.profile?.image_512 || u?.profile?.image_192 || u?.profile?.image_original || null;

  for (const a of alvo) {
    // Resolve e cacheia o slack_user_id (e a foto, na primeira vez)
    let uid = a.slack_user_id as string | null;
    if (!uid) {
      const look = await slack("users.lookupByEmail", { email: a.company_email });
      if (!look.ok) { semSlack++; continue; }
      uid = look.user.id;
      const foto = fotoDe(look.user);
      await supa.from("alocados")
        .update({ slack_user_id: uid, ...(foto && !a.photo_url ? { photo_url: foto } : {}) })
        .eq("id", a.id);
    } else if (!a.photo_url) {
      // já resolvido mas sem foto: busca uma vez e para
      const info = await slack("users.info", { user: uid });
      const foto = info.ok ? fotoDe(info.user) : null;
      if (foto) await supa.from("alocados").update({ photo_url: foto }).eq("id", a.id);
    }

    const pres = await slack("users.getPresence", { user: uid! });
    if (!pres.ok) { erros++; continue; }

    if (pres.presence === "active") {
      ativos++;
      const atual = mapHoje.get(a.id);
      upserts.push({
        alocado_id: a.id,
        data: t.data,
        min_ativo: (atual?.min_ativo || 0) + pollMin,
        sinais: (atual?.sinais || 0) + 1,
        primeiro_sinal: atual?.primeiro_sinal || nowISO,
        ultimo_sinal: nowISO,
        atualizado_em: nowISO,
      });
    }
  }

  if (upserts.length) {
    const { error: uErr } = await supa.from("presenca_diaria").upsert(upserts, { onConflict: "alocado_id,data" });
    if (uErr) return new Response(JSON.stringify({ ok: false, error: uErr.message }), { status: 500, headers: cors });
  }

  return new Response(
    JSON.stringify({ ok: true, data: t.data, avaliados: alvo.length, ativos, semSlack, erros, gravados: upserts.length }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
