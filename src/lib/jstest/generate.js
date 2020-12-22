
// TODO: high level documentation of this module, and the format that a javascript test must have

const crypto = require('crypto')
const acorn = require('acorn')
const astring = require('astring')
const jsc = require('jscodeshift')
const build = jsc // could also be: `build = recast.types.builders` or `build = require('ast-types')`
const parse = (source) => acorn.parse(source, {
  // Because we're parsing single lines in pre-request scripts, i.e. snippets that might
  // exist inside an async function, we need to be able to parse await outside of a function.
  allowAwaitOutsideFunction: true,
  ecmaVersion: 2020,
})
const {
  mlSyncClientLibName,
  prevIdentifierName,
  requestIdentifierName,
  responseIdentifierName,
} = require('./config')

const buildPreRequestScripts = (preRequestScript) => parse(preRequestScript?.exec.join('\n') || '').body

const renameUndeclaredVar = (coll, oldName, newName) =>
  coll
    .find(jsc.Identifier, {name: oldName})
    .filter(function(path) { // ignore non-variables
      const parent = path.parent.node;

      if (
        jsc.MemberExpression.check(parent) &&
        parent.property === path.node &&
        !parent.computed
      ) {
        // obj.oldName
        return false;
      }

      if (
        jsc.Property.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // { oldName: 3 }
        return false;
      }

      if (
        jsc.MethodDefinition.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // class A { oldName() {} }
        return false;
      }

      if (
        jsc.ClassProperty.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // class A { oldName = 3 }
        return false;
      }

      if (
        jsc.JSXAttribute.check(parent) &&
        parent.name === path.node &&
        !parent.computed
      ) {
        // <Foo oldName={oldName} />
        return false;
      }

      return true;
    })
    .forEach(function(path) {
      // It may look like we filtered out properties,
      // but the filter only ignored property "keys", not "value"s
      // In shorthand properties, "key" and "value" both have an
      // Identifier with the same structure.
      const parent = path.parent.node;
      if (
        jsc.Property.check(parent) &&
        parent.shorthand &&
        !parent.method
      ) {
        path.parent.get('shorthand').replace(false);
      }

      path.get('name').replace(newName);
    })

const buildRequestObject = (ttkRequest) =>
  build.variableDeclaration(
    "const",
    [
      build.variableDeclarator(
        build.identifier(requestIdentifierName + ttkRequest.id),
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

const buildRequestExprStmt = (ttkRequestId) =>
  build.variableDeclaration(
    'const',
    [
      build.variableDeclarator(
        build.identifier(responseIdentifierName + ttkRequestId),
        build.callExpression(
          build.identifier(mlSyncClientLibName),
          [build.identifier(requestIdentifierName + ttkRequestId)]
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
  // hashRegex as a function gets around the lastIndex problem: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/test#Using_test_on_a_regex_with_the_global_flag
  const hashRegex = () => new RegExp(`(${[...m.keys()].join('|')})`, 'g')
  const coll = jsc(sanitisedLine, { parser: { parse } })
  const result = coll
    .find(jsc.Literal, (node) => hashRegex().test(node.value))
    .forEach((path) => {
      path.replace(
        jsc(`\`${path.value.value.replace(hashRegex(), (matchedHash) => m.get(matchedHash))}\``).getAST()[0].value.program.body[0]
      )
    })
    .toSource()
  return result
}

const buildPostRequestScripts = (postRequestScripts, ttkRequestId) =>
  renameUndeclaredVar(
    jsc(postRequestScripts?.exec.join('\n') || '', { parser: { parse } }),
    responseIdentifierName,
    responseIdentifierName + ttkRequestId
  ).getAST()[0].value.program.body

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

const ttkRequestToBlock = (ttkRequest) => [
  // TODO: we don't use ttkRequest.description here anywhere- it would probably be useful as a
  // comment
  ...buildPreRequestScripts(ttkRequest?.scripts?.preRequest),
  buildRequestObject(ttkRequest),
  buildRequestExprStmt(ttkRequest.id),
  buildPrevAssignment(ttkRequest.id),
  // TODO: replace usage of ${response} with ${responseN} and ${request} with ${requestN}, where N
  // is the request ID, as required
  ...buildPostRequestScripts(ttkRequest?.scripts?.postRequest, ttkRequest.id),
  ...(buildAssertions(ttkRequest.tests?.assertions)?.flat() || [])
]

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
