"""PlotWeaver tools in one Claude API call. Needs ANTHROPIC_API_KEY and PLOTWEAVER_API_KEY."""

import os
import anthropic

client = anthropic.Anthropic()

response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=2000,
    messages=[{"role": "user", "content": "Say 'Welcome to our store' in Hausa with Maryam's voice and give me the link."}],
    mcp_servers=[
        {
            "type": "url",
            "url": "https://mcp.plotweaver.app/mcp",
            "name": "plotweaver",
            "authorization_token": os.environ["PLOTWEAVER_API_KEY"],
        }
    ],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "plotweaver"}],
    betas=["mcp-client-2025-11-20"],
)
print(response.content[-1].text)
