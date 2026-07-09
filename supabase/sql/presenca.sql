-- ═══════════════════════════════════════════════════════════
-- Presença / atividade diária dos alocados (Etapa 2 — Slack real)
-- Rode no SQL Editor do Supabase.
-- ═══════════════════════════════════════════════════════════

-- 1) Cache do ID do usuário no Slack (evita lookupByEmail a cada execução)
alter table alocados
  add column if not exists slack_user_id text;

-- 2) Agregado de presença por alocado por dia
--    min_ativo é acumulado a cada execução da Edge Function (poll).
create table if not exists presenca_diaria (
  alocado_id     uuid not null references alocados(id) on delete cascade,
  data           date not null,
  min_ativo      int  not null default 0,
  primeiro_sinal timestamptz,
  ultimo_sinal   timestamptz,
  sinais         int  not null default 0,
  atualizado_em  timestamptz not null default now(),
  primary key (alocado_id, data)
);

create index if not exists presenca_diaria_data_idx on presenca_diaria(data);

-- 3) RLS: leitura para usuários autenticados; escrita só via service_role
--    (a Edge Function usa a service_role key e ignora RLS)
alter table presenca_diaria enable row level security;

drop policy if exists presenca_leitura on presenca_diaria;
create policy presenca_leitura on presenca_diaria
  for select using (auth.role() = 'authenticated');

-- ═══════════════════════════════════════════════════════════
-- 4) AGENDAMENTO (rode DEPOIS de fazer deploy da Edge Function)
--    Requer pg_cron e pg_net habilitados em Database > Extensions.
--    A cada 15 min, das 09h às 18h (São Paulo = UTC-3 -> 12–21 UTC), seg–sex.
--    A própria função ignora execuções fora da janela (checa o fuso SP).
-- ═══════════════════════════════════════════════════════════
select cron.schedule(
  'slack-presence-poll',
  '*/15 12-21 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://krguuguykcomwzolouwa.supabase.co/functions/v1/slack-presence',
    headers := jsonb_build_object(
                 'Content-Type','application/json',
                 'Authorization','Bearer sb_publishable_k_ndyX4e80eFQZA4ZNTyxQ_G3iJ0Ufb'
               ),
    body    := jsonb_build_object('pollMin', 15)
  );
  $$
);

-- Conferir se ficou agendado:
--   select jobid, schedule, jobname, active from cron.job where jobname = 'slack-presence-poll';
-- Ver últimas execuções:
--   select status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname='slack-presence-poll')
--   order by start_time desc limit 10;
-- Remover o agendamento:
--   select cron.unschedule('slack-presence-poll');
