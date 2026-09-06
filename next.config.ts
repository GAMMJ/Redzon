import type { NextConfig } from "next";
// `@sentry/nextjs`가 아니라 `/config`에서 가져온다. 루트 엔트리의 re-export는 v10에서
// deprecated로 표시돼 있다(`config/deprecatedWithSentryConfig`). 같은 함수지만
// 그쪽으로 부르면 빌드마다 경고가 뜬다.
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // 개발 중 왼쪽 아래에 뜨는 라우트 표시기를 숨긴다.
  // 화면 구석을 가려서 확인에 방해가 된다. 끄더라도 컴파일·런타임 에러는 그대로 뜬다.
  devIndicators: false,
};

// 빌드 때 소스맵을 Sentry로 올린다.
//
// 안 올리면 프로덕션 스택 트레이스가 `a.b(c,d)` 같은 압축된 코드로 나와서, 에러는
// 잡히는데 어디서 났는지 알 수가 없다. 업로드에는 `SENTRY_AUTH_TOKEN`이 필요하고
// 그건 `.env`에 있다(커밋 안 됨). Vercel에도 같은 이름으로 넣어야 한다.
//
// org·project는 비밀이 아니라 여기 그대로 적는다. 어차피 대시보드 주소에 보인다.
export default withSentryConfig(nextConfig, {
  org: "gammj",
  project: "redzone",
  // 로컬 빌드에서는 업로드 로그를 접어 둔다. CI에서는 실패를 봐야 하므로 그대로 둔다.
  silent: !process.env.CI,

  /**
   * 라우트 매니페스트를 클라이언트 번들에 심지 않는다.
   *
   * 이건 **트레이싱 트랜잭션 이름을 예쁘게** 만드는 물건이다 —
   * `/player/steam/닉네임`을 `/player/[platform]/[playerName]`로 묶어 준다.
   * `tracesSampleRate: 0`이라 묶을 트랜잭션이 애초에 없으므로 순수 무게다.
   *
   * 실측: 켜면 클라 JS가 1,037,479 → 1,043,507 바이트(+5.9KB).
   * 서버 전용으로 붙이기로 한 이상 클라에 한 바이트도 얹지 않는다.
   * 나중에 트레이싱을 켜면 이 줄부터 지울 것.
   */
  routeManifestInjection: false,
});
