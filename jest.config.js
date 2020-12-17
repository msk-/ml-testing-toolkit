const path = require('path')
module.exports = {
  verbose: true,
  collectCoverageFrom: [
    '**/src/**/**/*.js'
  ],
  coverageThreshold: {
    global: {
      statements: 95,
      functions: 95,
      branches: 95,
      lines: 95
    }
  },
  modulePathIgnorePatterns: ['spec_files'],
  testEnvironment: 'node',
  globals: {
    // Allows us to consistently refer to directories relative to the source root in our tests,
    // such as the examples directory
    "__PROJECT_ROOT__": path.resolve(__dirname)
  }
}
