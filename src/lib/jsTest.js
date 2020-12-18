
// A note about this code: unless otherwise mentioned, every `assert` call here has a corresponding
// test. At the time of writing, they're all in the same order in the tests as they are in this
// file.

// TODO: high level documentation of this module, and the format that a javascript test must have

const crypto = require('crypto');
const assert = require('assert').strict
const acorn = require('acorn')
// TODO: are we using recast any more? Could we instead use ast-types?
const recast = require('recast')
const astring = require('astring')
const jsc = require('jscodeshift')
const build = jsc // could also be: `build = recast.types.builders` or `build = require('ast-types')`
const Ajv = require('ajv').default
const {
    asrt,
    astNodesAreEquivalent,
    astTypesInScope,
    appendComment,
    buildNestedMemberExpression,
    callExpressionMatching,
    chk,
    identifiersInSameScope,
    not,
    prettyPrint,
    summarise,
} = require('jsc-utils')
const ajv = new Ajv({ allErrors: true })
const parse = (source) => acorn.parse(source, {
  // Because we're parsing single lines in pre-request scripts, i.e. snippets that might
  // exist inside an async function, we need to be able to parse await outside of a function.
  allowAwaitOutsideFunction: true,
  ecmaVersion: 2020,
})

// TODO: move this to a different file?
// TODO: a PUT or a POST must have a body, a GET must not- we will therefore need to expand this
// definition. It could be worthwhile referencing the FSPIOP-API spec?
const requestSchema = {
  "$id": "https://mojaloop.io/schemas/ttk/request.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TTK Request",
  "type": "object",
  "properties": {
    "operationPath": {
      "description": "The request path",
      "type": "string"
    },
    "method": {
      "description": "",
      "type": "string",
      "enum": ["get", "post", "put", "patch", "delete", "head", "connect", "options", "trace"]
    },
    "headers": {
      "description": "HTTP request headers",
      "type": "object"
    },
    "params": {
      "description": "HTTP path parameters, substituted into HTTP path before request",
      "type": "object"
    },
    "apiVersion": {
      "description": "Structured representation of API version/schema information",
      "type": "object",
      "properties": {
        "minorVersion": { "type": "integer", "minimum": 0 },
        "majorVersion": { "type": "integer", "minimum": 0 },
        "type":         { "type": "string"  },
        "asynchronous": { "type": "boolean" }
      },
      "required": [
        "minorVersion",
        "majorVersion",
        "type",
        "asynchronous"
      ]
    },
    "url": {
      "description": "The HTTP request URL.",
      "type": "string"
    }
  },
  "required": [
    "operationPath",
    "method",
    "headers",
    "params",
    "apiVersion",
    "url"
  ]
}
const requestValidator = ajv.compile(requestSchema, { strict: true })

// Map a javascript test into the TTK test collection format. We necessarily reject some tests as
// nonconformant. This could be for several reasons:
// - we lack the development resource to support identifying and mapping arbitrary javascript functionality
// - the TTK test format is constrained so as to increase usability and understandability in different contexts
// Regarding this second point, some of our users view and edit tests using the TTK UI. The UI is
// built around a concept of a "TTK test" which contains some structure
// We try to display useful failure messages to the user so they can rectify these
// incompatibilities, and document here the reasons for such constraints.
// TODO: high-level documentation about the test schema, why it is the way it is
const jsToTtk = (filepath, src) => {
  const j = jsc(src)

  // ==========
  // Perform a few assertions on the code to make sure we can work with it
  // ==========
  // 1. identify the call to `require('sync-client')`
  // 2. get the variable to which the `require` result was assigned
  //   - TODO: handle the case where it's destructured, or disallow this. NOTE: if we're going to
  //     rigorously apply constraints, we'd be better of specifying what _is_ allowed rather than
  //     what _isn't_. And this might best be done by forking and extending an existing parser, or
  //     an existing grammar.
  const mlSyncClientLibName = 'sync-client'
  const syncClientCalls = j.find(jsc.CallExpression)
    .filter((path) => astNodesAreEquivalent(
      path.value,
      jsc.callExpression(
        jsc.identifier('require'),
        [
          jsc.literal(mlSyncClientLibName)
        ]
      )
    ))
    .paths()
  assert(syncClientCalls.length === 1, `Expecting require(${mlSyncClientLibName}) exactly once per file`)
  const syncClientIdentifier = syncClientCalls[0].parentPath.value.id.name
  assert(
    1 === j
      .find(jsc.VariableDeclarator)
      .filter((path) => path.value.id.name === syncClientIdentifier)
      .paths()
      .length,
    `Variable '${syncClientIdentifier}' cannot be shadowed or reused, as it is required by TTK to identify calls to the Mojaloop sync client. You may rename the variable to which you assigned require('${mlSyncClientLibName}') if you like.`
  )

  // ==========
  // Get every `it` function call- these are our "test cases"
  // ==========
  const itCallExprPaths = j.find(jsc.CallExpression)
    .filter(callExpressionMatching(/^it$/))
    .paths()

  // within each `it` function call, get every API request using the ML client lib
  // 3. find instances of that variable that are used to make/build a request
  // TODO: this is basically a parser. Where assertions are made indicating problems with the test,
  // this parser should let the user know exactly where the problem occurred, and what the problem
  // was. Basically, it needs to produce better error messages.
  const testCases = itCallExprPaths.map((itCallExprPath) => {
    // Utilities
    const itBody = itCallExprPath.get('arguments').get('1').get('body').get('body')
    const itBodyColl = jsc(itBody)
    const traverseUpwardUntilTestBlock =
      (p) => p.parentPath === itBody ? p : traverseUpwardUntilTestBlock(p.parentPath)

    // Get all requests made in the test
    const getRequestFunctionCalls = (coll) => coll
      .find(jsc.CallExpression)
      .filter((path) => path.value.callee.name === syncClientIdentifier)
      .paths()
    const requestFunctionCalls = getRequestFunctionCalls(itBodyColl)
    assert(
      requestFunctionCalls.length > 0,
      `Expected at least one request ("${syncClientIdentifier}" function call) per test`
    )

    const getRequestArgs = (requestFunctionCalls) => requestFunctionCalls
      .map((syncClientFunctionCall) => syncClientFunctionCall.get('arguments').get('0'))
      .map((syncClientFunctionArg) =>
        // If the argument is a POJO, then we'll return it, otherwise find where it's defined and
        // return that.
        // TODO: what happens in the following case:
        //   const request = {}
        //   request.url = 'hahahaha now it\'s difficult isn\'t it?!'
        // What about this one...
        //   const request = {}
        //   request.url = sideEffect('now we\'re in trouble')
        // we could perhaps detect any changes to properties.. eek.. check all
        // AssignmentExpressions in scope for a MemberExpression looking like modification of the
        // request object?
          chk.ObjectExpression(syncClientFunctionArg) && false
        ? syncClientFunctionArg
        : jsc(syncClientFunctionArg.scope.path)
            .findVariableDeclarators(syncClientFunctionArg.value.name)
            .map((syncClientArgDeclarator) => syncClientArgDeclarator.get('init')) // TODO: .get('init') _can_ be null- what happens then?
            .paths()
      )
      .paths()
    const requestArgs = getRequestArgs(jsc(requestFunctionCalls))

    // TODO: Assert request args are of the correct form?
    // - Remember, TTK UI users will probably want to modify the request parameters- _and_
    //   developers will want to use normal JS functionality to modify requests, and use test
    //   fixtures included from other files. Therefore the question becomes: what _is_ the correct
    //   form?
    // - We could write and run some code that destructures the request into the correct format..
    //   maybe?
    // - We could use some sort of assertion library with "any" or whatever, something like
    //   expect({ a: b }).toEqual({ a: expect.any })
    // - Do we need the request to have only literals in it? That seems a bit crazy- people will
    //   want to use fixtures and other shared data. Should we resolve the values? What happens
    //   when someone wants to change them? Do we allow that _only_ if they're literals? Any change
    //   will go through a peer review process in any case, so if it's raised as part of said peer
    //   review process, it'll be reviewed by a developer, so replacement of variables with
    //   literals/fixtures etc. can be managed by that process.
    // - Naive, initial implementation shouldn't attempt to resolve variable definitions. This is a
    //   pretty tricky problem to solve. So users _using_ TTK UI will just have to replace
    //   variables with literals, or reuse variables. We _could_ provide a UI later on for
    //   definition of shared data (i.e. fixtures).
    // - It would certainly be easier to push enforcing the form of the request into `sync-client`
    //   (or whatever that ends up being called)- perhaps by having it take an openapi spec and
    //   some config or something?
    // - Is this type-checking? Is that something we should just ignore? It's a dynamic language,
    //   after all..
    // - On the other hand, the request itself needs to comply to an API spec for storage in the
    //   TTK format. _Unless_ the TTK format becomes javascript tests.

    // Here we identify the boundaries between requests and assertions. These boundaries correspond
    // to "requests" in the parlance of TTK.
    // Procedurally speaking, what we are doing here is looking for each sync-client request, then
    // working backward to the closest preceding assertion (or the beginning of the test block).
    // That assertion is the boundary that defines the end of the preceding TTK request and the
    // beginning of the current TTK request.
    const getAssertions = (coll) => coll
      .find(jsc.CallExpression)
      .filter((path) => path.value.callee.name === 'expect')
      .paths()
    const assertionExprStmtsRev = getAssertions(itBodyColl)
      .map(traverseUpwardUntilTestBlock)
      .sort((m, n) => m.name - n.name)
      .reverse()
    return requestFunctionCalls
      .map(traverseUpwardUntilTestBlock)
      .map((requestExprStmt) => ({
        // Find the start of the TTK request as the last assertion preceding the current request,
        // or zero as the first statement in the it block.
        requestExprStmt,
        start: assertionExprStmtsRev.find((assertion) => assertion.name < requestExprStmt.name)?.name + 1 || 0
      }))
      .map(({ start, requestExprStmt }, i, arr) => ({
        requestExprStmt,
        // Turn the start into both a start and end by using the start of the following request as
        // the end of the current request. Return a half-open range [start,end).
        start,
        end: (arr[i + 1]?.start || itBody.value.length)
      }))
      .map(({ start, end, requestExprStmt }) => ({
        requestExprStmt,
        // Turn the start and end indices into a collection of NodePaths representing all nodes in
        // the request
        topLevelRequestBodyPaths: Array.from(
          { length: end - start },
          (_, i) => itBody.get(`${i + start}`)
        )
      }))
      .map(({ requestExprStmt, topLevelRequestBodyPaths }) => {
        // Here we'll build the request argument in the TTK request format
        const requests = getRequestFunctionCalls(jsc(topLevelRequestBodyPaths))
        // These two assertions are pretty difficult to trigger. In fact, they should be impossible
        // to trigger, if this code is correct. We therefore do not have tests for these, but have
        // them as runtime errors should they occur. This is because the topLevelRequestBodyPaths
        // array should only contain a single request, which should therefore have only a single
        // argument, by construction.
        assert(
          requests.length === 1,
          'Expected exactly one client request per TTK request. This is an internal logic error. Please raise an issue here: https://github.com/mojaloop/ml-testing-toolkit/issues',
        )
        const requestArgs = getRequestArgs(jsc(requests))
        assert(
          requestArgs.length === 1,
          'Expected exactly one argument per request. This is an internal logic error. Please raise an issue here: https://github.com/mojaloop/ml-testing-toolkit/issues',
        )
        // Validate the request supplied in the test.
        const requestArgNode = requestArgs[0].value
        assert(
          chk.ObjectExpression(requestArgNode),
          // TODO:
          //   short term: need to provide more guidance to the user on this
          //   medium term: need to do better resolution of the object supplied here, in order to
          //     support things like fixtures. Or perhaps worse resolution- are we type checking a
          //     dynamically typed lang here?
          'Expected TTK request client argument to be an ObjectExpression'
        )
        // TODO: currently this only allows POJOs constructed with literals. No variable references
        // or anything of the sort, therefore no fixtures. Needs work. Likely to be challenging.
        const objExprToObjNaive = (objExpr) => {
          switch (objExpr.type) {
            case 'ObjectExpression':
              return Object.fromEntries(
                objExpr.properties.map((prop) => ([
                  // prop.key.name when the object is like { some: 'value' }
                  // prop.key.value when the object is like { 'some': 'value' }
                  prop.key.name || prop.key.value,
                  objExprToObjNaive(prop.value)
                ]))
              )
            case 'Literal':
              return objExpr.value
            default:
              throw new Error(`Unhandled object type for ${summarise(objExpr)} when validating the request object`)
          }
        }
        const requestArg = objExprToObjNaive(requestArgNode)
        const errorOpts = { separator: '\n- ', dataVar: 'Request object' }
        assert(
          requestValidator(requestArg),
          `Request object invalid. Errors:\n- ${ajv.errorsText(requestValidator.errors, errorOpts)}`
        )
        return {
          requestExprStmt,
          requestArg,
          topLevelRequestBodyPaths,
        }
      })
      .map(({ requestArg, requestExprStmt, topLevelRequestBodyPaths, }) => {
        // Break the request into
        // - pre-request script, this will be all code before requestExprStmt
        // - request, this is requestExprStmt
        // - post-request script, this will be all code between requestExprStmt and the first
        //   assertion
        // - assertions, these must not contain any code other than expect function calls
        // Note that by construction there should be no assertions before the request, and no code
        // after the assertions.

        // First, bisect/bucket the statements before and after requestExprStmt. This yields our
        // pre-request script and all statements after the request.
        const topLevelRequestBodyPathsSorted =
          [...topLevelRequestBodyPaths].sort((m, n) => m.name - n.name)
        const preRequestScript = topLevelRequestBodyPathsSorted.filter(
          (path) => path.name < requestExprStmt.name
        )
        const rest = topLevelRequestBodyPathsSorted.filter(
          (path) => path.name > requestExprStmt.name
        )

        // Bisect the statements after the request into everything before the first assertion, and
        // everything else.
        const isAssertion = (path) => /^expect\(.*/.test(summarise(path))
        const firstAssertion = rest.findIndex(isAssertion)
        const postRequestScript = firstAssertion > -1 ? rest.slice(0, firstAssertion) : rest
        const assertions = firstAssertion > -1 ? rest.slice(firstAssertion) : []
        // Assert that everything in the assertions array is an assertion. Note that the
        // consequence of this is that a test must not contain any code that is not assertions once
        // the assertions begin, _at the same AST level as the assertions. This is a pretty
        // arbitrary restriction, as we will see:
        // Disallowed code:
        //   expect('something').toBe('something')
        //   const intermediate = complicated.transformation(obj).sequence().transform()
        //   const result = transformMore(intermediate)
        //   expect(result).toBe(expectedThing)
        // Allowed code:
        //   expect('something').toBe('something')
        //   expect(result).toBe(
        //     transformMore(
        //       complicated.transformation(obj).sequence().transform()
        //     )
        //   )
        // It is quite possible to move `intermediate` and `result` before all assertions, but that
        // moves the definition further from where it's used, which can be unpleasant for a reader.
        // A less constrained model that would probably result in a _better_ experience in the UI
        // rather than a worse one, would be a concept of "pre-assertion scripts". We could go so
        // far as to constrain what is available in "pre-assertion scripts", for example to ensure
        // that "pre-assertion scripts" only declared new intermediate variables. Note however that
        // it might not be possible to distinguish between a "pre-assertion script" and a
        // "post-request script". Perhaps this is all futile. Or perhaps all "post-request scripts"
        // are in fact just "pre-assertion scripts". Something that would not be classified as part
        // of a "pre-assertion script": any necessary cleanup. This could in fact be the name of a
        // new section that occurs after all assertions.
        assert(
          assertions.every(isAssertion),
          'Expected no code except assertions between the first assertion and the end of the request'
        )

        // Collection.toSource returns an array or a string depending on whether the collection
        // contains multiple paths, or a single path. Therefore, we handle both result types by
        // wrapping the result in an array and flattening it, joining any number of paths with a
        // line break, then splitting on line breaks, because a single path might contain line
        // breaks.
        const toSource = (nodePaths) => [jsc(nodePaths).toSource()].flat().join('\n').split('\n')
        return {
          ...requestArg,
          tests: {
            assertions: assertions.map((path, id) => ({
              id,
              exec: [summarise(path)],
              description: '', // TODO: we could (1) autogenerate this (2) take it from the final expect parameter (3) ignore it
            }))
          },
          scripts: {
            preRequest: {
              exec: toSource(preRequestScript),
            },
            postRequest: {
              exec: toSource(postRequestScript),
            },
          },
        }
      })
  })

  return {
    test_cases: testCases
  }

  return {
    name: filepath,
    // Each "test case" must correspond to a single javascript test, let's say an "it" call.
    //
    // 1 Tricky, because these can be nested multiple "describe" calls deep. So, what will we do
    //   about this? Nothing? Enforce describe depth = 1? Are describe calls optional?
    // 2 Should we support describe/it and describe/test, or prescribe one or the other?
    // 3 How do we handle the fact that javascript is probably considerably more flexible than
    //   we're likely willing to handle here? Specifically, our ad-hoc collection of constraints
    //   are likely to be subverted by enterprising test writers, and the best reliable way to get
    //   around that is likely to be to fork an existing parser. (See earlier note about parser).
    // 4 How will we handle things that go on outside the `it` calls? For example, `beforeEach`,
    //   `afterEach`, `beforeAll`, `afterAll`? Display each of them in a "setup" block?
    // 5 Likely we ignore (3) and (4). Examining some of the existing tests: the actual bulk of the
    //   logic is in the "pre-request" script anyway. In other words, the existing implementation
    //   doesn't treat tests as being all that structured anyway, so why would we? The value in
    //   this toolkit is likely ad-hoc _creation_ of tests, not manipulation of existing ones.
    //   Maybe this entire exercise is stupid. _Perhaps_ business people want to get _some_ idea of
    //   the tests that are actually occurring, even if it's adulterated?
    test_cases: [
      {
        id: 'index in file? index in describe?',
        name: 'first string argument to `it` function call',
        requests: [
          {
            id: 'index in test? name of variable? (not if there isn\'t a variable)',
            description: 'retrieved from the API spec',
            apiVersion: { // TODO: this should be retrieved from the request itself
              minorVersion: 0,
              majorVersion: 1,
              type: 'fspiop',
              asynchronous: true
            },
            operationPath: '/parties/or/something', // TODO: from the request itself
            method: 'get',
            headers: {
              // TODO: from the request
            },
            params: { // TODO: unnecessary..?
            },
            url: '', // TODO: get from the request
            tests: {
              assertions: [
                // TODO: parse from tests
                {
                  id: 1, // TODO: index? pretty irrelevant..
                  description: 'whatever', // TODO: parse from second argument to expect
                  exec: 'expect(blah whatever)' // TODO: parse from assertion
                },
              ]
            },
            scripts: {
              // TODO: the "exec" key is completely redundant and is obviously a throwback to the
              // Postman collection format
              preRequest: {
                exec: [
                  // some code, but what, exactly?
                ]
              },
              postRequest: {
                exec: [
                  // some code, but what, exactly?
                ]
              }
            }
          }
        ]
      }
    ]
  }
}

// Replace TTK vars in script elements with template literals
//
// Because strings containing "TTK vars" look like this:
//   expect(callback.headers['fspiop-destination']).to.equal('{$request.headers['FSPIOP-Source']}')
// notably this section:
//   '{$request.headers['FSPIOP-Source']}'
// they are unlikely to be valid javascript. Additionally, performing a simple search and replace
// is tricky because we must correctly identify "strings within strings" but without misidentifying
// the beginning of a string within a string as the end of a string.
//
// This function replaces these strings with template literals. It does so by replacing TTK vars
// with a hash of their contents so the remaining string is valid javascript. It then replaces
// string literals containing the previously-created hashes with template literals in which the
// expressions are the AST representations of the original TTK vars.
//
// It might be possible to achieve this with a regex, but we'd need to handle matching three
// different string characters (', ", `) with a string in between. It probably warrants three
// different regexes:
//   /'([^']+){\$((function|prev|request|inputs)[^}]+)}'/g
//   /"([^"]+){\$((function|prev|request|inputs)[^}]+)}"/g
//   /`([^"]+){\$((function|prev|request|inputs)[^}]+)}`/g
// At the time of writing, it doesn't seem obvious to the author that the end result would be
// simpler, more robust, or easier to reason about.
const replaceTtkVars = (line) => {
  // We can do this line-by-line because the regex in the original TTK code doesn't work over line
  // breaks.
  const ttkVarRegex = /{\$((function|prev|request|inputs)[^}]+)}/g
  if (!ttkVarRegex.test(line)) {
    return line
  }
  const m = new Map()
  // Replace any TTK vars with a hash of the original string. This will allow us to parse the
  // string without syntax errors.
  const sanitisedLine = line.replace(ttkVarRegex, (ttkVar) => {
    const hash = (str) => crypto.createHash('md5').update(str).digest('hex')
    const ttkVarToTemplateLiteral = (v) => {
      // TTK uses
      // - `prev.id`, where id is an integer, to refer to previous request responses.
      // - function.funcname to call a shared function called funcname
      // These are not valid javascript, therefore we replace them with valid js here.
      const ttkPrevRegex = /{\$prev\.([0-9]+)([^}]*)}/g
      const ttkFuncRegex = /{$function\.([^}]*)}/g
      return v.replace(ttkPrevRegex, '{\$prev[$1]$2}')
        .replace(ttkFuncRegex, '{\$function.$1}')
        .replace(ttkVarRegex, '\${$1}')
    }
    const h = hash(ttkVar)
    m.set(h, ttkVarToTemplateLiteral(ttkVar))
    return h
  })
  // Now inspect any literal strings in the parsed line for our hashes- replace these strings with
  // template literals containing the TTK vars.
  const hashRegex = new RegExp(`(${[...m.keys()].join('|')})`, 'g')
  const coll = jsc(sanitisedLine, { parser: { parse } })
  const result = coll
    .find(jsc.Literal)
    .filter((path) => hashRegex.test(path.value.value))
    .forEach((path) => {
      path.replace(
        jsc(`\`${path.value.value.replace(hashRegex, (matchedHash) => m.get(matchedHash))}\``).getAST()[0].value.program.body[0]
      )
    })
    .toSource()
  return result
}

const ttkRequestToItBlock = (ttkRequest) =>
  build.expressionStatement(
    build.callExpression(
      build.identifier('it'),
      [
        build.literal(ttkRequest.description),
        build.arrowFunctionExpression(
          [],
          build.blockStatement([
            ...parse(ttkRequest.scripts?.preRequest?.exec.join('\n') || '').body,
            build.variableDeclaration(
              "const",
              [
                build.variableDeclarator(
                  build.identifier('apiResult'),
                  build.objectExpression([
                    build.property(
                      'init',
                      build.identifier('operationPath'),
                      build.literal(ttkRequest.operationPath)
                    ),
                    build.property(
                      'init',
                      build.identifier('method'),
                      build.literal(ttkRequest.method),
                    ),
                    build.property(
                      'init',
                      build.identifier('headers'),
                      build.objectExpression(
                        Object.entries(ttkRequest.headers).map(([k, v]) =>
                          build.property(
                            'init',
                            build.literal(k),
                            build.literal(v)
                          )
                        )
                      ),
                    ),
                    build.property(
                      'init',
                      build.identifier('params'),
                      build.objectExpression(
                        Object.entries(ttkRequest.params || {}).map(([k, v]) =>
                          build.property(
                            'init',
                            build.literal(k),
                            build.literal(v)
                          )
                        )
                      ),
                    ),
                    build.property(
                      'init',
                      build.identifier('apiVersion'),
                      build.objectExpression([
                        build.property(
                          'init',
                          build.identifier('minorVersion'),
                          build.literal(ttkRequest.apiVersion.minorVersion)
                        ),
                        build.property(
                          'init',
                          build.identifier('majorVersion'),
                          build.literal(ttkRequest.apiVersion.majorVersion)
                        ),
                        build.property(
                          'init',
                          build.identifier('type'),
                          build.literal(ttkRequest.apiVersion.type)
                        ),
                        build.property(
                          'init',
                          build.identifier('asynchronous'),
                          build.literal(ttkRequest.apiVersion.asynchronous)
                        ),
                      ])
                    ),
                    ttkRequest.url !== undefined
                      ? build.property(
                        'init',
                        build.identifier('url'),
                        build.literal(ttkRequest.url),
                      )
                      : undefined
                  ].filter(el => el !== undefined))
                )
              ]
            ),
            ...parse(ttkRequest.scripts?.postRequest?.exec.join('\n') || '').body,
            ...(ttkRequest.tests.assertions.map(
              (test) => {
                const ast = parse(test.exec.map(replaceTtkVars).join('\n')).body
                ast[0].comments = [
                  build.commentLine(
                    `${test.description}`,
                    true,
                    false,
                  )
                ]
                return ast
              }
            ).flat() || [])
          ])
        )
      ]
    )
  )

const testCaseToDescribeBlock = (ttkTestCase) =>
  build.expressionStatement(
    build.callExpression(
      build.identifier('describe'),
      [
        build.literal(ttkTestCase.name),
        build.arrowFunctionExpression(
          [],
          build.blockStatement(ttkTestCase.requests.map(ttkRequestToItBlock))
        )
      ]
    )
  )

const ttkToAst = (ttkJson) =>
  build.file(
    build.program(
      ttkJson.test_cases.map(testCaseToDescribeBlock)
    ),
    ttkJson.name
  )

const ttkToJs = (ttkJson) => astring.generate(
  ttkToAst(ttkJson).program,
  { comments: true }
)

module.exports = {
  jsToTtk,
  ttkToAst,
  ttkToJs,
}

// vim: et ts=2 sw=2
