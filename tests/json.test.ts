import { describe, expect, it } from 'vitest'
import { ReproError } from '../src/errors.js'
import { parseJsonStrict } from '../src/json.js'

describe('parseJsonStrict', () => {
  it('rejects nested duplicate members after escape decoding', () => {
    expect(() => parseJsonStrict('{"outer":{"a":1,"\\u0061":2}}', 'fixture.json')).toThrowError(
      expect.objectContaining<Partial<ReproError>>({ code: 'DUPLICATE_JSON_MEMBER' }),
    )
  })

  it('accepts repeated keys in different objects', () => {
    expect(parseJsonStrict('[{"id":1},{"id":2}]', 'fixture.json')).toEqual([{ id: 1 }, { id: 2 }])
  })
})
