
const acorn = require('acorn')
const path = require('path')
const fs = require('fs').promises
const fg = require('fast-glob')
const { jsToTtk, ttkToJs, _ } = require('../../src/lib/jstest')

const defaultSyncClientRequest = JSON.stringify({
  operationPath: 'whatever',
  method: 'get',
  headers: {},
  params: {},
  apiVersion: {
    minorVersion: 1,
    majorVersion: 0,
    type: 'fspiop',
    asynchronous: false,
  },
  url: 'whatever',
})

describe('jsToTtk', () => {
  const mlSyncClientLibName = 'sync-client'
  describe('asserts ML sync client is required exactly once', () => {
    it('asserts missing ML sync client throws', () => {
      const src = ''

      expect(() => jsToTtk('whatever', src))
        .toThrow(`Expecting require(${mlSyncClientLibName}) exactly once per file`)
    })

    it('asserts repeated ML sync client throws', () => {
      const src = [
        `require('${mlSyncClientLibName}')`,
        `{`,
        `  require('${mlSyncClientLibName}') // different scope here`,
        `}`,
      ].join('\n')

      expect(() => jsToTtk('whatever', src))
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

    expect(() => jsToTtk('whatever', src))
      .toThrow(/^Variable 'cli' cannot be shadowed or reused.*/)
  })

  it('asserts it is possible to bind the ML sync client to a different name', () => {
    const varName = Array.from(
      { length: 10 },
      () => String.fromCharCode(Math.floor(Math.random() * 26) + 97)
    ).join('')
    const src = [
      `const ${varName} = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `    const fspiopRequest = ${defaultSyncClientRequest}`,
      `    const resp1 = ${varName}(fspiopRequest)`,
      `    expect(anything)`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => jsToTtk('whatever', src))
      .not.toThrow()
  })

  it('asserts there is at least one request per test', () => {
    const clientVarName = 'cli'
    const src = [
      `const ${clientVarName} = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => jsToTtk('whatever', src))
      .toThrow(`Expected at least one request ("${clientVarName}" function call) per test`)
  })

  describe('the request parameters are as required', () => {
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

      expect(() => jsToTtk('whatever', src))
        .toThrow('Expected TTK request client argument to be an ObjectExpression')
    })

    it('asserts the request supplied is of the correct form', () => {
      const src = [
        `const cli = require('${mlSyncClientLibName}')`,
        `describe('Server', () => {`,
        `  it('starts', () => {`,
        `    const fspiopRequest = {}`,
        `    const resp1 = cli(fspiopRequest)`,
        `    expect(anything)`,
        `  })`,
        `})`,
      ].join('\n')

      const msg = [
        'Request object invalid. Errors:',
        '- Request object should have required property \'operationPath\'',
        '- Request object should have required property \'method\'',
        '- Request object should have required property \'headers\'',
        '- Request object should have required property \'params\'',
        '- Request object should have required property \'apiVersion\'',
        '- Request object should have required property \'url\'',
      ].join('\n')

      expect(() => jsToTtk('whatever', src))
        .toThrow(msg)
    })
  })

  it('asserts there is no code between assertions', () => {
    const src = [
      `const cli = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `    const fspiopRequest = ${defaultSyncClientRequest}`,
      `    const resp1 = cli(fspiopRequest)`,
      `    expect(anything)`,
      `    console.log('blah')`,
      `    expect(anything)`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => jsToTtk('whatever', src))
      .toThrow('Expected no code except assertions between the first assertion and the end of the request')
  })

  it('supports multiple requests in a single it block', () => {
    const src = [
      `const cli = require('${mlSyncClientLibName}')`,
      `describe('Server', () => {`,
      `  it('starts', () => {`,
      `    const fspiopRequest1 = ${defaultSyncClientRequest}`,
      `    const resp1 = cli(fspiopRequest1)`,
      `    expect(anything)`,
      `    expect(anything)`,
      `    const fspiopRequest2 = ${defaultSyncClientRequest}`,
      `    const resp2 = cli(fspiopRequest2)`,
      `    expect(anything)`,
      `    expect(anything)`,
      `  })`,
      `})`,
    ].join('\n')

    expect(() => jsToTtk('whatever', src))
      .not.toThrow()
  })

  it('replaceTtkVars correctly replaces TTK vars', () => {
    const line = "expect('{$request.headers['FSPIOP-Source']}').to.equal('{$prev.2.callback.headers.fspiop-destination}')"
    expect(_.replaceTtkVars(line)).toBe(
      "expect(`${request.headers[\"FSPIOP-Source\"]}`).to.equal(`${prev[2].callback.headers[\"fspiop-destination\"]}`);"
    )
  })

  it.todo('throws a useful error when code is not valid')
  // Note that the request object is assigned to a variable that is subsequently not used,
  // fspioprequest1- instead the variable fspiopRequest is used. This causes an error. Detect
  // and/or fix as required.
  // it('throws a useful error when code is not valid', () => {
  //   const src = [
  //     `const cli = require('${mlSyncClientLibName}')`,
  //     `describe('Server', () => {`,
  //     `  it('starts', () => {`,
  //     `    const fspiopRequest1 = ${defaultSyncClientRequest}`,
  //     `    const resp1 = cli(fspiopRequest)`,
  //     `    expect(anything)`,
  //     `    expect(anything)`,
  //     `  })`,
  //     `})`,
  //   ].join('\n')
  //
  //   expect(() => jsToTtk('whatever', src))
  //     .not.toThrow()
  // })
})

describe('ttkToJs', () => {
  const collectionFiles = fg.sync(path.join(__PROJECT_ROOT__, 'examples/collections/**/*.json'))
  const collections = new Map(collectionFiles.map((fname) => [fname, require(fname)]))

  describe('transforms all example collections to javascript without error', () => {
    test.each(collectionFiles)('transforms %s to js without error', (fname) => {
      const coll = collections.get(fname)
      expect(() => ttkToJs(coll)).not.toThrow()
    })
  })

  describe('transforms all example collections to valid javascript without error', () => {
    test.each(collectionFiles)('transforms %s to valid js without error', (fname) => {
      const coll = collections.get(fname)
      expect(() => acorn.parse(ttkToJs(coll), { ecmaVersion: 2020 })).not.toThrow()
    })
  })

  describe('transforms all example collections to javascript that can be converted to TTK data format successfully', () => {
    test.skip.each(collectionFiles)('transforms %s to js then to TTK data format without error', (fname) => {
      const coll = collections.get(fname)
      expect(() => acorn.parse(ttkToJs(coll), { ecmaVersion: 2020 })).not.toThrow()
    })
  })

  describe('all transformed javascript collections are correctly parsed to produce the same data as the original', () => {
    // to do? Will _at least_ require tidying up the existing TTK collections
    test.skip.each(collectionFiles)('%s transformed to js and parsed produces the same data as the original', () => {
    })
  })
})

// describe.todo('Round trip ttkToJs -> jsToTtk produces identical collections', () => {
// })

// vim: et ts=2 sw=2
