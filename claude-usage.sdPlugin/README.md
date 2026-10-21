# claude-usage.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Duas actions do tipo **Keypad** mostrando os medidores reais do plano Pro/Max — os mesmos que aparecem em Configurações → Uso no app do Claude: **Claude Session (5h)** (janela rolante de 5 horas) e **Claude Weekly** (limite semanal). Cada botão mostra um anel de progresso colorido (verde/amarelo/vermelho) e o título alterna, ao clicar, entre **% usado** e **tempo até resetar** (ex: `4h 12m`, `3d 22h`).

Esse dado não existe em nenhum arquivo local nem API documentada — é obtido rodando `claude -p "/usage" --output-format json --no-session-persistence` (o mesmo comando `/usage` que você digitaria na REPL do Claude Code, só que sem interação). É uma chamada gratuita e local (não conta como uma requisição de verdade ao modelo, não afeta a própria cota que está sendo medida) e `--no-session-persistence` evita deixar um transcript órfão em `~/.claude/projects/`. **Importante:** não usar `--bare` nesse comando — ele força autenticação só por API key e quebra a leitura via assinatura OAuth.

Faz polling a cada 60 segundos (essas cotas mudam devagar, não precisa ser mais rápido — e cada chamada já tem ~1-2s de overhead de subir o processo do CLI). O horário de reset vem no formato "Aug 20, 3:10am (America/Sao_Paulo)" e é interpretado como horário local desta máquina (sem conversão real de timezone — assume que a máquina roda no mesmo fuso do texto).

### Build e instalação

```powershell
cd claude-usage.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes de executar o build — caso contrário, o deploy falha com `EBUSY` e o plugin passa a exibir um ícone de interrogação no dispositivo. Reabra o app em seguida.

---

## English

Two **Keypad** actions showing the real Pro/Max plan meters — the same ones shown in Settings → Usage in the Claude app: **Claude Session (5h)** (rolling 5-hour window) and **Claude Weekly** (weekly limit). Each button shows a colored progress ring (green/yellow/red), and the title toggles on click between **% used** and **time until reset** (e.g. `4h 12m`, `3d 22h`).

This data doesn't exist in any local file or documented API — it's obtained by running `claude -p "/usage" --output-format json --no-session-persistence` (the same `/usage` command you'd type in the Claude Code REPL, just without interaction). It's a free, local call (doesn't count as a real request to the model, doesn't affect the very quota it's reporting), and `--no-session-persistence` avoids leaving an orphan transcript file in `~/.claude/projects/`. **Important:** do not add `--bare` to that command — it forces API-key-only auth and breaks OAuth/subscription-based lookups.

Polls every 60 seconds (these quotas move slowly, no need to go faster — and each call already has ~1-2s of CLI process startup overhead). The reset time comes formatted like "Aug 20, 3:10am (America/Sao_Paulo)" and is interpreted as local wall-clock time on this machine (no real timezone conversion — assumes the machine runs in the same zone as the printed label).

### Build and install

```powershell
cd claude-usage.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before running the build — otherwise the deploy step fails with `EBUSY` and the plugin ends up showing a question-mark icon on the device. Reopen the app afterward.
