# The voice box (server/voice-box.ts): reads the natural voice for DeepRead on a machine of its own.
# Build from the DeepRead folder: docker build -f voice-box/Dockerfile -t deepread-voice .
# Setup, settings and the firewall rule it needs: docs/self-hosting.md, "A voice box for the natural voice".
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN echo '{"private": true, "type": "module"}' > package.json \
  && npm install --no-audit --no-fund kokoro-js@1.2.1

# The model, fetched once into the image, so the box starts without downloading it.
RUN node --input-type=module -e "import { KokoroTTS } from 'kokoro-js'; await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });"

COPY shared/speech-audio.ts shared/
COPY server/voice-box.ts server/

USER node
EXPOSE 8443
CMD ["node", "server/voice-box.ts"]
