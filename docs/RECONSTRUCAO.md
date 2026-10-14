# Relatório de engenharia reversa e reconstrução

Este documento registra o que foi levantado do Obsidian instalado com o **REA** (MCP `rea`)
e como isso orientou o **Basalto**, uma reimplementação *clean-room*: nenhum código, CSS,
ícone ou texto do Obsidian foi copiado. O Obsidian é software proprietário
(`"license": "UNLICENSED"` no `package.json` do pacote). Da análise saíram arquitetura,
formatos de arquivo e comportamento observável; o código do Basalto foi escrito do zero.

Legenda: **[O]** observado no artefato · **[I]** inferência · **[D]** decisão de design do Basalto.

## Alvo

| Item | Valor |
|---|---|
| Instalação | `D:\Obsidian\Obsidian.exe` (Electron) |
| Versão do app | 1.14.4 (`obsidian.asar/package.json`) [O] |
| `resources/app.asar` | SHA-256 `3b48654f…506dfd8`, 480 KB [O] |
| `resources/obsidian.asar` | SHA-256 `146ef847…b142b92f`, 27,5 MB [O] |

## Evidências REA

| Evidence ID | Operação | Conteúdo |
|---|---|---|
| `ev_55a4ec60ea55710dd52743c0d8f19c31634553a30e17b388e313017c2af8fd72` | `analyze_javascript_application` (app.asar) | Grafo do carregador: 19 arquivos JS analisados, 15 operações IPC, 2 addons nativos |
| `ev_a1cc890e8dc0300849663b5450d7dbd378beb96b15d06775a7f52e918dda96b0` | `analyze_javascript_application` (obsidian.asar) | Inventário completo; análise semântica de `app.js` **parcial** (timeout de 300 s após 1,12 M nós AST) |
| `ev_4fecee86aa88380eb2cebab4c2bfc31df834682de671ef383948b7c3ce95a40f` | `inspect_analysis_view` | Página de módulos do obsidian.asar (35 entradas) |
| `ev_546020ae655e9f39100908b850eb3cdc216d8e214bf5ad2051b7e5a8f4accd31` | `extract_artifact` | Extração verificada do obsidian.asar (368 arquivos) |
| `ev_71eee28fb369114b992285de8da97ebba1695dcdfdbb3b0ebb8ba43d6cbb2350` | `analyze_javascript_application` (main/starter/sim/enhance) | 47 canais IPC literais, 2 `BrowserWindow`, 3 páginas de renderer |

Limitações registradas pelo REA: toda a análise é estática (nada foi executado), a cobertura
semântica é parcial, e afirmações de alcançabilidade em tempo de execução não foram provadas.

## Arquitetura observada

### Dois pacotes ASAR [O]

- **`app.asar` — carregador.** `main.js`, `@electron/remote` e dois addons nativos:
  `btime` (data de criação de arquivos) e `get-fonts` (fontes do sistema). Os `.node`
  desempacotados têm hash diferente do declarado na integridade do ASAR [O]; provavelmente
  foram assinados depois do empacotamento [I].
- **`obsidian.asar` — o aplicativo.** `main.js` (processo principal, 204 KB), `starter.html/js`
  (seletor de cofres), `index.html` + `app.js` (3,9 MB, renderer principal), `worker.js`,
  `sim.js`, `i18n.js`, `help.js`, `enhance.js`, `quicklook.js`, `app.css` e `lib/` com
  CodeMirror (+ vim), PixiJS, Mermaid, MathJax, PDF.js, Prism, Moment, i18next, Turndown,
  Readability, Defuddle, Reveal e scrypt.
- A separação permite trocar o `obsidian.asar` sem reinstalar o executável; o canal IPC
  `copy-asar` aponta nessa direção [I].

### Janelas e páginas [O]

Duas construções de `BrowserWindow` no processo principal e três páginas de renderer:
`starter.html` (seletor de cofres), `index.html` (janela do cofre) e `help.html`.

### Superfície IPC do processo principal [O]

47 handlers com canal literal (`ipcMain.on`, exceto `register-cli`, que usa `handle`):

- **Cofres:** `vault`, `vault-list`, `vault-open`, `vault-remove`, `vault-move`, `vault-message`,
  `starter`, `sandbox`, `get-sandbox-vault-path`, `get-default-vault-path`
- **Sistema/arquivos:** `trash`, `open-url`, `open-file`, `file-url`, `desktop-dir`,
  `documents-dir`, `get-documents-path`, `resources`, `print-to-pdf`
- **Janela/menu:** `frame`, `set-menu`, `update-menu-items`, `render-menu`, `context-menu`,
  `set-icon`, `get-icon`, `is-closing`, `is-quitting`, `relaunch`, `disable-gpu`
- **Atualização:** `check-update`, `update`, `disable-update`, `latest-public-version`,
  `insider-build`, `copy-asar`, `version`
- **Outros:** `help`, `cli`, `register-cli`, `request-url` (proxy HTTP para o renderer),
  `create-browser-session`, `adblock-lists`, `adblock-frequency`, `policy`, `terms`, `set-language`

Uma busca textual no `app.js` mostra o renderer usando `ipcRenderer.sendSync` (síncrono) para
a maioria deles [O]. Isso exige `nodeIntegration` no renderer [I].

### Dados em disco [O]

- Registro de cofres em `%APPDATA%\obsidian\obsidian.json`:
  `{"vaults": {"<id hex 16>": {"path": "...", "ts": <epoch ms>, "open": true}}}`.
- Configuração por cofre em `<cofre>/.obsidian/`: `app.json`, `appearance.json`,
  `core-plugins.json`, `graph.json`, `workspace.json` (árvore `split → tabs → leaf`, com
  `state.type` `markdown`/`graph`/`file-explorer`…), além de `hotkeys.json`,
  `community-plugins.json` e outros nomes de arquivo encontrados no `app.js`.
- As chaves do `graph.json` (`showTags`, `hideUnresolved`, `showOrphans`, `centerStrength`,
  `repelStrength`, `linkStrength`, `linkDistance`, `textFadeMultiplier`, …) foram reaproveitadas
  no Basalto [D].

### Não determinado [I/desconhecido]

- Os detalhes internos do `app.js` (algoritmo exato de resolução de links, implementação do
  Live Preview, API de plugins): a análise semântica parou no timeout.
- O papel exato de `worker.js` (provavelmente indexação/parse de metadados) e de `sim.js`
  (provavelmente a simulação de forças do grafo, desenhado com PixiJS) é inferido pelo nome e
  pelas bibliotecas; não foi verificado em execução.

## Decisões do Basalto [D]

| Aspecto | Obsidian (observado/inferido) | Basalto |
|---|---|---|
| Segurança do renderer | `nodeIntegration` + `sendSync` + `@electron/remote` [I] | `contextIsolation`, `sandbox`, preload estreito com `invoke` assíncrono; todo acesso a arquivos é limitado ao cofre da janela |
| Carregamento de arquivos do cofre | `file-url` [O] | Protocolo próprio `vaultfile://<id>/<caminho>` com checagem de caminho |
| Registro de cofres | `obsidian.json` [O] | `vaults.json` no mesmo formato, em `%APPDATA%\Basalto` |
| Configuração do cofre | `.obsidian/` [O] | `.basalto/`, para não sobrescrever a configuração do Obsidian se o mesmo cofre for aberto nos dois |
| Editor | CodeMirror + modo vim [O] | CodeMirror 6 + `@replit/codemirror-vim`, Live Preview próprio |
| Grafo | PixiJS + `sim.js` [O/I] | `d3-force` + Canvas 2D |
| Matemática / código | MathJax / Prism [O] | KaTeX / highlight.js |
| Diagramas | Mermaid [O] | Mermaid (carregado sob demanda) |
| Idioma | i18next com vários idiomas [O] | Interface em pt-BR |

## Escopo implementado

Cofres (criar, abrir, lista de recentes, reabrir ao iniciar), explorador com arrastar e soltar,
abas e painéis divididos com histórico, editor com Live Preview, modo leitura com wikilinks,
embeds de notas/seções/blocos/imagens/PDF/áudio/vídeo, callouts, tarefas clicáveis,
matemática, Mermaid, notas de rodapé, propriedades (frontmatter), tags aninhadas, busca com
operadores, backlinks e menções não vinculadas, links de saída, sumário, grafo com filtros e
forças, troca rápida, paleta de comandos com personalização de atalhos e detecção de conflitos,
JSON Canvas completo (especificação 1.0 com cartões, notas, conexões, merge e remapeamento de links),
painel de Favoritos (Bookmarks com grupos aninhados e buscas salvas), persistência resiliente
com gravações atômicas e barreira de fechamento (*close barrier*), notas diárias, modelos,
renomear com atualização automática de links, colar imagens como anexos, exportação para PDF,
temas claro/escuro.

**Fora do escopo:** Sync oficial, Publish, Bases, API de plugins da comunidade, temas da
comunidade, web viewer, gravador de áudio, slides e versão mobile.
