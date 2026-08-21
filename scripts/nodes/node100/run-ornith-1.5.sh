#!/usr/bin/env bash
set -euo pipefail

# Node .100 sovereign default: Ornith 1.5 9B Q6_K on the 16 GiB Blackwell GPU.
# Three true 64K slots: llama.cpp divides the total context across --parallel
# slots, so 196608 total preserves the qualified 65536 per-session window.
exec /mnt/comfyui/beellama.cpp/build/bin/llama-server \
  --model /mnt/comfyui/models/beellama/Ornith-1.5-9B-Q6_K.gguf \
  --alias ornith-1.5-9b \
  -ngl 99 --parallel 3 --ctx-size 196608 --batch-size 2048 \
  --reasoning on \
  --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 1.0 \
  --host 0.0.0.0 --port 8082
