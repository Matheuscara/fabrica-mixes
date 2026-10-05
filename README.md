# Fábrica de Mixes

Site que roda no servidor e monta mixes longos pro YouTube. Você envia músicas e imagens/loops por
canal; o sistema reserva **N músicas do mesmo estilo + 1 visual** num rascunho. Revise músicas,
ordem, visual e miniatura antes de aprovar o render. O vídeo pronto fica disponível para baixar.

## Como funciona

- **Canal** = um canal do YouTube. Cada um tem as próprias músicas, visuais e vídeos.
- **Navegação**: cada canal tem páginas separadas na barra lateral — visão geral, vídeos, produção,
  envio, músicas, visuais e ajustes. No celular, abra pelo botão "Menu do canal".
- **Kanban de vídeos**: Rascunho → Produção → Pronto → Agendado → Publicado (e Erro).
  Só a sua aprovação coloca o rascunho na fila de render. Depois você registra download, data
  planejada, link e data da publicação no YouTube. A publicação no YouTube é manual.
- **Visão geral**: gráficos mostram vídeos por etapa e músicas novas/usadas por estilo. Barras e cartões
  entram suavemente na tela; movimento reduzido desliga as animações. Os gráficos se reorganizam no celular.
- **Estilo**: toda música tem um estilo (ex.: `lofi-jazz-lounge`). Um vídeo nunca mistura estilos.
  Arrastando uma pasta no site, o estilo é o nome da pasta onde a música está.
- **Prompt por estilo**: na página Músicas, crie o estilo e salve seu prompt de geração; você pode
  editar e copiar depois. Estilos antigos e estilos criados pelo envio de uma pasta aparecem sem prompt
  até serem preenchidos. O site guarda a receita atual, mas não gera músicas: o gerador local
  ainda lê seus próprios arquivos de prompt, sem sincronização automática com este campo.
- **Sem duplicação**:
  - arquivo com o mesmo conteúdo (hash) no mesmo canal é ignorado no envio;
  - música ou visual que já está em algum vídeo não é sorteado de novo (a não ser que você ligue
    "reaproveitar" nas configurações do canal; aí vão as menos usadas primeiro);
  - descartar um vídeo libera as músicas e o visual dele; vídeo publicado continua contando como usado.
- **Render sem GPU**: cada imagem/vídeo é convertido uma vez num loop 1080p30 (barras pretas se não for 16:9).
  Depois, todo render só copia esse loop e codifica o áudio: ~1–2 min por hora de mix numa CPU comum.
- **Automático** (por canal): mantém até X rascunhos ou vídeos não publicados. Ele reserva material
  novo, mas **nunca renderiza sem revisão e aprovação**. Se houver vídeo com erro, pausa até resolver.
- Cada vídeo mostra o visual usado e as músicas com o tempo de início (tracklist pronta pra copiar).

## Onde roda hoje

- **VM 140 `fabrica-mixes` no pve2** (`192.168.4.70`, Debian 13, 4 vCPU, 4 GB). Dados em disco separado de 150 GB
  montado em `/srv/fabrica` (`/srv/fabrica/data` → `/data` no container).
- Gerenciada pelo **Dokploy** (pve1) como servidor remoto `fabrica-mixes`; projeto/compose `fabrica-mixes`,
  fonte GitHub `main`, com deploy automático. Senha e `DATA_PATH` ficam na aba Environment do compose.
- Site: `http://192.168.4.70:8080`.

## Instalar em outro servidor (sem Dokploy)

Use uma VM ou um container LXC Debian com Docker (com `nesting=1` no LXC), não o host do Proxmox direto.
O repositório é privado: rode `gh auth login` (ou cadastre uma deploy key) antes do clone.

```sh
git clone https://github.com/Matheuscara/fabrica-mixes.git
cd fabrica-mixes
cp .env.example .env    # defina APP_PASSWORD e onde ficam os dados (DATA_PATH)
docker compose up -d --build
```

Abra `http://<ip-do-servidor>:8080`. Vídeo de 1 h ocupa ~1–2 GB: depois de publicar, use "Apagar arquivo".

Atualizar depois de um `git push`:

```sh
git pull && docker compose up -d --build
```

## Mandar arquivos do PC

Pelo site: selecione um estilo existente para músicas soltas ou escolha **Criar novo estilo**.
Ao arrastar `musicas-geradas/<estilo>/`, as músicas herdam o nome da pasta; imagens e vídeos curtos
em loop entram como visuais do canal.

Pelo terminal (o número do canal está na URL, `/channels/<id>`):

```sh
for f in canais/MeuCanal/musicas-geradas/lofi-jazz-lounge/*.mp3; do
  curl -u x:SENHA -F style=lofi-jazz-lounge -F "file=@$f" http://<servidor>:8080/channels/1/upload
done
```

Formatos: áudio `mp3 wav flac m4a aac ogg opus`; imagem `jpg png webp bmp`; vídeo `mp4 mov webm mkv m4v avi gif`.

## Desenvolvimento

Precisa de Node ≥ 22.18 e ffmpeg no PATH.

```sh
npm install
DATA_DIR=/tmp/fabrica npm run dev   # http://localhost:8080
npm run typecheck
```

Código em `src/`: `jobs.ts` (sorteio, fila, automático, worker), `media.ts` (ffmpeg),
`library.ts` (upload e exclusão), `views.ts` (HTML), `server.ts` (rotas). Banco SQLite em `$DATA_DIR/app.db`.
