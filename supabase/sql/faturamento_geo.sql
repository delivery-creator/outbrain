-- ═══════════════════════════════════════════════════════════
-- Faturamento por cliente com localização geográfica (aba Mapa).
-- Fonte: planilha Google Sheets (colunas Cliente, Faturamento, Endereço, BU).
-- A Edge Function `sync-mapa` lê a planilha, geocodifica o Endereço via
-- Nominatim/OSM (endereço → lat/lng + cidade/UF) e popula esta tabela.
-- O front (renderMapa) plota uma bolha por cliente, tamanho ∝ faturamento.
-- ═══════════════════════════════════════════════════════════
create table if not exists faturamento_geo (
  id           uuid primary key default gen_random_uuid(),
  cliente      text not null,
  bu           text not null default '',      -- BU/marca (Fast, Kolivo, Onebrain, Outforce, Stoom...)
  faturamento  numeric not null default 0,
  endereco     text,                           -- texto livre vindo da planilha
  cidade       text,
  uf           text,                            -- sigla de 2 letras (ex.: 'SP')
  estado       text,                             -- nome por extenso
  lat          numeric,
  lng          numeric,
  geo_status   text default 'pendente',          -- 'ok' | 'falha' | 'pendente'
  updated_at   timestamptz not null default now(),
  -- o mesmo cliente pode aparecer em BUs diferentes (ex.: "Attivo" em Fast e Kolivo)
  unique (cliente, bu)
);

-- ───────────────────────────────────────────────────────────
-- Auto-correção do schema: se a tabela já existia de uma versão anterior
-- (quando a chave única era só `cliente`), ajusta para (cliente, bu).
-- ───────────────────────────────────────────────────────────
alter table faturamento_geo add column if not exists bu text;
update faturamento_geo set bu = '' where bu is null;
alter table faturamento_geo alter column bu set default '';
alter table faturamento_geo alter column bu set not null;
alter table faturamento_geo drop constraint if exists faturamento_geo_cliente_key;   -- unique antigo em (cliente)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'faturamento_geo_cliente_bu_key') then
    alter table faturamento_geo add constraint faturamento_geo_cliente_bu_key unique (cliente, bu);
  end if;
end $$;

create index if not exists faturamento_geo_bu_idx on faturamento_geo(bu);

-- RLS: leitura para autenticados; escrita só via service_role (Edge Function)
alter table faturamento_geo enable row level security;
drop policy if exists faturamento_geo_leitura on faturamento_geo;
create policy faturamento_geo_leitura on faturamento_geo
  for select using (auth.role() = 'authenticated');

-- ───────────────────────────────────────────────────────────
-- SEED opcional — algumas linhas já geocodificadas para testar a aba Mapa
-- ANTES de ligar o sync-mapa. A Edge Function depois sobrescreve por `cliente`.
-- ───────────────────────────────────────────────────────────
insert into faturamento_geo (cliente, bu, faturamento, cidade, uf, estado, lat, lng, geo_status) values
  ('Tenda 1',  'Onebrain', 4428419.87, 'Guarulhos',      'SP', 'São Paulo',        -23.4538, -46.5333, 'ok'),
  ('Nomad',    'Onebrain', 2660113.40, 'São Paulo',      'SP', 'São Paulo',        -23.5700, -46.6920, 'ok'),
  ('Sympla',   'Onebrain', 2461579.00, 'Belo Horizonte', 'MG', 'Minas Gerais',     -19.9391, -43.9386, 'ok'),
  ('Picpay',   'Onebrain', 1575152.00, 'São Paulo',      'SP', 'São Paulo',        -23.5470, -46.7360, 'ok'),
  ('Corpay',   'Onebrain',  514176.00, 'São Paulo',      'SP', 'São Paulo',        -23.5100, -46.8400, 'ok'),
  ('Petz 1',   'Outforce', 4936299.66, 'São Paulo',      'SP', 'São Paulo',        -23.5320, -46.6080, 'ok'),
  ('Comolatti', 'Outforce', 543006.84, 'São Paulo',      'SP', 'São Paulo',        -23.5390, -46.6180, 'ok'),
  ('Starrett', 'Kolivo',    573892.26, 'Itu',            'SP', 'São Paulo',        -23.2640, -47.2990, 'ok'),
  ('Localiza', 'Kolivo',    630989.28, 'Belo Horizonte', 'MG', 'Minas Gerais',     -19.8300, -43.9600, 'ok'),
  ('Agro Amazônia', 'Fast', 595497.61, 'Cuiabá',         'MT', 'Mato Grosso',      -15.6020, -56.1010, 'ok'),
  ('Slice Pay', 'Fast',     262662.50, 'São Paulo',      'SP', 'São Paulo',        -23.5900, -46.6720, 'ok'),
  ('Terra Zoo', 'Fast',     129474.46, 'São Luís',       'MA', 'Maranhão',          -2.5300, -44.2960, 'ok'),
  ('Unidasul', 'Stoom',      31115.44, 'Porto Alegre',   'RS', 'Rio Grande do Sul', -30.0050, -51.2010, 'ok'),
  ('Soho',     'Stoom',       2385.00, 'Goiânia',        'GO', 'Goiás',            -16.6960, -49.2750, 'ok'),
  ('VCA',      'Stoom',       1365.00, 'Vitória da Conquista', 'BA', 'Bahia',      -14.8770, -40.8180, 'ok')
on conflict (cliente, bu) do update set
  faturamento = excluded.faturamento,
  endereco    = excluded.endereco,
  cidade      = excluded.cidade,
  uf          = excluded.uf,
  estado      = excluded.estado,
  lat         = excluded.lat,
  lng         = excluded.lng,
  geo_status  = excluded.geo_status,
  updated_at  = now();

-- ═══════════════════════════════════════════════════════════
-- AGENDAMENTO opcional (rode DEPOIS do deploy da Edge Function sync-mapa).
-- Requer pg_cron e pg_net habilitados em Database > Extensions.
-- Sugestão: 1x por dia às 08h de São Paulo (11h UTC), seg–sex.
-- ═══════════════════════════════════════════════════════════
-- select cron.schedule(
--   'sync-mapa-diario',
--   '0 11 * * 1-5',
--   $$
--   select net.http_post(
--     url     := 'https://krguuguykcomwzolouwa.supabase.co/functions/v1/sync-mapa',
--     headers := jsonb_build_object(
--                  'Content-Type','application/json',
--                  'Authorization','Bearer sb_publishable_k_ndyX4e80eFQZA4ZNTyxQ_G3iJ0Ufb'
--                )
--   );
--   $$
-- );
-- Conferir:  select jobid, schedule, jobname, active from cron.job where jobname='sync-mapa-diario';
-- Remover:   select cron.unschedule('sync-mapa-diario');
