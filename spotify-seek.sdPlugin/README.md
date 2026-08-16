# spotify-seek.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Action do tipo **Knob**: a rotação avança ou retrocede 5 segundos na faixa atual do Spotify (não pula para a faixa seguinte/anterior). Utiliza a Spotify Web API (`/me/player/seek`), consultando a posição de reprodução atual antes de calcular o novo ponto.

### Requisitos

- Node.js instalado, para executar `npm run build`
- Conta Spotify Premium (necessária para o comando de seek via Web API)
- As **mesmas credenciais** (Client ID, Client Secret, Refresh Token) utilizadas em [`spotify-nowplaying.sdPlugin`](../spotify-nowplaying.sdPlugin/README.md) — consulte o README daquele plugin para o procedimento de geração. Não é necessário registrar um novo app no Spotify nem reautorizar; basta reutilizar os três valores.

### Criação do config.js

```powershell
cd spotify-seek.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'seu client id',
    SPOTIFY_CLIENT_SECRET: 'seu client secret',
    SPOTIFY_REFRESH_TOKEN: 'seu refresh token'
};
```

### Build e instalação

```powershell
cd spotify-seek.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes de executar o build — caso contrário, o deploy falha com `EBUSY` e o plugin passa a exibir um ícone de interrogação no dispositivo. Reabra o app em seguida.

### Nota técnica

O formato exato do payload do evento `dialRotate` não é documentado publicamente para este SDK. A implementação assume a convenção adotada pela Elgato (`payload.ticks`, valor positivo indicando sentido horário), com alguns nomes de campo alternativos como fallback. Caso o seek não responda conforme esperado à rotação do knob, o payload bruto é registrado em `plugin/log/*.log` — ajuste `rotationSign()` em `plugin/index.js` de acordo com o que for observado.

---

## English

A **Knob** action: rotation moves the current Spotify track ±5 seconds (it does not skip to the next/previous track). It uses the Spotify Web API (`/me/player/seek`), fetching the current playback position before computing the new one.

### Requirements

- Node.js installed, to run `npm run build`
- A Spotify Premium account (required for the seek command via the Web API)
- The **same credentials** (Client ID, Client Secret, Refresh Token) used in [`spotify-nowplaying.sdPlugin`](../spotify-nowplaying.sdPlugin/README.md) — see that plugin's README for the generation procedure. There is no need to register a new Spotify app or re-authorize; simply reuse the same three values.

### Creating config.js

```powershell
cd spotify-seek.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'your client id',
    SPOTIFY_CLIENT_SECRET: 'your client secret',
    SPOTIFY_REFRESH_TOKEN: 'your refresh token'
};
```

### Build and install

```powershell
cd spotify-seek.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before running the build — otherwise the deploy step fails with `EBUSY` and the plugin ends up showing a question-mark icon on the device. Reopen the app afterward.

### Technical note

The exact payload shape of the `dialRotate` event is not publicly documented for this SDK. The implementation assumes the convention used by Elgato (`payload.ticks`, a positive value indicating clockwise rotation), with a few alternate field names as fallback. If seeking doesn't respond as expected to the knob's rotation, the raw payload is logged to `plugin/log/*.log` — adjust `rotationSign()` in `plugin/index.js` based on what is observed there.
