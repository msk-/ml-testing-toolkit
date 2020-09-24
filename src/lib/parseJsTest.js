
// A note about this code: every `assert` call here has a corresponding test. At the time of
// writing, they're all in the same order in the tests as they are in this file.

const assert = require('assert').strict
const jsc = require('jscodeshift')
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
} = require('jsc-utils');

const parseJsTest = (filepath, src) => {
  const j = jsc(src)

  // ==========
  // Perform a few assertions on the code to make sure we can work with it
  // ==========
  // 1. identify the call to `require('sync-client')`
  // 2. get the variable to which the `require` result was assigned
  //   - TODO: handle the case where it's destructured
  const mlSyncClientLibName = 'sync-client';
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
  const syncClientIdentifier = syncClientCalls[0].parentPath.value.id.name;
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

  const testCases = itCallExprPaths.map((itCallExprPath) => {
    // Get all requests made in the test
    const requestDeclarators = jsc(itCallExprPath)
      .find(jsc.CallExpression)
      .filter((path) => path.value.callee.name === syncClientIdentifier)
      .map((path) => path.get('arguments').get('0'))
      .map((path) => jsc(path.scope.path).findVariableDeclarators(path.value.name).paths())
      .paths()
    // TODO: Assert they're of the correct form.
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
  })

  // within each `it` function call, get every API request using the ML client lib
  // 3. find instances of that variable that are used to make/build a request

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
            id: 'index in test',
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
            url: 'this is really the host name', // TODO: get from the request
            scripts: {
              preRequest: {
                exec: [
                  // some code, but what, exactly?
                ]
              },
              // TODO: the other whatever nonsense "script"
            }
          }
        ]
      }
    ]
  }
}

module.exports = parseJsTest
