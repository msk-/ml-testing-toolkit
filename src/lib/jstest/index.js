const { ttkToAst, ttkToJs } = require('./generate')
const { jsToTtk } = require('./parse')

module.exports = {
  jsToTtk,
  ttkToAst,
  ttkToJs,
}
