<p align="center">
  <img src="docs/assets/icon.png" alt="Voice relay for the fediverse 아이콘" width="144">
</p>

<h1 align="center">Voice relay for the fediverse</h1>


연합우주 서버의 음성 통화와 화면 공유를 위한 LiveKit 릴레이입니다. 이용 서버는 릴레이 주소와 발급받은 시크릿을 등록해 연결합니다.

이용 서버는 릴레이 API로 통화를 관리하고, 브라우저의 음성과 화면 공유는 LiveKit으로 연결됩니다.

## 실행

Docker Compose로 PostgreSQL과 LiveKit을 함께 실행합니다. 저장소 파일과 `package.json`의 `engines`에 맞는 Node.js, pnpm을 준비한 뒤 저장소 디렉터리에서 실행하세요. 초기 설정 전에 `pnpm install --frozen-lockfile`로 의존성을 설치하세요. 초기 설정에는 DB 연결이 필요하지 않습니다.

```sh
node src/app/cli.ts init --public-url https://voice.example.org
docker compose pull
docker compose up -d
```

`--public-url`에는 운영할 릴레이의 공개 HTTPS 주소를 입력하세요. `init`은 `.env`와 `secrets/`에 비밀번호와 LiveKit 키를 생성합니다. 이미 설정 파일이 있으면 덮어쓰지 않습니다. 전체 최대 참가자 수와 방 수는 필요할 때 `secrets/config.json`의 `maxSlots`, `maxRooms`에서 조정하세요.

화면 공유 화질 상한은 `screenShareLimits`로 조정할 수 있습니다. 설정과 적용 시점은 [운영 문서](docs/operations.md)를 참고하세요.

운영할 릴레이 도메인으로 들어온 HTTPS 요청을 `127.0.0.1:7888`로 전달하도록 웹 서버를 설정하세요. 호스트에서 Caddy를 실행한다면 [Caddy 설정 예제](docs/examples/Caddyfile)의 도메인을 바꾸어 사용하세요. 서버 방화벽에서 7881/TCP와 7882/UDP를 허용하세요.

## 이용 서버 등록

```sh
docker compose run --rm admin client add --origin https://consumer.example.org --max-slots 100 --max-rooms 2 --allow-screen-share
docker compose run --rm admin client list
```

`client add` 결과에서 이용 서버의 `origin`과 발급된 `secret`을 확인하세요. 해당 이용 서버 관리자에게 릴레이 주소와 시크릿을 전달하세요. [이용 서버 연결 방법](docs/cherrypick.md)을 참고하세요.

## 시크릿 교체와 회수

```sh
docker compose run --rm admin client rotate-secret --origin https://consumer.example.org
docker compose run --rm admin client disable --origin https://consumer.example.org
docker compose run --rm admin client enable --origin https://consumer.example.org
```

시크릿을 교체하면 기존 시크릿은 즉시 무효화됩니다. 새 시크릿을 해당 이용 서버 관리자에게 전달하세요. 비활성화한 이용 서버는 다시 활성화할 수 있습니다.

설치 복구와 TURN 설정은 [운영 문서](docs/operations.md)를 참고하세요.

## 개발 및 검증

`pnpm test`, `pnpm test:contract`, `pnpm typecheck`, `pnpm lint`로 검사합니다. 통합 시험은 [시험 환경](docs/development.md)을 준비한 뒤 `pnpm test:integration`으로 실행합니다.

공통 규격은 [protocol v1](docs/protocol/v1.md)을 참고하세요. 실행 중인 릴레이의 `/docs`에서 API 문서를 볼 수 있으며 명세 경로는 `/openapi.json`입니다.

## License

AGPL-3.0-only. [LICENSE](LICENSE)를 참고하세요.
