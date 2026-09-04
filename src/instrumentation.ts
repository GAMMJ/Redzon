// 서버 계측 — Sentry.
//
// `instrumentation-client.ts`(PostHog)의 서버 짝이다. 이름은 비슷하지만 도는 자리가
// 정반대다: 그쪽은 브라우저에서 하이드레이션 직전에, 이쪽은 **서버 인스턴스가 뜰 때
// 딱 한 번** 돈다. 요청을 받기 전에 끝나야 하므로 무거운 걸 얹지 말 것.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // 설정을 정적 import하지 않고 여기서 동적으로 부른다. 정적으로 두면 런타임과
  // 무관하게 번들에 들어가는데, 아래 분기가 그걸 막으려고 있는 것이다.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  // edge 런타임 분기는 두지 않는다. 미들웨어도 `runtime = "edge"`도 이 프로젝트엔 없다.
  // 쓰지 않을 런타임의 설정 파일은 죽은 코드이고, 생기면 그때 만드는 편이 낫다.
  // (여기 `nodejs` 검사를 남겨 둔 이유가 그거다 — edge가 생겨도 Node 설정을 잘못
  //  끌어가지 않는다.)
}

/**
 * 서버에서 **던져진** 에러를 Sentry로 넘긴다.
 *
 * "던져진"이 중요하다. `proxyPubg`는 PUBG·Redis 실패를 전부 `catch`해서 `Response`로
 * 돌려주므로 여기까지 오지 않는다. 그쪽은 `reportError.ts`로 직접 보낸다.
 * 이 훅이 받는 것은 서버 컴포넌트 렌더 실패처럼 **아무도 안 잡은** 에러다.
 */
export const onRequestError = Sentry.captureRequestError;
