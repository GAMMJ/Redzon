// Sentry — 서버 런타임 초기화.
//
// `instrumentation.ts`의 `register()`가 Node 런타임일 때만 이 파일을 동적 import한다.
// 그래서 여기 있는 것은 **클라이언트 번들에 들어가지 않는다.**
//
// 클라이언트 SDK는 붙이지 않았다. 잡고 싶은 사각지대(Redis 쓰기, PUBG 프록시,
// Route Handler)가 전부 서버 쪽이라 클라 번들을 늘릴 이유가 없다. 클라이언트 에러는
// 이미 받고 있는 PostHog의 error tracking으로 받는다.
import * as Sentry from "@sentry/nextjs";

/**
 * 던져진 값에서 HTTP 상태 코드를 캐낸다.
 *
 * axios 에러는 `response.status`에, `CachedPubgFailure`는 `status`에 들고 있다.
 * 여기서 `axios.isAxiosError`나 `pubgErrorStatus`를 부르지 않는 것은 의도적이다 —
 * 이 파일은 SDK 초기화라 앱 모듈보다 먼저 도는데, `pubgProxy`를 끌어오면 그쪽이 다시
 * Sentry를 끌어와 초기화 중에 순환이 생긴다.
 */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.response?.status ?? candidate.status;
  return typeof status === "number" ? status : null;
}

/**
 * 에러가 아니라 **정상 동작**인 상태 코드.
 *
 * - `429` — PUBG 분당 10회 한도. 이 사이트에서 한도는 예외 상황이 아니라 상시 조건이다.
 *   거르지 않으면 대시보드가 429로만 차서 진짜 문제가 묻힌다.
 * - `404` — 없는 닉네임. 사용자가 오타를 낸 것이고 화면은 이미 안내를 띄운다.
 *
 * 지금은 이 둘을 Sentry로 보내는 자리가 없어 실제로 걸리지 않는다. 나중에 누가
 * `catch (err)` 안에 `captureException`을 하나 더 넣는 순간을 위한 가드다.
 */
const EXPECTED_STATUSES = new Set([404, 429]);

Sentry.init({
  // `NEXT_PUBLIC_` 접두사를 **일부러** 안 붙였다. 붙이면 Next가 클라 번들에 값을 심는데,
  // 서버 전용으로 두기로 한 이상 그 경로가 아예 없는 편이 낫다. 이름이 규칙을 지킨다.
  dsn: process.env.SENTRY_DSN,

  /**
   * 성능 추적(트레이싱)은 끈다.
   *
   * 스팬은 에러와 **별개의 무료 한도**를 쓴다(월 1만). 지금 필요한 것은 "무엇이 조용히
   * 실패하는가"이지 "무엇이 느린가"가 아니다. 성능 쪽은 OpenTelemetry + Grafana를
   * 따로 붙일 계획이라, 여기서 켜면 같은 일을 두 벌로 하게 된다.
   *
   * 에러 수집은 이 값과 무관하게 돈다.
   */
  tracesSampleRate: 0,

  /**
   * IP·쿠키·헤더를 보내지 않는다.
   *
   * 조회 대상 닉네임은 어차피 URL 경로에 있어서 에러마다 딸려 온다 — 그건 디버깅에
   * 필요하니 그대로 둔다. 하지만 **보는 사람**이 누구인지는 필요 없다.
   * `analytics.ts`에서 닉네임을 안 보내기로 한 것과 같은 선이다.
   */
  sendDefaultPii: false,

  /**
   * 개발 트래픽을 프로덕션과 갈라 놓는다.
   *
   * 개발에서도 켜 둔다. 아직 배포 전이라 여기서 끄면 도착하는 에러가 하나도 없어
   * 붙였는지 확인할 방법이 없다. 대신 environment로 갈라 두면 나중에 대시보드에서
   * 필터로 걷어낼 수 있다.
   */
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,

  beforeSend(event, hint) {
    const status = httpStatusOf(hint.originalException);
    if (status !== null && EXPECTED_STATUSES.has(status)) return null;
    return event;
  },
});
