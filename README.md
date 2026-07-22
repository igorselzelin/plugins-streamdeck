# plugins-streamdeck

Plugins para dispositivos StreamDock (compatível com HotSpot StreamDock / Rise Mode). Cada pasta `*.sdPlugin` neste repositório é um plugin independente.

## spotify-nowplaying.sdPlugin

Mostra a capa do álbum tocando no Spotify diretamente no botão, com animação de play/pause e transição entre faixas.

### Configurar as credenciais do Spotify

O plugin precisa de um Client ID, Client Secret e Refresh Token do Spotify pra funcionar. Esses valores ficam em `plugin/config.js`, que **não é versionado** (está no `.gitignore`) — cada pessoa que rodar o plugin precisa gerar os seus próprios.

**1. Criar um app no Spotify Developer Dashboard**

1. Acesse https://developer.spotify.com/dashboard e faça login
2. Clique em "Create app"
3. Em "Redirect URI" adicione: `http://127.0.0.1:8888/callback`
4. Marque a API "Web API"
5. Salve e copie o **Client ID** e o **Client Secret** (em "Settings")

**2. Obter o Refresh Token**

Dentro de `spotify-nowplaying.sdPlugin/plugin/`, rode:

```powershell
node spotify_auth.js SEU_CLIENT_ID SEU_CLIENT_SECRET
```

Isso abre o navegador pra você autorizar o app na sua conta Spotify. Depois de autorizar, o terminal mostra o `REFRESH_TOKEN` obtido — copie esse valor.

**3. Criar o config.js**

Copie o template e preencha com os valores obtidos acima:

```powershell
cd spotify-nowplaying.sdPlugin\plugin
copy config.example.js config.js
```

Edite `config.js`:

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'seu client id',
    SPOTIFY_CLIENT_SECRET: 'seu client secret',
    SPOTIFY_REFRESH_TOKEN: 'seu refresh token',
    SPOTIFY_EXE: 'C:\\Caminho\\Para\\Spotify.exe' // caminho do executável do Spotify na sua máquina
};
```

### Build e instalação

O build compila o plugin num único bundle (via [`ncc`](https://github.com/vercel/ncc)) e copia automaticamente para a pasta de plugins do StreamDock (`%APPDATA%\HotSpot\StreamDock\plugins\`).

```powershell
cd spotify-nowplaying.sdPlugin\plugin
npm install
npm run build
```

**Importante: feche o Rise Mode Controller / StreamDock completamente antes de rodar o build.** Se o app estiver aberto, o processo de deploy trava tentando substituir arquivos em uso (`EBUSY`), o que pode deixar a pasta instalada incompleta (plugin aparece com ícone de interrogação no dispositivo). Depois do build, abra o app novamente.

Para confirmar que nenhum processo ficou pendurado antes de buildar:

```powershell
tasklist | findstr /i "Rise"
```

Se não retornar nada, pode buildar com segurança.
