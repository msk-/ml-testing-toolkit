
// TODO: high level documentation of this module, and the format that a javascript test must have

const crypto = require('crypto')
const acorn = require('acorn')
const astring = require('astring')
const _ = require('lodash')
const unquotedValidator = require('unquoted-property-validator')

const parse = (source) => acorn.parse(source, {
  // Because we're parsing single lines in pre-request scripts, i.e. snippets that might
  // exist inside an async function, we need to be able to parse await outside of a function.
  allowAwaitOutsideFunction: true,
  ecmaVersion: 2020,
})
const jsc = require('jscodeshift').withParser({ parse })
const build = jsc // could also be: `build = recast.types.builders` or `build = require('ast-types')`
const customMethods = require('./jsc-methods')
const {
  mlSyncClientLibName,
  prevIdentifierName,
  requestIdentifierName,
  responseIdentifierName,
} = require('./config')

customMethods.register(jsc)

const buildPreRequestScripts = (preRequestScript) => parse(preRequestScript?.exec.join('\n') || '').body

const buildRequestObject = (ttkRequest) =>
  build.variableDeclaration(
    "const",
    [
      build.variableDeclarator(
        build.identifier(requestIdentifierName),
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
          ttkRequest.headers
          ? build.property(
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
          )
          : undefined,
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
              ttkRequest.apiVersion.asynchronous
              ? build.property(
                'init',
                build.identifier('asynchronous'),
                build.literal(ttkRequest.apiVersion.asynchronous)
              )
              : undefined,
            ].filter((el) => el !== undefined))
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
  )

const buildRequestExprStmt = () =>
  build.variableDeclaration(
    'const',
    [
      build.variableDeclarator(
        build.identifier(responseIdentifierName),
        build.callExpression(
          build.identifier(mlSyncClientLibName),
          [build.identifier(requestIdentifierName)]
        )
      )
    ]
  )

const buildPrevAssignment = (ttkRequestId) =>
  build.expressionStatement(
    build.assignmentExpression(
      '=',
      build.memberExpression(
        build.identifier(prevIdentifierName),
        build.literal(ttkRequestId)
      ),
      build.objectExpression([
        build.property(
          'init',
          build.identifier('callback'),
          build.identifier(responseIdentifierName)
        ),
      ])
    )
  )

// Replace TTK vars in script elements with template literals
//
// Guided by the implementation here:
// https://github.com/mojaloop/ml-testing-toolkit/blob/1392f99ef85ca65968707e54a756a6975d9f67ff/src/lib/test-outbound/outbound-initiator.js#L576
// but with the constraint that we must produce valid javascript
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
      const ttkPrevRegex = /{\$prev\.([0-9]+).([^}]*)}/g
      const ttkFuncRegex = /{$function\.([^}]*)}/g
      const createPropertyAccessor = (propIdentifier) => {
        const { quotedValue, needsBrackets } = unquotedValidator(propIdentifier)
        return needsBrackets
          ? `[${quotedValue}]`
          : `.${propIdentifier}`
      }
      const ttkPrevReplacer = (match, prevId, prevPath) =>
        `{\$prev[${prevId}]${_.toPath(prevPath).map(createPropertyAccessor).join('')}}`
      return v.replace(ttkPrevRegex, ttkPrevReplacer)
        .replace(ttkFuncRegex, '{\$function.$1}')
        .replace(ttkVarRegex, '\${$1}')
    }
    const h = hash(ttkVar)
    m.set(h, ttkVarToTemplateLiteral(ttkVar))
    return h
  })
  // Now inspect any literal strings in the parsed line for our hashes- replace these strings with
  // template literals containing the TTK vars.
  // hashRegex as a function gets around the lastIndex problem: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/test#Using_test_on_a_regex_with_the_global_flag
  const hashRegex = () => new RegExp(`(${[...m.keys()].join('|')})`, 'g')
  const coll = jsc(sanitisedLine)
  const result = coll
    .find(jsc.Literal, (node) => hashRegex().test(node.value))
    .forEach((path) => {
      path.replace(
        parse(`\`${path.value.value.replace(hashRegex(), (matchedHash) => m.get(matchedHash))}\``)
          .body[0].expression
      )
    })
    .toSource()
  return result
}

const renameRequestResponse = (coll, ttkRequestId) => {
  coll
    .getAllVarReferencesByName(responseIdentifierName)
    .renameIdentifiersTo(responseIdentifierName + ttkRequestId)
  coll
    .getAllVarReferencesByName(requestIdentifierName)
    .renameIdentifiersTo(requestIdentifierName + ttkRequestId)
  return coll
}

const buildPostRequestScripts = (postRequestScripts) => {
  return jsc(postRequestScripts?.exec.join('\n') || '')
    .getAST()[0].value.program.body
}

const buildAssertions = (assertions) => assertions?.map(
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
)

const ttkRequestToBlock = (ttkRequest) => {
  const coll = jsc([
    // TODO: we don't use ttkRequest.description here anywhere- it would probably be useful as a
    // comment
    ...buildPreRequestScripts(ttkRequest?.scripts?.preRequest),
    buildRequestObject(ttkRequest),
    buildRequestExprStmt(),
    buildPrevAssignment(ttkRequest.id),
    ...buildPostRequestScripts(ttkRequest?.scripts?.postRequest),
    ...(buildAssertions(ttkRequest.tests?.assertions)?.flat() || []),
  ])
  coll
    .getAllVarReferencesByName(responseIdentifierName)
    .renameIdentifiersTo(responseIdentifierName + ttkRequest.id)
  coll
    .getAllVarReferencesByName(requestIdentifierName)
    .renameIdentifiersTo(requestIdentifierName + ttkRequest.id)
  return coll.nodes()
}

const testCaseToItBlock = (ttkTestCase) =>
  build.expressionStatement(
    build.callExpression(
      build.identifier('it'),
      [
        build.literal(ttkTestCase.name),
        build.arrowFunctionExpression(
          [],
          build.blockStatement(ttkTestCase.requests.map(ttkRequestToBlock).flat())
        )
      ]
    )
  )

const ttkToAst = (ttkJson) =>
  build.file(
    build.program(
      ttkJson.test_cases.map(testCaseToItBlock)
    ),
    ttkJson.name
  )

const ttkToJs = (ttkJson) => astring.generate(
  ttkToAst(ttkJson).program,
  { comments: true }
)

module.exports = {
  ttkToAst,
  ttkToJs,
  // testing only, not intended as part of the module API
  _: {
    replaceTtkVars,
  }
}

// vim: et ts=2 sw=2
