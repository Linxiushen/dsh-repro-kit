import { describe, expect, it } from 'vitest'
import { asReproError, ReproError } from '../src/errors.js'
import { canonicalStringify, formatBytes, sha256Hex, utf8 } from '../src/utils.js'

describe('public utility invariants', () => {
  it('canonicalizes keys and omits undefined object members', () => {
    expect(canonicalStringify({ z: 1, a: { y: undefined, x: true } })).toBe('{"a":{"x":true},"z":1}')
    expect(() => canonicalStringify(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalStringify(1n)).toThrow(TypeError)
  })

  it('hashes UTF-8 and formats byte units', () => {
    expect(sha256Hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(1024)).toBe('1.00 KiB')
    expect(formatBytes(10 * 1024)).toBe('10.0 KiB')
    expect(formatBytes(1024 ** 2)).toBe('1.00 MiB')
    expect(formatBytes(1024 ** 3)).toBe('1.00 GiB')
  })

  it('preserves expected failures and wraps unknown values', () => {
    const expected = new ReproError('USAGE', 'bad input')
    expect(asReproError(expected)).toBe(expected)
    expect(asReproError(new Error('boom'))).toMatchObject({ code: 'INVALID_SESSION', message: 'boom' })
    expect(asReproError(42)).toMatchObject({ code: 'INVALID_SESSION', message: '42' })
  })
})
