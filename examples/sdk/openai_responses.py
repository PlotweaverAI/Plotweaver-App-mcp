"""PlotWeaver tools in one OpenAI Responses API call. Needs OPENAI_API_KEY and PLOTWEAVER_API_KEY."""

import os
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-6.2-astra",
    tools=[
        {
            "type": "mcp",
            "server_label": "plotweaver",
            "server_url": "https://mcp.plotweaver.app/mcp",
            "authorization": os.environ["PLOTWEAVER_API_KEY"],
            "require_approval": "never",
        }
    ],
    input="Translate 'Your parcel has arrived' into Yoruba and voice it with Adérónkẹ́.",
)
print(response.output_text)
