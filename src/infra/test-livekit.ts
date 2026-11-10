// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// 실제 SFU를 쓰는 시험은 모두 이 자격증명 하나를 공유합니다.
// 기본값은 CI의 `livekit-server --dev`와 같은 devkey/secret이고,
// 검증 환경에서는 LIVEKIT_URL·LIVEKIT_API_KEY·LIVEKIT_API_SECRET으로
// 실제 LiveKit과 시험이 같은 키를 쓰도록 주입합니다.
const url = process.env.LIVEKIT_URL ?? 'http://127.0.0.1:17880'
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey'
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret'

export const testLiveKit = { url, apiKey, apiSecret }

// 실제 LiveKit에 연결하지 않고 설정 검증만 하는 시험은 제품의 apiSecret 32자 하한을
// 만족해야 합니다. 환경값이 짧을 때만 설정 전용 시험 비밀로 늘려 씁니다.
export const testLiveKitSettings = {
  ...testLiveKit,
  apiSecret: apiSecret.length >= 32 ? apiSecret : 'voice-relay-test-settings-secret-32',
}

export const testLiveKitConfigured = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET)
export const testLiveKitReloadConfigured = testLiveKitConfigured && apiSecret.length >= 32
