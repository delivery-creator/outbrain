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
>
> Obs.: nomes de aba com **acento/espaço** precisam de aspas simples na notação A1
> (ex.: `'Página1'!A1:D200`). A função já faz esse aspeamento sozinha, então tanto
> `Página1!A1:D200` quanto `'Página1'!A1:D200` funcionam.

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

# Forecast (aba Forecast) — deploy

Alimenta a aba **Forecast** do `index.html` (realizado + forecast vs meta).
Fluxo: **uma** planilha Google Sheets com **uma aba por unidade**
(`forecast_Onebrain` e `forecast_Outforce`), layout **largo** — coluna A =
Cliente, uma coluna por mês "janeiro/26"…"dezembro/26" → Edge Function
[`sync-forecast`](functions/sync-forecast/index.ts) lê via **API do Google Sheets**
(mesma **service account** das outras syncs) → carga na tabela `forecast`.

Cada aba é a **fonte da verdade** da sua unidade/ano: para cada unidade lida
com sucesso a função **apaga** as linhas daquele `(ano, unidade)` e **reinsere**
(remove clientes/meses que saíram da planilha e o SEED antigo).

### 1. Tabela
Rode [`sql/forecast.sql`](sql/forecast.sql) no **SQL Editor** (cria a tabela `forecast`
+ RLS de leitura para autenticados; o SEED é só p/ teste e será sobrescrito).

### 2. Compartilhar a planilha com a service account
Abra a planilha → **Compartilhar** → adicione o e-mail de `GOOGLE_SA_EMAIL` como
**Leitor**. Layout esperado por aba: linha 1 com os meses (`janeiro/26`…`dezembro/26`),
coluna A com o nome do cliente. Linhas de total (`RECEITAS`) e placeholders (`CLIENTE`)
são ignoradas. As abas devem se chamar `forecast_Onebrain` e `forecast_Outforce`
(ou ajuste via `FORECAST_TAB_*`).

### 3. Secrets (Supabase > Project Settings > Edge Functions)
```
FORECAST_SHEET_ID     = <ID da planilha, da URL /spreadsheets/d/<ID>/edit>
FORECAST_TAB_ONEBRAIN = forecast_Onebrain   (opcional; é o default)
FORECAST_TAB_OUTFORCE = forecast_Outforce   (opcional; é o default)
FORECAST_RANGE        = A1:R300             (opcional; default já cobre o layout)
FORECAST_ANO          = 2026                (opcional; senão deriva do cabeçalho)
```
> `SB_URL`, `SB_SERVICE_ROLE_KEY`, `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` são
> reusados das outras syncs — **não precisa recriar**.

### 4. Deploy
```
supabase functions deploy sync-forecast
```
Teste manual:
```
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-forecast' \
  -H 'Authorization: Bearer <token>'
```
Resposta: `{ ok, total, fontes:[{ unidade, ok, ano, aba, registros, clientes, header }] }`.
O botão **↻ Sincronizar** na aba Forecast dispara a função.

## Notas
- **Geocoding**: só chama o Nominatim quando o `endereco` mudou (ou `lat` ainda é nula).
  Endereços já resolvidos vêm do **cache** da própria tabela → sync rápido e dentro do
  limite de ~1 req/s do Nominatim (`sleep` de 1,1s após cada chamada). Cada endereço novo
  pode fazer até 3 tentativas (CEP → cidade → última palavra da cidade).
- Clientes sem match no geocoding ficam com `geo_status='falha'` e voltam em `nao_geocodados`
  como `Cliente (BU)` (o front mostra num toast). O botão **↻ Sincronizar** na aba dispara a função.
- Como cada endereço novo custa ~1–3s, o **1º sync** de uma planilha grande demora
  (ex.: ~45 clientes ⇒ ~1–2 min). Os próximos são quase instantâneos (cache).

---

# Hunting (aba Hunting) — deploy

Alimenta a aba **Hunting** do `index.html`: KPIs de recrutamento, gráficos por status /
perfis / SLA e os blocos por tipo de contrato.

Fluxo: planilha Google Sheets (aba **`DADOS_HUNTING`**, uma linha = uma vaga) → Edge Function
[`sync-hunting`](functions/sync-hunting/index.ts) lê via **API do Google Sheets** (mesma
**service account** das outras syncs) → carga na tabela `hunting_vagas` → o front lê a tabela
e calcula os indicadores.

**Recorte de BU:** entram **apenas** as linhas com `BU` = **Outforce** ou **Onebrain**.
Fast, CSC, Kolivo etc. são descartadas no sync e nunca chegam aos indicadores.

### 1. Banco
Rode [`sql/hunting.sql`](sql/hunting.sql) no **SQL Editor**. Cria:
- `hunting_vagas` — dados crus da planilha (+ RLS de leitura para autenticados)
- `hunting_sync_log` — log de cada sincronização (auditoria **e** cache da função)

### 2. Compartilhar a planilha com a service account
Abra a planilha → **Compartilhar** → adicione o e-mail de `GOOGLE_SA_EMAIL` como **Leitor**.

Cabeçalho esperado na linha 1 da aba `DADOS_HUNTING` (acento/caixa não importam — as colunas
são localizadas **pelo nome**, não pela posição, então dá para reordenar/incluir colunas):

```
Posição | Valor Hora | SO Maquina | Hunting, CSC ou Outsourcing | BU | Prioridade |
Temperatura | Cliente | Vaga Nova ou Replace | Valor Salário | Contratado | Recrutador |
Gestor | Status | SLA (dias corridos) | Prazo | Aberta Em | Fechada Em | Enviada Em |
Congelada Em | Quantidade de Perfis
```

Indispensáveis: **BU, Cliente, Status, Aberta Em** — se alguma sumir, o sync falha com
mensagem explícita em vez de importar dados errados.

### 3. Secrets (todos opcionais — os defaults já apontam para a planilha atual)
```
HUNTING_SHEET_ID   = 1dKn6TLrgnp-WmjvyRzjbfHC_OY2pzXLR0tFbuwr7QU8   (default)
HUNTING_TAB        = DADOS_HUNTING                                  (default)
HUNTING_RANGE      = A1:Z2000                                       (default)
HUNTING_CACHE_MIN  = 10        -> janela de cache, em minutos        (default)
```
> `SB_URL`, `SB_SERVICE_ROLE_KEY`, `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` são
> reusados das outras syncs — **não precisa recriar**.

### 4. Deploy
```
supabase functions deploy sync-hunting
```
Teste manual:
```
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-hunting' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"force":true}'
```
Resposta: `{ ok, total, linhas_lidas, ignoradas, bus_ignoradas, clientes, header, duracao_ms }`.

### 5. Agendamento
Bloco comentado no fim de [`sql/hunting.sql`](sql/hunting.sql) — sugestão 2x/dia
(08h e 14h de São Paulo), seg–sex. Requer `pg_cron` + `pg_net`.

## Regras de negócio (implementadas em `HuntingRules`, no `index.html`)

| Indicador | Cálculo |
|---|---|
| SLA de envio | dias **úteis** entre `Aberta Em` e `Enviada Em` |
| Tempo de fechamento | dias **úteis** entre `Aberta Em` e `Fechada Em` |
| Média de abertura → envio | média do SLA de envio das vagas do recorte |
| Média de envio dos perfis | `Quantidade de Perfis` ÷ `Quantidade de vagas` (perfis por vaga) |

- **Dias úteis**: sábados e domingos não contam; mesma data = 0. Feriados **não** são
  considerados (a planilha não os informa).
- Registros com data faltando ou inconsistente (`Fechada Em` < `Aberta Em`) **não entram**
  nas médias — os cards mostram entre parênteses quantas vagas formaram cada média.
- **Tipo de contrato** (mapa `CONTRATO_POR_CLIENTE`, fácil de estender):
  `Nomad` → **Talent Pipeline Pro** · `Tenda` → **Squad** · demais clientes → **Essentials**.

## Notas
- **Cache**: a função não chama o Google se já houve sync OK há menos de `HUNTING_CACHE_MIN`
  minutos — responde `{ ok:true, cache:true }`. O botão **↻ Sincronizar** e o cron mandam
  `force:true` e ignoram o cache.
- **Fonte da verdade**: cada sync bem-sucedido apaga e reinsere a tabela, então vagas
  removidas da planilha somem do dashboard.
- **Datas sujas**: a planilha tem valores como `-46058` e `27/042026` nas colunas de data.
  Eles viram `null` (não calculam) em vez de gerar SLA absurdo.
- **Typos de BU**: `Ouforce` é aceito como `Outforce` — do contrário vagas reais seriam
  descartadas. BUs realmente de fora continuam sendo ignoradas e voltam contadas em
  `bus_ignoradas` na resposta do sync.
- **Front**: a aba carrega sob demanda (só ao ser aberta), memoiza os agregados por
  (versão dos dados + filtros) e se auto-atualiza a cada 15 min enquanto estiver visível.
  O botão **↻ Sincronizar** aparece apenas para o perfil **editor**.
