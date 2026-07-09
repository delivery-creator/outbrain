-- ═══════════════════════════════════════════════════════════
-- Forecast de receita por cliente/mês (aba Forecast do Dashboard)
-- Mesma modelagem do faturamento_real, com a coluna `unidade`
-- (marca) porque clientes do forecast podem não ter alocados
-- para derivar a unidade. Populada pela Edge Function sync-forecast.
-- ═══════════════════════════════════════════════════════════
create table if not exists forecast (
  id       uuid primary key default gen_random_uuid(),
  ano      int  not null,
  unidade  text,                         -- 'OneBrain' | 'Outforce'
  cliente  text not null,
  mes      int  not null check (mes between 1 and 12),
  valor    numeric not null default 0,
  unique (ano, unidade, cliente, mes)
);

create index if not exists forecast_ano_idx on forecast(ano);

-- RLS: leitura para autenticados; escrita via service_role (Edge Function)
alter table forecast enable row level security;
drop policy if exists forecast_leitura on forecast;
create policy forecast_leitura on forecast
  for select using (auth.role() = 'authenticated');

-- ───────────────────────────────────────────────────────────
-- SEED opcional (valores dos PDFs de FORECAST jul–dez/2026).
-- Útil pra testar a aba antes de ligar o sync-forecast.
-- A Edge Function depois sobrescreve com o upsert por (ano,unidade,cliente,mes).
-- ───────────────────────────────────────────────────────────
insert into forecast (ano, unidade, cliente, mes, valor) values
  -- OneBrain — Nomad
  (2026,'OneBrain','Nomad',7,22008),(2026,'OneBrain','Nomad',8,44016),(2026,'OneBrain','Nomad',9,66024),
  (2026,'OneBrain','Nomad',10,88032),(2026,'OneBrain','Nomad',11,88032),(2026,'OneBrain','Nomad',12,88032),
  -- OneBrain — Corpay
  (2026,'OneBrain','Corpay',7,22008),(2026,'OneBrain','Corpay',8,44016),(2026,'OneBrain','Corpay',9,88032),
  (2026,'OneBrain','Corpay',10,154056),(2026,'OneBrain','Corpay',11,154056),(2026,'OneBrain','Corpay',12,154056),
  -- OneBrain — Voll
  (2026,'OneBrain','Voll',7,23000),(2026,'OneBrain','Voll',8,23000),(2026,'OneBrain','Voll',9,23000),
  (2026,'OneBrain','Voll',10,23000),(2026,'OneBrain','Voll',11,23000),(2026,'OneBrain','Voll',12,23000),
  -- OneBrain — Tenda
  (2026,'OneBrain','Tenda',10,11760),(2026,'OneBrain','Tenda',11,11760),(2026,'OneBrain','Tenda',12,11760),
  -- OneBrain — Tenda Força Tarefa (pontual)
  (2026,'OneBrain','Tenda Força Tarefa',7,85551),
  -- Outforce — Petz
  (2026,'Outforce','Petz',9,11600),(2026,'Outforce','Petz',10,11600),(2026,'Outforce','Petz',11,11600),(2026,'Outforce','Petz',12,11600)
on conflict (ano, unidade, cliente, mes) do update set valor = excluded.valor;
