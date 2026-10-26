# claude-usage.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Duas actions do tipo **Keypad** mostrando os medidores reais do plano Pro/Max — os mesmos que aparecem em Configurações → Uso no app do Claude: **Claude Session (5h)** (janela rolante de 5 horas) e **Claude Weekly** (limite semanal). Cada botão mostra um anel de progresso colorido (verde/amarelo/vermelho) e o título alterna, ao clicar, entre **% usado** e **tempo até resetar** (apenas a maior unidade, ex: `4h`, `3d`, `45m`).

Os dados vêm do endpoint OAuth de uso (`/api/oauth/usage`) que o próprio Claude Code usa, autenticado com o token de `~/.claude/.credentials.json` — responde em ~300 ms, sem subir processo. A atualização é **em tempo real**: o plugin observa `~/.claude/projects` e busca o uso novamente ~1,5 s depois de qualquer atividade em qualquer sessão do Claude Code (VS Code, CLI, WSL), além de um poll de segurança a cada 30 s. Se o token expirar ou a API falhar, cai automaticamente para `claude -p "/usage" --output-format json --no-session-persistence` (**não** usar `--bare`: quebra a autenticação por assinatura).

### Build e instalação

```powershell
cd claude-usage.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes de executar o build — caso contrário, o deploy falha com `EBUSY` e o plugin passa a exibir um ícone de interrogação no dispositivo. Reabra o app em seguida.

---

## English

Two **Keypad** actions showing the real Pro/Max plan meters — the same ones shown in Settings → Usage in the Claude app: **Claude Session (5h)** (rolling 5-hour window) and **Claude Weekly** (weekly limit). Each button shows a colored progress ring (green/yellow/red), and the title toggles on click between **% used** and **time until reset** (largest unit only, e.g. `4h`, `3d`, `45m`).

Data comes from the OAuth usage endpoint (`/api/oauth/usage`) that Claude Code itself uses, authenticated with the token in `~/.claude/.credentials.json` — ~300 ms, no process spawn. Updates are **real-time**: the plugin watches `~/.claude/projects` and re-fetches usage ~1.5 s after any activity in any Claude Code session (VS Code, CLI, WSL), plus a 30 s safety-net poll. If the token has expired or the API fails, it automatically falls back to `claude -p "/usage" --output-format json --no-session-persistence` (do **not** add `--bare`: it breaks subscription auth).

### Build and install

```powershell
cd claude-usage.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before running the build — otherwise the deploy step fails with `EBUSY` and the plugin ends up showing a question-mark icon on the device. Reopen the app afterward.
