# Examples

Ready-to-copy configuration. Every file reads your key from `PLOTWEAVER_API_KEY` (or asks for it), so none of them ever holds a key and all are safe to commit.

| File | Where it goes |
|---|---|
| [`claude-code/.mcp.json`](claude-code/.mcp.json) | The root of a project, to share PlotWeaver with everyone working on it in Claude Code |
| [`cursor/mcp.json`](cursor/mcp.json) | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) |
| [`vscode/mcp.json`](vscode/mcp.json) | `.vscode/mcp.json` in a workspace. VS Code asks for the key once and stores it securely |
| [`windsurf/mcp_config.json`](windsurf/mcp_config.json) | Windsurf's MCP config file (Cascade, **Open MCP config file**) |
| [`sdk/claude_api.py`](sdk/claude_api.py) | PlotWeaver as a tool in the Claude API |
| [`sdk/openai_responses.py`](sdk/openai_responses.py) | PlotWeaver as a tool in the OpenAI Responses API |

Set the key once in your shell profile:

```bash
export PLOTWEAVER_API_KEY="pw_prod_..."
```

Create keys in the [PlotWeaver dashboard](https://app.plotweaver.app) under **API Keys**. Claude, ChatGPT and Claude Code can also connect with **Sign in with PlotWeaver**, with no key at all: see the guides in [`../docs`](../docs).
