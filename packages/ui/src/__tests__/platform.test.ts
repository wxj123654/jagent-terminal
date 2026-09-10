import { describe, expect, test } from 'bun:test'

import { trafficLightWidth } from '../platform'

describe('trafficLightWidth', () => {
  test('Tahoe / Darwin 25+ uses 78px', () => {
    expect(trafficLightWidth('darwin', '25.0.0')).toBe(78)
    expect(trafficLightWidth('darwin', '27.0.0')).toBe(78)
  })

  test('pre-Tahoe macOS keeps 71px', () => {
    expect(trafficLightWidth('darwin', '24.6.0')).toBe(71)
  })

  test('non-mac platforms keep the pre-Tahoe constant', () => {
    expect(trafficLightWidth('win32', '10.0.22621')).toBe(71)
    expect(trafficLightWidth('linux', '6.8.0')).toBe(71)
  })
})
