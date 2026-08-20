#!/usr/bin/env bash
set -euo pipefail

# Node .100 sovereign default: Ornith 1.5 9B Q6_K on the 16 GiB Blackwell GPU.
# Keep context at the live-verified 32768; 131072 is not safe on this node.
exec /mnt/comfyui/beellama.cpp/build/bin/llama-server \
  --model /mnt/comfyui/models/beellama/Ornith-1.5-9B-Q6_K.gguf \
  --alias ornith-1.5-9b \
  -ngl 99 --parallel 1 --ctx-size 32768 --batch-size 2048 \
  --reasoning on \
  --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 1.0 \
  --host 0.0.0.0 --port 8082
