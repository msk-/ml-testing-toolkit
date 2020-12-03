
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

  it('asserts there is at least one request per test', () => {
    const clientVarName = 'cli';
    const src = [
      `const ${clientVarName} = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => parseJsTest('whatever', src))
      .toThrow(`Expected at least one request ("${clientVarName}" function call) per test`)
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

  it('asserts there is at least one assertion per test', () => {
    const src = [
      `const cli = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `    const fspiopRequest = {`,
      `      whatever: 5,`,
      `      blah: 6,`,
      `    }`,
      `    const resp1 = cli(fspiopRequest)`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => parseJsTest('whatever', src))
      .toThrow(/^Expected at least one assertion \("expect" function call\) per test/)
  })

  it('asserts the request supplied is an ObjectExpression', () => {
    const src = [
      `const cli = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `    const fspiopRequest = otherObj`,
      `    const resp1 = cli(fspiopRequest)`,
      `    expect(anything)`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => parseJsTest('whatever', src))
      .toThrow('Expected TTK request client argument to be an ObjectExpression')
  })

})

// vim: et ts=2 sw=2
