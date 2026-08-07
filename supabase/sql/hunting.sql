-- ═══════════════════════════════════════════════════════════
-- Hunting — vagas de recrutamento (aba Hunting do Dashboard)
--
-- Cada linha da planilha DADOS_HUNTING = uma vaga. A tabela guarda os
-- dados CRUS da planilha (fonte da verdade); as regras de negócio
-- (dias úteis, tipo de contrato, KPIs) ficam no front, em um único
-- módulo documentado (HuntingRules no index.html).
--
-- Populada pela Edge Function `sync-hunting`, que importa APENAS as
-- linhas cuja BU seja Outforce ou OneBrain.
-- ═══════════════════════════════════════════════════════════

create table if not exists hunting_vagas (
  id             uuid primary key default gen_random_uuid(),
  linha          int  not null,              -- nº da linha na planilha (chave natural)
  posicao        text,
  valor_hora     numeric,
  so_maquina     text,
  modalidade     text,                       -- "Hunting, CSC ou Outsourcing" (cru)
  bu             text not null,              -- 'OneBrain' | 'Outforce' (canonizado)
  prioridade     text,
  temperatura    text,
  cliente        text not null,
  tipo_vaga      text,                       -- 'Vaga Nova' | 'Replace'
  valor_salario  text,                       -- texto livre na planilha ("12k a 14k")
  contratado     text,
  recrutador     text,
  gestor         text,
  status         text,                       -- Aberta|Fechada|Congelada|Cancelada|Enviada
  sla_planilha   text,                       -- coluna "SLA (dias corridos)" (cru, não confiável)
  prazo          text,                       -- 'Dentro do Prazo' | 'Fora do Prazo'
  aberta_em      date,
  fechada_em     date,
  enviada_em     date,
  congelada_em   date,
  qtd_perfis     int  not null default 0,    -- "Quantidade de Perfis"
  sincronizado_em timestamptz not null default now(),
  unique (linha)
);

create index if not exists hunting_vagas_cliente_idx on hunting_vagas(cliente);
create index if not exists hunting_vagas_bu_idx      on hunting_vagas(bu);
create index if not exists hunting_vagas_aberta_idx  on hunting_vagas(aberta_em);

-- RLS: leitura para autenticados; escrita só via service_role (Edge Function)
alter table hunting_vagas enable row level security;
drop policy if exists hunting_vagas_leitura on hunting_vagas;
create policy hunting_vagas_leitura on hunting_vagas
  for select using (auth.role() = 'authenticated');

-- ───────────────────────────────────────────────────────────
-- Log de sincronização (auditoria + cache: a função pula a chamada
-- ao Google Sheets se já houve sync OK dentro da janela de cache).
-- ───────────────────────────────────────────────────────────
create table if not exists hunting_sync_log (
  id            uuid primary key default gen_random_uuid(),
  executado_em  timestamptz not null default now(),
  ok            boolean not null,
  origem        text,                         -- 'manual' | 'cron' | 'cache'
  linhas_lidas  int  not null default 0,      -- linhas da planilha (sem cabeçalho)
  importadas    int  not null default 0,      -- linhas que entraram na tabela
  ignoradas     int  not null default 0,      -- fora das BUs / sem cliente / vazias
  duracao_ms    int,
  erro          text,
  detalhe       jsonb
);

create index if not exists hunting_sync_log_data_idx on hunting_sync_log(executado_em desc);

alter table hunting_sync_log enable row level security;
drop policy if exists hunting_sync_log_leitura on hunting_sync_log;
create policy hunting_sync_log_leitura on hunting_sync_log
  for select using (auth.role() = 'authenticated');

-- ═══════════════════════════════════════════════════════════
-- AGENDAMENTO (rode DEPOIS de implantar a Edge Function sync-hunting).
-- Requer pg_cron e pg_net habilitados em Database > Extensions.
-- Sugestão: 2x/dia (08h e 14h de São Paulo = 11h e 17h UTC), seg–sex.
-- ═══════════════════════════════════════════════════════════
-- select cron.schedule(
--   'sync-hunting-diario',
--   '0 11,17 * * 1-5',
--   $$
--   select net.http_post(
--     url     := 'https://krguuguykcomwzolouwa.supabase.co/functions/v1/sync-hunting',
--     headers := jsonb_build_object(
--                  'Content-Type','application/json',
--                  'Authorization','Bearer sb_publishable_k_ndyX4e80eFQZA4ZNTyxQ_G3iJ0Ufb'
--                ),
--     body    := jsonb_build_object('origem','cron','force',true)
--   );
--   $$
-- );
-- Conferir:  select jobid, schedule, jobname, active from cron.job where jobname='sync-hunting-diario';
-- Remover:   select cron.unschedule('sync-hunting-diario');
--
-- Últimos syncs:
--   select executado_em, ok, origem, linhas_lidas, importadas, ignoradas, duracao_ms, erro
--     from hunting_sync_log order by executado_em desc limit 20;
