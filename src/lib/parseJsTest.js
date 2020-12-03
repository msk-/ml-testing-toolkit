
// A note about this code: every `assert` call here has a corresponding test. At the time of
// writing, they're all in the same order in the tests as they are in this file.

const assert = require('assert').strict
const jsc = require('jscodeshift')
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
const parseJsTest = (filepath, src) => {
  const j = jsc(src)

  // ==========
  // Perform a few assertions on the code to make sure we can work with it
  // ==========
  // 1. identify the call to `require('sync-client')`
  // 2. get the variable to which the `require` result was assigned
  //   - TODO: handle the case where it's destructured, or disallow this
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

    const getRequestArgs = (coll) => coll
      .map((syncClientFunctionCall) => syncClientFunctionCall.get('arguments').get('0'))
      .map((syncClientFunctionArg) =>
        // If the argument is a POJO, then we'll return it, otherwise find where it's defined and
        // return that.
        // TODO: what happens in the following case:
        //   const request = {}
        //   request.url = 'hahahaha now it\'s difficult isn\'t it?!'
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
    //   literals etc. can be managed by that process.
    // - Naive, initial implementation shouldn't attempt to resolve variable definitions. This is a
    //   pretty tricky problem to solve. So users _using_ TTK UI will just have to replace
    //   variables with literals, or reuse variables. We _could_ provide a UI later on for
    //   definition of shared data.
    // - It would certainly be easier to push enforcing the form of the request into `sync-client`
    //   (or whatever that ends up being called)- perhaps by having it take an openapi spec and
    //   some config or something?
    // - Is this type-checking? Is that something we should just ignore? It's a dynamic language,
    //   after all..

    const getAssertions = (coll) => coll
      .find(jsc.CallExpression)
      .filter((path) => path.value.callee.name === 'expect')
      .paths()
    const assertions = getAssertions(itBodyColl)
    assert(assertions.length > 0, 'Expected at least one assertion ("expect" function call) per test')

    // Here we identify the boundaries between requests and assertions. These boundaries correspond
    // to "requests" in the parlance of TTK.
    // Procedurally speaking, what we are doing here is looking for each sync-client request, then
    // working backward to the closest preceding assertion (or the beginning of the test block).
    // That assertion is the boundary that defines the end of the preceding TTK request and the
    // beginning of the current TTK request.
    const assertionExprStmtsRev = assertions
      .map(traverseUpwardUntilTestBlock)
      .sort((m, n) => m.name - n.name)
      .reverse()
    const requests = requestFunctionCalls
      .map(traverseUpwardUntilTestBlock)
      .map((reqPath) =>
        // Find the start of the TTK request as the last assertion preceding the current request,
        // or zero as the first statement in the it block.
        assertionExprStmtsRev.find((assertion) => assertion.name < reqPath.name)?.name + 1 || 0
      )
      .map((start, i, arr) => ({
        // Turn the start into a start and end by using the start of the following request as the
        // end of the current request. Return a half-open range [start,end).
        start,
        end: (arr[i + 1] || itBody.value.length)
      }))
      .map(({ start, end }) => jsc(Array.from(
        // Turn the start and end indices into a collection of NodePaths representing all nodes in
        // the request
        { length: end - start },
        (_, i) => itBody.get(`${i + start}`)
      )))
      .map((coll) => {
        // Here we'll actually build a result in the TTK request format
        const requests = getRequestFunctionCalls(coll)
        // These two assertions are pretty difficult to trigger. In fact, they should be impossible
        // to trigger, if the code is correct. We therefore do not have tests for these, but have
        // them as runtime errors should they occur.
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
          //     support things like fixtures
          'Expected TTK request client argument to be an ObjectExpression'
        )
        // TODO: currently this only allows POJOs constructed with literals. No references or
        // anything of the sort. Needs work.
        const objExprToObjNaive = (objExpr) => {
          switch (objExpr.type) {
            case 'ObjectExpression':
              return Object.fromEntries(
                objExpr.properties.map((prop) => ([ prop.key.name, objExprToObjNaive(prop.value) ]))
              )
            case 'Literal':
              return objExpr.value
            default:
              throw new Error(`Unhandled object type for ${summarise(objExpr)} when validating the request object`)
          }
        }
        const requestObj = objExprToObjNaive(requestArgNode)
        const validationResult = requestValidator(requestObj);
        // TODO: better guidance on resolving these issues
        assert(
          requestValidator(requestObj),
          `Request object invalid. Errors: ${JSON.stringify(requestValidator.errors, null, 2)}`
        )
        return requestObj
      })

    console.log(requests)

    // Extract the code between requests as the "scripts". For now, we'll do this naively and say
    // everything since the last assertion preceding the current request, until the current request
    // is a "pre-request" "script". Any assertions between the current request and the subsequent
    // request are assertions associated with that request. And any code that occurs between the
    // current request and that last assertion is a "post-request" "script"- we'll strip all of the
    // assertions out of these "scripts".
    // Example:
    //   const client = require('sync-client')
    //   it('makes a quote request', () => {
    //     // pre-request script begins:
    //     const getParty = {
    //       method: 'get',
    //       url: 'mojaloop.io',
    //       operationPath: '/parties/MSISDN/12345',
    //       ... etc.
    //     }
    //     console.log(getParty)
    //     // pre-request script ends
    //     // request:
    //     const resp = client(getParty)
    //     // post-request script begins
    //     expect(resp).toBe('whatever')
    //     console.log(resp)
    //     const derivativeOfResponse = deriveSomethingFrom(resp)
    //     const derivativeOfRequest = deriveSomethingFrom(getParty)
    //     expect(derivativeOfRequest).toEqual(derivativeOfResponse)
    //     // post-request script ends
    //     // next pre-request script begins
    //     const postQuote = {
    //       method: 'post',
    //       url: 'mojaloop.io',
    //       operationPath: '/quotes',
    //       ... etc.
    //     }
    //     console.log(postQuote)
    //     // .. etc.
    //   })
    // Recursively split the body node array based on the aforementioned rules
  })

  // const requests = itCallExprs.

  return {
    name: filepath,
    // Each "test case" must correspond to a single javascript test, let's say an "it" call.
    //
    // 1 Tricky, because these can be nested multiple "describe" calls deep. So, what will we do
    //   about this? Nothing? Enforce describe depth = 1? Are describe calls optional?
    // 2 What's the other nomenclature available? Is it describe/test?
    // 3 How do we handle the fact that javascript is probably considerably more flexible than
    //   we're likely willing to handle here?
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

module.exports = parseJsTest

// vim: et ts=2 sw=2
