/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.
 * Gates Foundation

 * ModusBox
 * Georgi Logodazhki <georgi.logodazhki@modusbox.com> (Original Author)
 --------------
 ******/
const { readRecursiveAsync } = require('./utils')
const fs = require('fs').promises
const path = require('path')
const jsc = require('jscodeshift')
const { jsToTtk } = require('./jsTest')

const bySuffix = (suffixes) => (filename) => suffixes.some(suffix => filename.endsWith(suffix))
const getFiles = async (path, suffixes) => (await readRecursiveAsync(path)).filter(bySuffix(suffixes))
const getFilesWithFileSize = async (path, suffixes) => {
  const files = await getFiles(path, suffixes)
  return Promise.all(
    files.map(async file => ({
      name: file,
      size: (await fs.stat(file)).size
    }))
  )
}

// load collections or environments
const getEnvironments = async (type) => await getFiles(`examples/environments/${type || ''}`, ['.json'])
const getCollections = async (type) => await getFiles(`examples/collections/${type || ''}`, ['.json', '.js'])

// load environments with file sizes
const getEnvironmentsWithFileSize = async (type) => await getFilesWithFileSize(`examples/environments/${type || ''}`, ['.json'])
const getCollectionsWithFileSize = async (type) => await getFilesWithFileSize(`examples/collections/${type || ''}`, ['.json', '.js'])

// load samples content
const getSample = async (queryParams) => {
  const collections = []
  if (queryParams.collections) {
    for (const i in queryParams.collections) {
      const collection = await fs.readFile(queryParams.collections[i], 'utf8')
      collections.push(JSON.parse(collection))
    }
  }
  const sample = {
    name: null,
    inputValues: null,
    test_cases: null
  }

  if (queryParams.environment) {
    sample.inputValues = JSON.parse(await fs.readFile(queryParams.environment, 'utf8')).inputValues
  }

  if (collections.length > 1) {
    sample.name = 'multi'
    sample.test_cases = []
    let index = 1
    collections.forEach(collection => {
      collection.test_cases.forEach(testCase => {
        const { id, ...remainingTestCaseProps } = testCase
        sample.test_cases.push({
          id: index++,
          ...remainingTestCaseProps
        })
      })
    })
  } else if (collections.length === 1) {
    sample.name = collections[0].name
    sample.test_cases = collections[0].test_cases
  }
  return sample
}

const parseCollection = (filepath, fileContent) => {
  const ext = path.extname(filepath);
  switch (ext) {
    case '.js':
      return jsToTtk(fileContent)
    case '.json':
      return JSON.parse(fileContent)
    default:
      throw new Error(`Collection filetype '${ext}' unsupported`)
  }
}

// load samples content
const getSampleWithFolderWise = async (queryParams) => {
  const collections = await Promise.all((queryParams.collections || []).map(async coll => {
    const [fileContent, stat] = await Promise.all([
      fs.readFile(coll, 'utf8'),
      fs.stat(coll)
    ])
    return {
      name: coll,
      path: coll,
      size: stat.size,
      modified: stat.mtime,
      content: parseCollection(coll, fileContent)
    }
  }))

  let environment = {}
  if (queryParams.environment) {
    environment = JSON.parse(await fs.readFile(queryParams.environment, 'utf8')).inputValues
  }

  return {
    collections,
    environment
  }
}

module.exports = {
  getCollections,
  getEnvironments,
  getCollectionsWithFileSize,
  getEnvironmentsWithFileSize,
  getSample,
  getSampleWithFolderWise
}
