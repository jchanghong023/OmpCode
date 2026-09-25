# OmpCode

<p align="center">
  <img src="public/logo/icons/1024x1024.png" alt="OmpCode icon" width="96" />
</p>

<h3 align="center">The best desktop experience for omp</h3>

<p align="center">
  A ZCode-inspired interface, fully adapted to the omp core and its workflows.<br />
  Every omp feature and slash command, brought together in one desktop workspace for AI coding.
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#credits">Credits</a>
</p>

## See OmpCode in action

**The full power of omp in a desktop workspace.** Follow tasks, tool calls, file changes, and session state in one place while you focus on building.

<p align="center">
  <a href="docs/images/ompcode-workspace.png">
    <img src="docs/images/ompcode-workspace.png" alt="OmpCode desktop workspace and agent session" width="100%" />
  </a>
</p>

**Know your context.** See context capacity, estimated usage breakdown, free space, and the reserve for automatic compaction.

<p align="center">
  <a href="docs/images/ompcode-context.png">
    <img src="docs/images/ompcode-context.png" alt="OmpCode context usage panel" width="502" />
  </a>
</p>

**Configure models the omp way.** Select a Profile and set the model and thinking level for each model role.

<p align="center">
  <a href="docs/images/ompcode-models.png">
    <img src="docs/images/ompcode-models.png" alt="OMP Profiles and model role settings in OmpCode" width="100%" />
  </a>
</p>

**Every omp slash command is within reach.** Type `/` in the composer to browse and run commands.

<p align="center">
  <a href="docs/images/ompcode-commands.png">
    <img src="docs/images/ompcode-commands.png" alt="omp slash commands in OmpCode" width="100%" />
  </a>
</p>

## Why OmpCode

- **The complete omp experience:** omp is the Agent core, and the interface, sessions, and controls are built around it. OmpCode supports all omp features.
- **Every slash command:** The full omp command catalog is available in the composer, including `/model`, `/switch`, `/compact`, `/mcp`, `/usage`, and skill commands.
- **Models on your terms:** Use omp Profiles, the omp model catalog, and model roles. Choose models and thinking levels per role or switch them for a session.
- **A clear view of your work:** Streaming responses, tool calls, file changes, context usage, and compaction state stay visible in one workspace.
- **Keep working across devices:** Continue with the Web interface and mobile remote access.
- **Open source and extensible:** The interface and visual style draw from [ZCode](https://github.com/zai-org/ZCode); Agent capabilities come from [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi).

## Quick start

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. From the repository root:

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` installs dependencies, prepares desktop runtime assets, and builds the project. The desktop app embeds omp, so you do not need a separate omp installation. It uses your omp configuration, models, and session data.

To develop the Web client and server:

```bash
pnpm dev:web
```

To build the desktop app:

```bash
pnpm bundle:desktop -- --os win --arch x64
```

See the root and package `package.json` files for additional commands.

## Credits

OmpCode builds on [ZCode](https://github.com/zai-org/ZCode), carrying forward its desktop interface and visual style. Its Agent core is [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi), connected through the [omp adapter](packages/omp-agent/). Thanks to both upstream projects and their contributors.

OmpCode is licensed under the [Apache License 2.0](LICENSE). See [NOTICE.md](NOTICE.md) for third-party notices and project information.
