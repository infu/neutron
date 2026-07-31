# Gemma

Gemma is a frontend-only Neutron chat app backed by the local Heretic mobile
WebGPU checkpoint `Vzmoi/gemma-4-expr-tst`, pinned to model revision
`3c4e8ad4641c69e754e5f22e8fdf9275eb2c6408`.

The hidden resident process owns the model and conversation, so switching
workspaces or closing a chat tile does not unload model weights. Model assets
use the app origin's persistent browser cache.

The resident process exposes five methods to its tiles:

- `gemma_status`
- `gemma_load`
- `gemma_generate`
- `gemma_stop`
- `gemma_reset`

Generation calls the Gemma browser runtime directly. The runtime is pinned to
`webml-community/gemma-4-webgpu-kernels` revision
`feade0377736bdb0931056468949503f547f4d70`, which includes the upstream
NVIDIA/D3D12 subgroup-reduction fix from PR 13. This app does not include an
agent loop, AI SDK, app discovery, or tool calling.

## Development

```bash
cd apps/gemma
npm run build
npm test
```
