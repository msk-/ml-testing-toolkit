
const jsc = require('jscodeshift')

/**
 * Gets all var references by name. Warning: does not get all references to the same _data_;
 * instead, gets all variable references for any given name, whether or not these references refer
 * to the same data. For example, if a variable is shadowed, this method will return both
 * declarations and all references to those declarations.
 *
 * @param {string} newName
 * @return {Collection}
 */
function getAllVarReferencesByName(name) {
  return this
    .find(jsc.Identifier, { name })
    .filter(function(path) { // ignore non-variables
      const parent = path.parent.node
      // With thanks to the authors, the content here was copied from:
      // https://github.com/facebook/jscodeshift/blob/48f5d6d6e5e769639b958f1a955c83c68157a5fa/src/collections/VariableDeclarator.js#L85

      if (
        jsc.MemberExpression.check(parent) &&
        parent.property === path.node &&
        !parent.computed
      ) {
        // obj.oldName
        return false
      }

      if (
        jsc.Property.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // { oldName: 3 }
        return false
      }

      if (
        jsc.MethodDefinition.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // class A { oldName() {} }
        return false
      }

      if (
        jsc.ClassProperty.check(parent) &&
        parent.key === path.node &&
        !parent.computed
      ) {
        // class A { oldName = 3 }
        return false
      }

      if (
        jsc.JSXAttribute.check(parent) &&
        parent.name === path.node &&
        !parent.computed
      ) {
        // <Foo oldName={oldName} />
        return false
      }

      return true
    })
}

function renameIdentifiersTo(newName) {
  return this.forEach(function(path) {
    // In shorthand properties, "key" and "value" both have an
    // Identifier with the same structure.
    const parent = path.parent.node
    if (
      jsc.Property.check(parent) &&
      parent.shorthand &&
      !parent.method
    ) {
      path.parent.get('shorthand').replace(false)
    }

    path.get('name').replace(newName)
  })
}

function register(jscodeshift) {
  jscodeshift.registerMethods({
    getAllVarReferencesByName,
    // We don't register this as a typed method because it prevents calling it on an empty
    // collection (which may not have the required type). 
    renameIdentifiersTo,
  })
}

module.exports = {
  register,
}
