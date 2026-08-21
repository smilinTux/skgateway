#!/usr/bin/env bash
set -euo pipefail

# Node .100 sovereign default: Ornith 1.5 9B Q6_K on the 16 GiB Blackwell GPU.
# Qualification target: 65536. Do not raise to the 262144 training window
# without repeating the fleet VRAM and long-prompt gates.
exec /mnt/comfyui/beellama.cpp/build/bin/llama-server \
  --model /mnt/comfyui/models/beellama/Ornith-1.5-9B-Q6_K.gguf \
  --alias ornith-1.5-9b \
  -ngl 99 --parallel 1 --ctx-size 65536 --batch-size 2048 \
  --reasoning on \
  --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 1.0 \
  --host 0.0.0.0 --port 8082
