# Development

- Node.js 18+; the server has no external runtime dependencies.
- Before deployment, run `node --check server.js` and compile every inline script in `public/index.html` with `node:vm`.
- The existing server updater downloads only `server.js` and `public/index.html`. Do not introduce required runtime assets without updating deployment.
- Preserve existing config, goals, tasks and journals when adding features. Personal targets belong in authenticated user data, not public source code.
