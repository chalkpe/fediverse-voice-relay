# 개발 시험

Node.js와 pnpm을 설치한 뒤 `pnpm install`을 실행합니다. 통합 시험에는 영문과 숫자로 된 임시 비밀번호가 필요합니다. `VOICE_RELAY_TEST_PASSWORD` 환경변수에 이 비밀번호를 설정하고 전용 컨테이너를 시작하세요.

```sh
docker run -d --name voice-relay-test-postgres -e POSTGRES_USER=voice-relay -e POSTGRES_PASSWORD="$VOICE_RELAY_TEST_PASSWORD" -e POSTGRES_DB=voice-relay -p 127.0.0.1:17832:5432 postgres:18-alpine
docker run -d --name voice-relay-test-sfu -p 127.0.0.1:17880:7880 livekit/livekit-server:v1.13.11 --dev --bind 0.0.0.0
export VOICE_RELAY_TEST_DATABASE_URL="postgres://voice-relay:${VOICE_RELAY_TEST_PASSWORD}@127.0.0.1:17832/voice-relay"
pnpm test:integration
```

시험이 끝나면 위에서 만든 컨테이너를 `docker rm -f voice-relay-test-postgres voice-relay-test-sfu`로 삭제합니다. 다른 LiveKit을 사용할 때는 `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`도 함께 설정합니다.

로컬 이미지를 시험하려면 `docker build --build-arg NODE_VERSION="$(cat .nvmrc)" -t ghcr.io/chalkpe/fediverse-voice-relay:latest .`로 이미지를 만듭니다.
