# moon-animator (Claude Code plugin)

Bundles two things for working with Moon Animator 2 in Roblox Studio:

- the `moon-animator-mcp` MCP server, started through
  `npx -y github:DeepTutorAi/moon-animator-mcp`, which gives the agent tools to
  see, measure and author animations and cutscenes;
- the `moon-animator` skill, a field guide that teaches the agent the working
  loop, joint conventions and tested recipes.

## Install

```
/plugin install moon-animator --marketplace DeepTutorAi/moon-animator-mcp
```

## Setup

1. Install Moon Animator 2 from the Roblox Creator Store. It is a separate
   product and is not included.
2. Install the MoonBridge Studio plugin, then restart Roblox Studio and allow
   its HTTP requests to `127.0.0.1`:

   ```powershell
   npx -y github:DeepTutorAi/moon-animator-mcp install-plugin
   ```

3. Open a place, open Moon Animator, and ask the agent to call `moon_status`.

Requires Windows, Node.js 20 or newer, and Git. Full documentation:
https://github.com/DeepTutorAi/moon-animator-mcp
