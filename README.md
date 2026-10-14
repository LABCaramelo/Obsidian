# Basalto

Editor de notas Markdown local, baseado em cofres (pastas comuns), no estilo do Obsidian.
É uma reimplementação independente: a arquitetura do Obsidian 1.14.4 foi estudada com o
MCP **REA** (veja [docs/RECONSTRUCAO.md](docs/RECONSTRUCAO.md)), mas todo o código foi
escrito do zero. Suas notas continuam sendo arquivos `.md` comuns, então dá para abrir um
cofre do Obsidian aqui (e vice-versa).

## Executar

### No Navegador (Web)

```bash
npm run web
```

Inicia o servidor local e abre o Basalto diretamente no navegador padrão em `http://localhost:3001` (ou na primeira porta livre).

### No Desktop (Electron)

```bash
npm install
npm start
```

`npm start` compila o renderer (`build.mjs`, esbuild) e abre o Electron. Para abrir uma pasta
direto como cofre: `npx electron . "C:\caminho\do\cofre"`. Use `npm run dev` para abrir com
as ferramentas de desenvolvedor.

Testes do núcleo (parser, resolução de links, busca, datas):

```bash
npm test
```

## Recursos

- **Cofres:** criar, abrir pasta como cofre, lista de recentes, reabre os cofres abertos.
- **Editor:** CodeMirror 6 com Live Preview (esconde a marcação fora da linha atual), caixas
  de tarefa clicáveis, imagens inline, fórmulas, autocompletar de `[[links]]` e `#tags`,
  modo Vim, dobra de títulos, colar/arrastar imagens como anexos.
- **Leitura:** wikilinks, `![[embeds]]` de notas, seções (`#Título`) e blocos (`#^id`),
  callouts (`> [!tip]`), `==destaque==`, `$matemática$`, Mermaid, notas de rodapé,
  propriedades do frontmatter, `%%comentários%%`.
- **Navegação:** abas, painéis divididos, voltar/avançar, troca rápida (Ctrl+O),
  paleta de comandos (Ctrl+P), visualização prévia ao passar o mouse com Ctrl.
- **Painéis:** arquivos, busca (`tag:` `path:` `file:` `"frase"` `-excluir` `/regex/`),
  tags aninhadas, backlinks e menções não vinculadas, links de saída, sumário.
- **Grafo:** simulação de forças, zoom/arraste, filtros (tags, anexos, órfãos,
  não resolvidos) e ajuste das forças.
- **Canvas (JSON Canvas):** quadro infinito para arquivos `.canvas` com cartões de texto,
  notas Markdown embutidas, mídias (imagens, áudio, vídeo, PDF), links web, grupos e conexões
  com setas; edição em tempo real, sincronização entre múltiplos painéis e atualização
  automática de caminhos ao renomear arquivos no cofre.
- **Favoritos (Bookmarks):** painel dedicado para organizar notas, pastas, buscas salvas e
  seções/títulos em grupos aninhados, com reorganização por arrastar e soltar e remapeamento
  automático ao mover arquivos.
- **Personalização de Atalhos:** gerenciamento completo de teclas de atalho com captura visual,
  detecção de conflitos e persistência isolada em `<cofre>/.basalto/hotkeys.json`.
- **Persistência Confiável:** salvamento atômico em disco, barreira de fechamento (*close barrier*)
  para garantir que nenhum dado seja perdido ao fechar abas ou sair da aplicação.
- **Arquivos:** renomear/mover atualizando os links, duplicar, excluir para a lixeira,
  notas diárias, modelos (`{{title}}`, `{{date}}`, `{{time}}`), exportar PDF.

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+N | Nova nota |
| Ctrl+O | Troca rápida |
| Ctrl+P | Paleta de comandos |
| Ctrl+E | Alternar leitura/edição |
| Ctrl+G | Grafo |
| Ctrl+Shift+F | Buscar em todos os arquivos |
| Ctrl+W / Ctrl+T | Fechar / nova aba |
| Ctrl+\\ | Dividir à direita |
| Ctrl+Alt+← / → | Voltar / avançar |
| Ctrl+B / Ctrl+I / Ctrl+K | Negrito / itálico / link |
| Ctrl+Shift+S / H / C | Tachado / destaque / código inline |
| Ctrl+Shift+K | Inserir link interno wikilink |
| Ctrl+L | Alternar caixa de tarefa |
| F2 | Renomear arquivo |
| Ctrl+, | Configurações |

## Estrutura

```
src/main/        processo principal: janelas, registro de cofres, acesso a arquivos, IPC
  main.js          ciclo de vida, protocolo vaultfile://, menu
  preload.js       ponte segura (contextBridge) para o renderer
  vault-fs.js      operações de arquivo limitadas ao cofre + monitoramento
  vault-registry.js lista de cofres conhecidos
src/renderer/    interface (empacotada pelo esbuild em dist/)
  core/            cofre, cache de metadados/links, parser, Markdown, busca, comandos
  editor/          CodeMirror, Live Preview, frontmatter
  views/           nota (edição/leitura), grafo, arquivos, aba vazia
  sidebar/         explorador, busca, tags, backlinks, links de saída, sumário
  workspace/       abas, painéis e histórico de navegação
  ui/              modais, menus, ícones, avisos
test/            testes do núcleo (node --test)
docs/            relatório da engenharia reversa
```

Configuração de cada cofre fica em `<cofre>/.basalto/` (`app.json`, `graph.json`,
`workspace.json`), separada da `.obsidian/`.
