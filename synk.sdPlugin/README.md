# synk.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Controla o soundboard **SYNK** pelo deck: tocar e parar sons, parar tudo, silenciar os efeitos e volume de 0 a 200 % no knob, com o estado de cada tecla atualizado em tempo real e animações de toque.

| Action | Controle | O que faz |
|---|---|---|
| **Play Sound** | Tecla | Toca um som. Opção: sobrepor ou reiniciar se já estiver tocando |
| **Play / Stop Sound** | Tecla | Toca; se já estiver tocando, para (decidido pelo próprio SYNK) |
| **Stop Sound** | Tecla | Para um som específico |
| **Stop All** | Tecla | Para todos os sons; borda vermelha e contador enquanto algo toca |
| **Mute Effects** | Tecla | Silencia/reativa os efeitos; o volume anterior é preservado |
| **Effects Volume** | Knob | Gira: volume dos efeitos de 0 a 200 % (passo de 1, 2, 5 ou 10 %). Aperta: mute |
| **SYNK Status** | Tecla | Conexão, versão do SYNK ou "Sem áudio"; aperta para reconectar na hora |

### Configuração

1. Abra o SYNK (versão que publica `%LOCALAPPDATA%\SYNK\ipc.json`).
2. Arraste as actions da categoria **SYNK** no Rise Mode Controller.
3. Nas teclas de som, escolha o som na lista com busca do painel de configuração. A lista vem do SYNK e se atualiza sozinha quando a biblioteca muda.

Cada tecla guarda **apenas o ID do som** (e o nome, como rótulo para quando o SYNK estiver fechado). Nunca guarda caminho de arquivo.

### Visual

- **Imagem e título são seus.** Se você colocar uma imagem na tecla pelo Rise Mode, o plugin a usa como base de tudo que desenha (ela não é mais substituída ao apertar). O plugin não escreve nenhum título: use o campo de título do Rise Mode.
- **Toque:** ao apertar a tecla afunda e escurece (e o som já dispara); ao soltar volta com efeito de mola, uma onda (verde = tocar, branca = parar, vermelha = parar tudo) e um ▶/■ que aparece e some.
- **Tocando:** borda verde "respirando" e barra de progresso embaixo mostrando quanto falta do som.
- **Erro:** a tecla treme com uma onda vermelha e mostra uma mensagem curta (Sem resposta, Som removido, Sem áudio...).
- **SYNK fechado:** teclas em cinza com a faixa **OFFLINE**; voltam sozinhas quando o SYNK abre.

### Como funciona

- Conversa com o engine local do SYNK por **named pipe** do Windows. Não há rede nem porta TCP.
- Lê `ipc.json` e `ipc.token` em `%LOCALAPPDATA%\SYNK` a cada tentativa de conexão e autentica com **HMAC-SHA256 challenge-response**: o SYNK prova primeiro que conhece o token, que nunca trafega no pipe. Token, nonces e provas nunca são gravados, logados ou enviados ao painel.
- Uma única conexão por processo; reconexão com backoff (250 ms a 5 s); timeouts em todas as chamadas; um `PLAY_SOUND` nunca é repetido automaticamente; uma tecla travada não bloqueia as outras.
- A conexão é fechada 30 s depois que nenhuma tecla do SYNK está na tela e reaberta quando uma aparece.
- Protocolo implementado a partir do contrato `STREAM_DECK_INTEGRATION.md` do SYNK (protocolo v1).
- As imagens personalizadas são lidas, somente leitura, dos perfis em `%APPDATA%\HotSpot\StreamDock\profiles` (o Rise Mode não as envia ao plugin); a pasta é observada para refletir trocas de imagem na hora.

### Build, testes e instalação

```powershell
cd synk.sdPlugin\plugin
npm install
npm test            # 69 testes: protocolo, reconexão, erros, imagens personalizadas, animações e as 7 actions ponta a ponta
npm run test:app    # a suíte ponta a ponta no app.exe real (Node 18.5), o mesmo runtime do Rise Mode
npm run build       # feche o Rise Mode Controller antes, senão EBUSY
```

`npm run test:engine` roda contra um `synk-engine.exe` real (áudio simulado, dados isolados em `%TEMP%`); aponte `SYNK_ENGINE_EXE` para o executável de desenvolvimento.

| Sintoma | Causa provável |
|---|---|
| Todas as teclas OFFLINE com o SYNK aberto | SYNK antigo, sem `ipc.json` |
| ATUALIZE | Versões de protocolo diferentes entre SYNK e plugin |
| Mute com a faixa "Indisponível" | SYNK sem suporte a mute dos efeitos |
| Campo de título não aparece numa tecla antiga | Arraste a action de novo da categoria **SYNK** |
| Qualquer outro erro | `plugin/log/*.log` na pasta instalada do plugin (sem segredos) |

---

## English

Controls the **SYNK** soundboard from the deck: play and stop sounds, stop everything, mute the effects and set their volume from 0 to 200 % on the knob, with every key's state updated in real time and touch animations.

| Action | Control | What it does |
|---|---|---|
| **Play Sound** | Key | Plays a sound. Option: overlap, or restart if it is already playing |
| **Play / Stop Sound** | Key | Plays; if it is already playing, stops it (decided by SYNK itself) |
| **Stop Sound** | Key | Stops one sound |
| **Stop All** | Key | Stops every sound; red border and a counter while something plays |
| **Mute Effects** | Key | Mutes/unmutes the effects; the previous volume is kept |
| **Effects Volume** | Knob | Turn: effects volume from 0 to 200 % (1, 2, 5 or 10 % steps). Press: mute |
| **SYNK Status** | Key | Connection, SYNK version or "Sem áudio" (no audio); press to reconnect now |

### Setup

1. Open SYNK (a build that publishes `%LOCALAPPDATA%\SYNK\ipc.json`).
2. Drag the actions from the **SYNK** category in Rise Mode Controller.
3. On sound keys, pick the sound from the searchable list in the settings panel. The list comes from SYNK and refreshes by itself when the library changes.

Each key stores **only the sound ID** (plus the name, as a label for when SYNK is closed). Never a file path.

### Look

- **Your image and title win.** If you set an image on the key in Rise Mode, the plugin uses it as the base of everything it draws (it is no longer replaced when pressed). The plugin never writes a title: use Rise Mode's title field.
- **Touch:** on press the key sinks and darkens (and the sound already fires); on release it springs back with a ripple (green = play, white = stop, red = stop all) and a ▶/■ that pops and fades.
- **Playing:** breathing green border and a progress bar along the bottom showing how much of the sound is left.
- **Error:** the key shakes with a red ripple and shows a short message (no response, sound removed, no audio...).
- **SYNK closed:** grey keys with an **OFFLINE** banner; they come back by themselves when SYNK opens.

### How it works

- Talks to the local SYNK engine over a Windows **named pipe**. No network, no TCP port.
- Reads `ipc.json` and `ipc.token` in `%LOCALAPPDATA%\SYNK` on every connection attempt and authenticates with **HMAC-SHA256 challenge-response**: SYNK proves first that it holds the token, which never crosses the pipe. The token, nonces and proofs are never stored, logged or sent to the settings panel.
- One connection per process; reconnection with backoff (250 ms to 5 s); timeouts on every call; a `PLAY_SOUND` is never retried automatically; a stuck key never blocks the others.
- The connection is closed 30 s after no SYNK key is on screen and reopened when one appears.
- Protocol implemented from SYNK's `STREAM_DECK_INTEGRATION.md` contract (protocol v1).
- Custom key images are read, read-only, from the profiles in `%APPDATA%\HotSpot\StreamDock\profiles` (Rise Mode does not send them to plugins); the folder is watched so image changes show up right away.

### Build, tests and install

```powershell
cd synk.sdPlugin\plugin
npm install
npm test            # 69 tests: protocol, reconnection, errors, custom images, animations and the 7 actions end to end
npm run test:app    # the end-to-end suite on the real app.exe (Node 18.5), the same runtime as Rise Mode
npm run build       # close Rise Mode Controller first, otherwise EBUSY
```

`npm run test:engine` runs against a real `synk-engine.exe` (simulated audio, data isolated in `%TEMP%`); point `SYNK_ENGINE_EXE` at the development build.

| Symptom | Likely cause |
|---|---|
| Every key OFFLINE while SYNK is open | Old SYNK build without `ipc.json` |
| ATUALIZE (update) | Protocol version mismatch between SYNK and the plugin |
| Mute shows "Indisponível" (unavailable) | The SYNK build has no effects mute |
| No title field on an older key | Drag the action again from the **SYNK** category |
| Any other error | `plugin/log/*.log` in the installed plugin folder (no secrets) |
