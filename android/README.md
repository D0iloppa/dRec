# dRec E-Ink (Boox) 앱

WebView 로 `https://drec.doil.me` 전체 UI(목록·녹음·회의록)를 보여주고, 스케치만 **네이티브 잉크 오버레이**
(Onyx Pen SDK raw drawing — EPD 저지연)로 그리는 하이브리드 앱. 같은 Activity 안에서 오버레이를 얹으므로
페이지의 MediaRecorder 녹음이 끊기지 않는다. Boox 가 아니면 MotionEvent 캔버스로 폴백(에뮬레이터 테스트용).

## 빌드

```bash
cd android
./gradlew test             # JVM 단위테스트 (요소 JSON 헬퍼)
./gradlew assembleRelease  # 서명된 APK: app/build/outputs/apk/release/app-release.apk
```

- 필요: JDK 17, Android SDK(`android/local.properties` 의 `sdk.dir`, gitignore 됨), Boox maven 저장소 접근.
- 서명: `android/keystore.properties`(gitignore) 가 `~/.android-keystores/drec-eink.jks` 를 가리킨다.
  **이 키스토어와 비밀번호는 반드시 백업** — 잃으면 Play 업로드/업데이트 서명을 이어갈 수 없다.
- 검증: `~/android-sdk/build-tools/35.0.1/apksigner verify --print-certs app-release.apk`

## 설치 (사이드로드)

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```
(또는 APK 를 태블릿으로 옮겨 설치.) 첫 녹음 시 마이크 권한을 허용한다.

## Boox 설정 팁

- 설정 > E-Ink Center(앱 최적화)에서 이 앱의 새로고침 모드를 **Regal/Fast** 계열로: 웹 UI 는 읽기 쉽게,
  펜 입력은 raw drawing 이 EPD 에 직접 그리므로 모드와 무관하게 빠르다.
- 잔상이 쌓이면 상단 플로팅 메뉴의 전체 새로고침을 사용한다.
- 앱은 화면 켜짐 유지(녹음 중 보호) 상태로 동작한다.

## JS 브리지 계약 (웹 쪽과 고정)

- 웹 → 앱: `window.DrecInk.open(meetingId: number, token: string)`
  - 토큰은 `Authorization: Bearer <token>` 으로 캔버스 API 에 쓰인다. `drec.doil.me` 페이지에서 온 호출만 처리.
- 앱 → 웹: 오버레이가 닫히고 최종 저장이 끝나면(또는 실패 알림 후)
  `window.dispatchEvent(new CustomEvent('drec-ink-closed', { detail: { meetingId } }))`
- 데이터: `GET/PUT /api/meetings/{id}/canvas` — 기존 요소는 원본 JSON 그대로 보존, 새 획은 Excalidraw
  `freedraw` 로 추가, 지우개/실행취소는 `isDeleted` + `version` 증가(요소를 배열에서 제거하지 않음).
  불러오기에 실패하면 편집/저장을 막는다(빈 캔버스로 덮어쓰기 방지).
