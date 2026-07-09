# Presença via Slack — deploy (Etapa 2)

Integração que alimenta o dashboard **Presença** do `index.html` com atividade real do Slack.

Fluxo: `cron (pg_cron)` → chama a Edge Function `slack-presence` a cada ~15 min na janela
de trabalho → consulta o Slack → acumula minutos ativos em `presenca_diaria` → o front lê
essa tabela (com fallback automático para dados mock enquanto ela estiver vazia).

## Passo a passo

### 1. Banco
Rode [`sql/presenca.sql`](sql/presenca.sql) no **SQL Editor** do Supabase. Cria:
- coluna `alocados.slack_user_id` (cache do ID do Slack)
- tabela `presenca_diaria` (agregado diário) + RLS de leitura para autenticados

### 2. App Slack / token
No [api.slack.com/apps](https://api.slack.com/apps) → seu app → **OAuth & Permissions**, garanta os **Bot Token Scopes**:
- `users:read`
- `users:read.email`

Copie o **Bot User OAuth Token** (`xoxb-...`).

### 3. Secret da função
No projeto (Project Settings → Edge Functions → Secrets), adicione:
```
SLACK_BOT_TOKEN = xoxb-...
```
> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetadas automaticamente.

### 4. Deploy da função
```bash
supabase functions deploy slack-presence
```

Teste manual (fora da janela de trabalho use `force`):
```bash
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/slack-presence' \
  -H 'Authorization: Bearer <ANON_OR_PUBLISHABLE_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"pollMin":15,"force":true}'
```
Resposta esperada: `{ ok:true, avaliados, ativos, gravados, ... }`.

### 5. Agendamento
Habilite `pg_cron` e `pg_net` em **Database → Extensions**, depois rode o bloco comentado
no final de [`sql/presenca.sql`](sql/presenca.sql) (ajuste `<PROJECT_REF>` e a chave).
O cron sugerido roda `*/15 12-21 * * 1-5` (UTC) = 09h–18h de São Paulo, seg–sex.

## Como o front reage
- Assim que `presenca_diaria` tiver linhas, o dashboard troca sozinho de **mock** para
  **Slack ao vivo** (o banner muda de cinza-verde para verde). Nada a alterar no código.
- Dia sem registro na tabela = alocado **Ausente** naquele dia (0 min).

## Ajustes finos (no `index.html`, objeto `PRES_CFG`)
- `feriados`: lista ISO (`['2026-01-01', ...]`) — dias que não contam ausência.
- `jornadaEsperadaMin` / `metaPresenteMin`: jornada e limiar de "Presente".
- `limiarAlertaDiasUteis`: dias úteis sem sinal para disparar alerta (hoje = 1).

## Notas / limitações
- `users.getPresence` do Slack é binário (`active`/`away`) e "away" pode ser apenas ociosidade.
  Por isso medimos por **amostragem**: cada poll com `active` soma `pollMin` minutos.
  Quanto menor o intervalo do cron, mais fina a medição (e mais chamadas à API).
- A função só avalia alocados **OneBrain**, ativos (`desligamento is null`) e com `company_email`.
- O `slack_user_id` é resolvido via `users.lookupByEmail` na 1ª execução e cacheado.

---

# Mapa de Faturamento (aba Mapa) — deploy

Alimenta a aba **Mapa** do `index.html`: bolhas por cliente no mapa do Brasil, tamanho ∝ faturamento.

Fluxo: planilha Google Sheets (`Cliente, Faturamento, Endereço, BU`) → Edge Function
[`sync-mapa`](functions/sync-mapa/index.ts) lê via **API do Google Sheets** (mesma
**service account** da `sync-faturamento`, sem publicar CSV), **geocodifica** o `Endereço`
via Nominatim/OSM → grava em `faturamento_geo` → o front lê a tabela.

O endereço da planilha é texto livre e bem "sujo" (razão social, bairro, UF repetida…), então
o geocoding usa um **fallback**: tenta pelo **CEP**; se não achar, tenta **"Cidade, Estado, Brasil"**
(cidade extraída do texto); valida que a **UF do resultado bate** com a UF do endereço (evita casar
cidade homônima em outro estado). A precisão fica em nível de **cidade** — suficiente pro mapa.

Um mesmo cliente pode aparecer em **BUs diferentes** (ex.: "Attivo" em Fast e Kolivo), então a
chave da tabela é **(cliente, bu)**. `BU` é livre (Fast, Kolivo, Onebrain, Outforce, Stoom…): o
front gera cores, filtro e legenda a partir dos valores que existem nos dados.

## Passo a passo

### 1. Banco
Rode [`sql/faturamento_geo.sql`](sql/faturamento_geo.sql) no **SQL Editor**. Cria a tabela
`faturamento_geo` (+ RLS de leitura para autenticados) e um **seed** de teste com ~15 clientes
já geocodificados — dá pra ver a aba Mapa funcionando **antes** de ligar o sync.

### 2. Compartilhar a planilha com a service account
A função lê pela API do Google usando a **mesma service account da `sync-faturamento`**
(secrets `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` já existem no projeto). Basta abrir a
planilha do mapa → **Compartilhar** → adicionar o e-mail de `GOOGLE_SA_EMAIL` como **Leitor**.
Cabeçalho esperado (acento/caixa não importam): `Cliente`, `Faturamento`, `Endereço`, `BU`.

### 3. Secrets da função (só 2 novos)
Em Project Settings → Edge Functions → Secrets:
```
MAPA_SHEET_ID    = <ID da planilha do mapa, tirado da URL /spreadsheets/d/<ID>/edit>
MAPA_SHEET_RANGE = Página1!A1:D200      (aba!intervalo; inclua o cabeçalho)
```
> `SB_URL`, `SB_SERVICE_ROLE_KEY`, `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` já são do projeto
> (reusados da `sync-faturamento`) — **não precisa recriar**.

### 4. Deploy
```bash
supabase functions deploy sync-mapa
```
Teste manual:
```bash
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-mapa' \
  -H 'Authorization: Bearer <ANON_OR_PUBLISHABLE_KEY>'
```
Resposta: `{ ok:true, total, geocodificados, do_cache, falhas, nao_geocodados:[...] }`.

### 5. Agendamento (opcional)
Bloco comentado no fim de [`sql/faturamento_geo.sql`](sql/faturamento_geo.sql) — sugestão
1x/dia às 08h de São Paulo. Requer `pg_cron` + `pg_net`.

## Notas
- **Geocoding**: só chama o Nominatim quando o `endereco` mudou (ou `lat` ainda é nula).
  Endereços já resolvidos vêm do **cache** da própria tabela → sync rápido e dentro do
  limite de ~1 req/s do Nominatim (`sleep` de 1,1s após cada chamada). Cada endereço novo
  pode fazer até 3 tentativas (CEP → cidade → última palavra da cidade).
- Clientes sem match no geocoding ficam com `geo_status='falha'` e voltam em `nao_geocodados`
  como `Cliente (BU)` (o front mostra num toast). O botão **↻ Sincronizar** na aba dispara a função.
- Como cada endereço novo custa ~1–3s, o **1º sync** de uma planilha grande demora
  (ex.: ~45 clientes ⇒ ~1–2 min). Os próximos são quase instantâneos (cache).
