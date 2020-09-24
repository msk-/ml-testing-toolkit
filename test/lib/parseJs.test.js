
const parseJsTest = require('../../src/lib/parseJsTest')
const src = [
  `const whatever = require('sync-client')`,
  ``,
  `describe('Server', () => {`,
  `  it('starts', () => {`,
  `    const fspiopRequest = {`,
  ``,
  `    }`,
  `  })`,
  `})`,
].join('\n')

describe('parseJsTest', () => {
  const mlSyncClientLibName = 'sync-client'
  describe('asserts ML sync client is required exactly once', () => {
    it('asserts missing ML sync client throws', () => {
      const src = ''

      expect(() => parseJsTest('whatever', src))
        .toThrow(`Expecting require(${mlSyncClientLibName}) exactly once per file`)
    })

    it('asserts repeated ML sync client throws', () => {
      const src = [
        `require('${mlSyncClientLibName}')`,
        `{`,
        `  require('${mlSyncClientLibName}') // different scope here`,
        `}`,
      ].join('\n')

      expect(() => parseJsTest('whatever', src))
        .toThrow(`Expecting require(${mlSyncClientLibName}) exactly once per file`)
    })
  })

  it('asserts ML sync client variable is not shadowed', () => {
    const src = [
      `const cli = require('${mlSyncClientLibName}')`,
      `{`,
      `  const cli = 'can\\'t touch this'`,
      `}`
    ].join('\n')

    expect(() => parseJsTest('whatever', src))
      .toThrow(/^Variable 'cli' cannot be shadowed or reused.*/)
  });
})
