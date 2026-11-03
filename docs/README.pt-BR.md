# clustercode

**Um cluster de agentes de longa duração para o [OpenCode](https://github.com/anomalyco/opencode).**
O modelo escreve o próprio DAG de tarefas, o plugin devolve o turno ao fim de cada um,
os membros da equipe revezam os assentos e a fila roda até esvaziar.

[English](../README.md) · [简体中文](README.zh-CN.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português](README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## Por quê

O OpenCode V2 (API de plugins 2.x, `Plugin.define`) reescreveu a superfície de plugins: os da 1.x
não carregam mais. A V2 traz subagentes em segundo plano, compactação e aquecimento, mas não traz
as duas peças de que uma execução sem supervisão precisa:

1. **Continuação** — quando um turno termina, nada inicia o próximo. Você fica apertando Enter.
2. **Revezamento de assentos** — um agente faz tudo, em vez de planejador, programador, revisor e
   testador se alternarem.

O `clustercode` adiciona exatamente essas duas peças, mais as proteções que tornam razoável deixar
uma execução sozinha por 24 horas.

## Recursos

| Recurso | O que faz |
|---|---|
| **DAG de tarefas** | `dependsOn` entre tarefas. Uma tarefa só é executável quando todas as dependências estão `done`. |
| **Planejamento automático** | `cluster_auto({ goal })` chama o modelo uma vez, fora da sessão, para compilar um objetivo em DAG. |
| **Revezamento de assentos** | Membros são arquivos de agente reais (`clustercode-<id>.md`). O plugin troca de assento com `switchAgent` entre turnos. Uma tarefa pode fixar um membro. |
| **Portão de verificação** | Marcar `done` executa de verdade o comando `verify`. Código de saída diferente de 0 recusa a atualização e devolve a saída. |
| **Batimento de 24 h** | Com `heartbeat: true`, uma sessão ociosa é acordada após um intervalo de espera: uma execução interrompida continua sozinha. |
| **Proteções** | Trabalho em segundo plano, fila concluída, impasse, limite de turnos e estagnação, avaliados num único lugar e numa única ordem. |
| **Três pontos de entrada** | Servidor (hooks, ferramentas, RPC), TUI (status no rodapé + painel `/cluster`), Desktop (painel lateral + cápsula + menus). |
| **Anexar e repetir** | `cluster_plan({ append: true })` amplia uma fila em execução. `cluster_retry` devolve tarefas falhas para a fila. |

## Princípios de projeto

Sete regras, cada uma sustentada por um teste. [design.md](design.md) traça
princípio → módulo → teste e lista as diferenças deliberadas em relação ao projeto original.

1. **Um gatilho, um agendador.** O hook idle e o batimento chamam `decide()`.
2. **`resume: true` fecha o ciclo.** Sem ele, uma sessão ociosa espera um despertar que nunca vem.
3. **Evidência, não autoavaliação.** `done` executa o comando de aceitação.
4. **Parar diante de uma premissa quebrada.** Dependência falha não está satisfeita; grafo travado
   para com um motivo.
5. **Ceder por padrão.** Trabalho em segundo plano vem primeiro, permissões e retentativas são de
   outros plugins, e o cartão do sistema é constante para manter o cache do prompt.
6. **Arquivos são a API.** Um assento é um markdown gerenciado; arquivo escrito à mão nunca é tocado.
7. **Um único caminho de dados.** Snapshot → RPC → as duas interfaces, com os mesmos textos.

## Instalação

Clone e aponte o OpenCode para o **diretório** (não um arquivo) em `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

O host encontra cada metade via `package.json` → `exports`:

| exports | Metade | Conteúdo |
|---|---|---|
| `.` | servidor | ferramentas, hooks, comandos, RPC, batimento |
| `./tui` | terminal | segmento de status, painel `/cluster` |
| `./gui-experimental` | desktop | painel lateral, cápsula, menus (`dist/*.cjs`) |

Duas regras de operação:

- A metade desktop é **pré-compilada**. Rode `npm run build` após clonar, senão o painel não tem
  ponto de entrada.
- O host sonda os `exports` **só na inicialização**. Depois de mudar `exports` ou recompilar a
  interface, reinicie o servidor e o app desktop. `opencode reload` só relê a configuração.
  `npm run check:entry` verifica a sondagem antes de reiniciar.

Requer o host de plugins do OpenCode 2.x (`@opencode/plugin >= 2.0.27 < 3`). Os scripts de
desenvolvimento precisam de Node 22.18+.

## Início rápido

1. Reinicie o OpenCode para carregar o plugin.
2. Pressione **Shift+Tab** até o agente `clustercode`. Esse modo existe para isto: pedir ao modelo
   que entregue o trabalho à fila em vez de fazer tudo sozinho.
3. Peça algo, ou use as ferramentas direto:

```
cluster_auto({ "goal": "adicionar --json ao carregador de config, com testes e documentação" })
```

```
cluster_plan({
  "goal": "endurecer o importador",
  "tasks": [
    { "id": "t1", "title": "recusar arquivos acima de 10 MB", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "documentar o limite", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. Acompanhe: `/cluster` abre o painel. Na TUI o rodapé mostra
   `cluster 2/5 · turn 3 · coder`; no desktop, uma cápsula acima do compositor mostra o mesmo.
5. Freie com `/cluster-stop`, continue com `/cluster-resume`.

Conselho para a primeira execução: mantenha `maxRounds: 5` até confiar no plano. `maxRounds: null`
com permissões abertas realmente roda até a fila esvaziar.

## Ferramentas

| Ferramenta | Para que serve |
|---|---|
| `cluster_auto` | Um objetivo entra, um DAG é gerado, a execução começa. Cria a equipe padrão se não houver. |
| `cluster_plan` | Fila explícita: `dependsOn`, `verify`, `member`, `maxRounds`, `maxStagnant`, `heartbeat`, `append`. |
| `cluster_update` | Informa `pending` / `running` / `done` / `failed`. `done` passa pelo portão de verificação. |
| `cluster_status` | Turno, fila, próximo assento, tarefas bloqueadas, batimento, motivo da parada. |
| `cluster_team` | Cria ou substitui a equipe. `adoptCluster: true` assume um `clustercode.md` escrito à mão. |
| `cluster_retry` | Devolve tarefas falhas para `pending`, limpa o motivo da parada e continua. |

Comandos: `/cluster-stop`, `/cluster-resume`, `/cluster` (painel).

## Equipe padrão

Substitua com `cluster_team({ members: [...] })`. Cada membro aceita `id`, `role`, `color`, `extra`
e `model`.

| id | Trabalho | Observação |
|---|---|---|
| `architect` | Decompõe, fixa interfaces, escreve o plano | não escreve código de produção |
| `coder` | Implementa o plano | verifica a própria mudança |
| `reviewer` | Revisão somente leitura | o frontmatter nega chamadas `edit:*` |
| `tester` | Roda testes, reproduz falhas, prova os critérios | só acredita na saída real |

O assento `reviewer` é restrição de **política**, não sandbox. Se um agente não pode tocar o sistema
de arquivos, limite no nível do sistema operacional.

Os agentes membros são escritos como `mode: primary` + `hidden: true`: não incham o seletor de
Shift+Tab e só o `clustercode` fica visível. `switchAgent` não verifica esses campos, então ocultar
não impede o revezamento. Reduzir a equipe apaga os arquivos gerenciados que sobraram e preserva os
escritos à mão; para remover tudo, apague `clustercode*.md` em `~/.config/opencode/agents`.

## Como um turno funciona

```
experimental.idle
   ├─ ainda há trabalho em segundo plano? → esperar (ele nos acorda ao terminar)
   ├─ fila concluída?                     → parar (finished)
   ├─ grafo em impasse?                   → parar (deadlock)
   ├─ limite de turnos atingido?           → parar (max-rounds)
   ├─ o próximo turno estagnaria?          → parar (stagnant)
   └─ caso contrário
        switchAgent(próximo assento)  → o cursor só avança em caso de sucesso
        round += 1, salvar, publicar o snapshot
        synthetic({ resume: true, text: "turno N, tarefa tX, informe com cluster_update" })
```

`resume: true` é a peça central. Sem ele, o texto injetado espera um próximo despertar que uma
sessão ociosa nunca recebe: a execução para em silêncio. O batimento usa a mesma função `decide()`,
então um cluster que atingiu o limite também para ali, em vez de acordar um turno extra.

## Arquitetura

```
core (puro, testável)
  state.ts      DAG, revezamento, contadores, impressão digital do estado
  scheduler.ts  decide() + commit(): a ordem das proteções, uma vez só
  plan.ts       objetivo → DAG, reparo de JSON, detecção de ciclo
  store.ts      persistência com cache e escritas serializadas + FileStorage
        │
servidor (src/index.ts)
  hook idle · cartão de sistema · comandos · ferramentas · batimento · RPC de snapshot
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI (src/tui.tsx)                 Desktop (dist/gui-experimental.cjs)
   status + painel /cluster           painel lateral + cápsula + comandos
```

As duas metades de interface só leem o RPC. Não tocam na memória nem no disco do servidor, então um
desktop ligado a um servidor remoto se comporta como local. Compartilham os textos de `status.ts`,
então rodapé e painel não podem discordar.

## Proteções e custo

- **Estagnação**: 12 turnos sem mudança de status por padrão. `maxStagnant: 0` desativa; aí
  `maxRounds` é a única rede.
- **Limite de turnos**: `null` por padrão. Defina nas primeiras execuções.
- **Impasse**: um ciclo ou dependência falha para a execução na hora, com explicação, em vez de girar
  até o contador de estagnação.
- **Batimento**: ligado por padrão no `cluster_auto`, desligado no `cluster_plan`. Intervalo mínimo
  15 s, padrão 60 s. Respeita o limite e a estagnação.

Tudo é avaliado em `decide()`; não existe segunda cópia das regras.

## Coexistência

O clustercode deliberadamente não ocupa áreas que outro plugin já pode cuidar:

| Área | Dono |
|---|---|
| Permissões, timeouts longos de shell | seu plugin de permissões (`permission.evaluate` nunca é registrado) |
| Retentativas com espera | seu plugin de retentativas (`retry` nunca é registrado: dois plugins escrevendo `event.decision` é cara ou coroa) |
| Prompt do sistema | o host; o clustercode apenas anexa um cartão constante, uma vez por turno |
| Modelo por assento | você, pelo campo `model` do membro |

Dois plugins que registram `retry` não podem ganhar juntos: o último registro decide. É por isso
que este fica de fora.

## Verificado

```
npm run check
  typecheck (tsc --noEmit, TSX incluído)
  187 asserções (node --test, sem modelo, sem rede)
  build: dist/gui-experimental.cjs + checagem de compilação da TUI
  sondagem de entradas: servidor / tui / desktop resolvidos
  fiação da TUI + fiação do desktop
```

O que essas checagens **não** provam: a renderização real (precisa de uma TUI ou do app desktop) e
uma execução completa sem supervisão com modelo real (precisa de tokens).

## Desenvolvimento

```powershell
npm install
npm run check        # tudo acima, em ordem
npm run test         # só as asserções
npm run typecheck
npm run build        # bundle desktop + checagem da TUI
npm run check:entry  # reproduz a sondagem de exports do host
```

Os testes redirecionam o diretório de agentes com `CLUSTERCODE_AGENTS_DIR`, então nunca escrevem no
seu `~/.config/opencode/agents`.

`docs/development.md` explica a cópia de referência do código do OpenCode em `opencode/` e como
revisar a API do host contra ela.

## Limitações conhecidas

- **Sequencial, uma faixa por sessão.** O cluster executa um turno por vez; o paralelismo é dos
  subagentes em segundo plano, a quem o hook idle cede passagem de propósito.
- **`cluster_plan` substitui a fila** a menos que você passe `append: true`.
- **`experimental.idle` é experimental.** Uma atualização do host pode mudar a forma; depois de
  atualizar, rode `npm run check`.
- **O portão de verificação é política**, não sandbox: ele executa um comando de shell.
- **O schema de saída RPC precisa listar todos os campos do snapshot.** O host decodifica como objeto
  fechado: um campo faltando gera `rpc.invalid_output` e painéis vazios. `test/rpc.test.ts` compara a
  carga real com o schema.
- **String vazia significa "nenhum"**: `currentMember`, `stoppedReason`, `member`, `color` e `verify`
  valem `""`, nunca `null`.
- **Renderização exige reinício**: o host só sonda as entradas na inicialização.

## Linhagem

`clustercode` é uma reescrita independente das ideias do **无限制 agent 群**
(`unlimited-agent-cluster`), um plugin OpenCode V2 escrito em chinês. O que muda aqui:

- Textos, comentários e documentação em inglês.
- Nomes `clustercode` / `clustercode-<id>`, para os dois plugins conviverem sem sobrescrever agentes.
- Um único `decide()` para o hook idle e o batimento, em vez de duas cópias da ordem das proteções.
- `stoppedCode` legível por máquina junto do motivo humano.
- `append` incremental e `cluster_retry`.
- Um teste de cobertura do schema RPC, que era justamente o bug que esvaziava os dois painéis.

## Licença

MIT. Veja [LICENSE](../LICENSE).
