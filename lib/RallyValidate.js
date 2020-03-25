// Set the config file info and requirements
const configFile = 'probot-rally.yml'
const outdent = require('outdent')
var rally = require('rally')

const queryUtils = rally.util.query

class RallyValidate {
  constructor (robot) {
    this.robot = robot
  }

  async sleep (ms) {
    return new Promise(resolve => {
      setTimeout(resolve, ms)
    })
  }

  async initializeRallyClient (config) {
    let rallyServer = process.env.RALLY_SERVER
    let rallyUsername = process.env.RALLY_USERNAME
    let rallyPassword = process.env.RALLY_PASSWORD
    let rallyAPIKey = process.env.RALLY_API_KEY

    if (config.rally) {
      if (config.rally.server) { // Specify the RallyDev URL
        rallyServer = config.rally.server
      }
      if (config.rally.username) { // Rally Username (should be stored elsewhere)
        rallyUsername = config.rally.username
      }
      if (config.rally.password) { // Rally Password, to override global defaults
        rallyPassword = config.rally.password
      }
      if (config.rally.api_key) { // Rally API key, to override global default
        rallyAPIKey = config.rally.api_key
      }
    }

    const rallyClient = rally({
      user: rallyUsername, // Required if no api key, defaults to process.env.RALLY_USERNAME
      pass: rallyPassword, // Required if no api key, defaults to process.env.RALLY_PASSWORD
      apiKey: rallyAPIKey, // Preferred, required if no user/pass, defaults to process.env.RALLY_API_KEY
      apiVersion: 'v2.0', // This is the default and may be omitted
      server: rallyServer, // This is the default and may be omitted
      requestOptions: {
        headers: {
          'X-RallyIntegrationName': 'Probot-Rally', // while optional, it is good practice to
          'X-RallyIntegrationVendor': 'GitHub, Inc', // provide this header information
          'X-RallyIntegrationVersion': '1.0'
        }
        // any additional request options (proxy options, timeouts, etc.)
      }
    })

    return rallyClient
  }

  async handlePullRequest (context) {
    // Initialize Rally Artifacts
    const rallyArtifacts = {}

    this.robot.log.debug(context)

    // Get our config file
    const config = await context.config(configFile)
    // Confirm that the config file exists
    if (!config) {
      // Check environment variable to see whether we need to enforce on this repository
      if (process.env.ENFORCE_ALL_REPOS === 'true') {
        await this.setStatusFail(context, this.createNoConfigMessage())
      }
      return
    }

    // Set the status to in_progress
    await this.setStatusPending(context)

    try {
      const rallyClient = await this.initializeRallyClient(config)
      // Get commit comments for validation
      rallyArtifacts.commits = await this.checkCommitMessages(context, config, rallyClient)
      // Get the PR title for validation
      rallyArtifacts.titleList = await this.checkPRTitle(context, config, rallyClient)
      // Get the PR body for validation
      rallyArtifacts.bodyList = await this.checkPRBody(context, config, rallyClient)
      // Get the PR labels for validation
      rallyArtifacts.labelList = await this.checkPRLabels(context, config, rallyClient)

      await this.updateRallyConnections(rallyClient, rallyArtifacts, context.payload.pull_request, config)
    } catch (e) {
      await this.setStatusFail(context, 'Error occurred while validating Rally Artifacts: ' + e)
      return
    }

    // Set the status message
    const { statusMessage, isSuccess } = await this.processArtifacts(config, rallyArtifacts)
    // Set the check status based on Rally artifact validation
    if (isSuccess) {
      await this.setStatusPass(context, statusMessage)
    } else {
      await this.setStatusFail(context, statusMessage)
    }

    if (config.commentOnPull) {
      // Comment on the PR
      await this.commentOnPull(context, statusMessage)
    }
  }

  async handlePullRequestClosed (context) {
    // Only close Rally Artifacts if PR is merged
    if (context.payload.pull_request.merged === false) {
      return
    }
    const config = await context.config(configFile)

    if (!config) {
      // Check environment variable to see whether we need to enforce on this repository
      if (process.env.ENFORCE_ALL_REPOS === 'true') {
        await this.setStatusFail(context, this.createNoConfigMessage())
      }
      return
    }

    const rallyClient = await this.initializeRallyClient(config)
    this.closeArtifactsFromPRBody(context, config, rallyClient)
  }

  createStatusMessage ({ checkPRLabels, checkPRBody, checkPRTitle, checkCommitMessages, statuses, projects, bodyMessage, titleMessage, labelMessage, commitsMessage }) {
    return outdent`This repository requires a valid Rally artifact to be present in the following portions of this pull before merge will be allowed:

    ${checkPRLabels}
    ${checkPRBody}
    ${checkPRTitle}
    ${checkCommitMessages}

    _Valid artifact states for this repository_:

    ${statuses}

    _Valid projects for this repository_

    ${projects}

    ${bodyMessage}
    ${titleMessage}
    ${labelMessage}
    ${commitsMessage}
    `
  }

  // Process the artifacts
  async processArtifacts (config, rallyArtifacts) {
    const statuses = config.artifactStatuses.map(status => `- [x] \`${status}\``)
    const projects = config.rallyProjects.map(project => `- [x] \`${project}\``)

    const statusMessageOptions = {
      checkPRLabels: config.checkPRLabels ? '- [x] Pull Request Labels' : '- [ ] Pull Request Labels',
      checkPRBody: config.checkPRBody ? '- [x] Pull Request Body' : '- [ ] Pull Request Body',
      checkPRTitle: config.checkPRTitle ? '- [x] Pull Request Title' : '- [ ] Pull Request Title',
      checkCommitMessages: config.checkCommitMessages ? '- [x] Commit Messages' : '- [ ] Commit Messages',
      statuses: statuses.join('\n'),
      projects: projects.join('\n')
    }

    let bodyResult = {
      message: '',
      isSuccess: true
    }
    let titleResult = {
      message: '',
      isSuccess: true
    }
    let labelResult = {
      message: '',
      isSuccess: true
    }
    let commitsResult = {
      message: '',
      isSuccess: true
    }

    if (config.checkPRBody) {
      bodyResult = await this.formatBodyMessage(config, rallyArtifacts.bodyList)
    }
    if (config.checkPRTitle) {
      titleResult = await this.formatTitleMessage(config, rallyArtifacts.titleList)
    }
    if (config.checkPRLabels) {
      labelResult = await this.formatLabelMessage(config, rallyArtifacts.labelList)
    }
    if (config.checkCommitMessages) {
      commitsResult = await this.formatCommitsMessage(config, rallyArtifacts.commits.commitsWithArtifact, rallyArtifacts.commits.commitsWithoutArtifact)
    }

    const isSuccess = (bodyResult.isSuccess && titleResult.isSuccess && labelResult.isSuccess && commitsResult.isSuccess)

    Object.assign(statusMessageOptions, {
      bodyMessage: bodyResult.message,
      titleMessage: titleResult.message,
      labelMessage: labelResult.message,
      commitsMessage: commitsResult.message
    })

    const statusMessage = this.createStatusMessage(statusMessageOptions)

    return { statusMessage, isSuccess }
  }

  /**
   * Pull Request Labels
   * Format the check body and/or pull request comment body
   * with the status of label validation
   * @param config
   * @param labelsList
   */
  async formatLabelMessage (config, labelsList) {
    // Default isSuccess to true, then set to fail if matches fail
    let isSuccess = true
    // Set the content headers
    let message = '\n### Label validation\n'
    // Format the message for labels
    if (labelsList && labelsList.length > 0) {
      message += 'The following labels have been applied, with validation status below\n\n'
      message += '| Artifact | Rally Status | Project | Validation |\n'
      message += '| --- | --- | --- | --- |\n'
      labelsList.forEach(artifact => {
        if (!artifact.isValid) { isSuccess = false }
        // Append the status to the PR comment
        message += `| ${artifact.key} | \`${artifact.status}\` | \`${artifact.projectName}\` | ${artifact.statusIcon} \`${artifact.validState}\` |\n`
      })
    } else {
      message += '\n:heavy_exclamation_mark: No valid artifacts were found in the pull request labels'
      isSuccess = false
    }
    return { message, isSuccess }
  }

  /**
   * Pull Request Body
   *
   * Format the check body and/or pull request comment body
   * with the status of the PR body validation
   * @param config
   * @param bodyList
   */
  async formatBodyMessage (config, bodyList) {
    // Default isSuccess to true, then set to fail if matches fail
    let isSuccess = true
    // Set the content headers
    let message = '\n### Pull Request body validation\n'
    // Format the message for the PR body
    if (bodyList && bodyList.length > 0) {
      message += 'The following Rally artifacts have been found in the body of this pull request, with validation status below\n\n'
      message += '| Artifact | Rally Status | Project | Validation |\n'
      message += '| --- | --- | --- | --- | \n'
      bodyList.forEach(artifact => {
        if (!artifact.isValid) { isSuccess = false }
        // Append the status to the PR comment
        message += `| ${artifact.key} | \`${artifact.status}\` | \`${artifact.projectName}\` | ${artifact.statusIcon} \`${artifact.validState}\` |\n`
      })
    } else {
      message += '\n:heavy_exclamation_mark: No valid artifacts were found in the pull request body'
      isSuccess = false
    }
    return { message, isSuccess }
  }

  /**
  * Pull Request Title
  *
  * Format the check body and/or pull request comment body
  * with the status of the PR title validation
  * @param config
  * @param bodyList
  */
  async formatTitleMessage (config, titleList) {
    // Default isSuccess to true, then set to fail if matches fail
    let isSuccess = true
    // Set the content headers
    let message = '\n### Pull Request title validation\n'
    // Format the message for PR title
    if (titleList && titleList.length > 0) {
      message += 'The following Rally artifacts have been found in the title of this pull request, with validation status below\n\n'
      message += '| Artifact | Rally Status | Project | Validation |\n'
      message += '| --- | --- | --- | --- |\n'
      titleList.forEach(artifact => {
        if (!artifact.isValid) { isSuccess = false }
        // Append the status to the PR comment
        message += `| ${artifact.key} | \`${artifact.status}\` | \`${artifact.projectName}\` | ${artifact.statusIcon} \`${artifact.validState}\` |\n`
      })
    } else {
      message += '\n:heavy_exclamation_mark: No valid artifacts were found in the pull request body'
      isSuccess = false
    }
    return { message, isSuccess }
  }

  /**
  * Pull Request Title
  *
  * Format the check body and/or pull request comment body
  * with the status of the commit message validation
  * @param config
  * @param commitsWithArtifact
  * @param commitsWithoutArtifact
  */
  async formatCommitsMessage (config, commitsWithArtifact = [], commitsWithoutArtifact = []) {
    // Default isSuccess to true, then set to fail if matches fail
    let isSuccess = true

    // Set the content headers
    let message = '\n### Commit validation\n'
    message += '| Artifact | Commit SHA | Rally Status | Project | Validation |\n'
    message += '| --- | --- | --- | --- | --- |\n'
    // Process commits with Rally artifacts in them
    commitsWithArtifact.forEach(artifact => {
      if (!artifact.rally.isValid) { isSuccess = false }
      // Append the status to the PR comment
      message += `| ${artifact.rally.key} | [${artifact.sha_short}](${artifact.commit_url}) | \`${artifact.rally.status}\` | \`${artifact.rally.projectName}\` | ${artifact.rally.statusIcon} \`${artifact.rally.validState}\` |\n`
    })
    // Process commits without Rally artifacts
    if (commitsWithoutArtifact && commitsWithoutArtifact.length > 0) {
      let commitsColumn = ''
      commitsWithoutArtifact.forEach(commit => {
        commitsColumn += `[${commit.sha_short}](${commit.commit_url})<br>`
      })
      message += `| \`missing\` | ${commitsColumn} | \`missing\` | \`missing\` | :heavy_exclamation_mark: \`failed\` |\n`
      message += '\n**Note:** You can [amend you commit message](https://help.github.com/en/github/committing-changes-to-your-project/changing-a-commit-message) if needed\n\n'
      isSuccess = false
    }
    return { message, isSuccess }
  }

  // Comment on the pull request
  async commentOnPull (context, message) {
    const params = context.artifact({ body: message })
    await context.github.artifacts.createComment(params)
  }

  async checkCommitMessages (context, config, rallyClient) {
    const commitsWithArtifact = []
    const commitsWithoutArtifact = []
    // Only check commit messages if specified in the config
    if (config.checkCommitMessages) {
      // Get the URL for the pull request
      const commitsUrl = context.payload.pull_request.html_url
      // Get all the commits in the pull request
      const compare = await context.github.repos.compareCommits(context.repo({
        base: context.payload.pull_request.base.sha,
        head: context.payload.pull_request.head.sha
      }))

      // Check that every commit message has a Rally artifact in it
      for (const data of compare.data.commits) {
        const rallyArtifact = this.findArtifact(data.commit.message, config.rallyObjects)
        const commitStatus = {
          sha: data.sha,
          message: data.commit.message,
          sha_short: data.sha.substr(0, 6),
          commit_url: `${commitsUrl}/commits/${data.sha}`,
          rally: await this.validateArtifact(rallyClient, rallyArtifact[0], 'commitMessages', context.payload.pull_request, config)
        }
        // Group commits with keys and those without
        if (commitStatus.rally) {
          commitsWithArtifact.push(commitStatus)
        } else {
          commitsWithoutArtifact.push(commitStatus)
        }
      }
      return { commitsWithArtifact, commitsWithoutArtifact }
    }
  }

  async checkPRTitle (context, config, rallyClient) {
    if (config.checkPRTitle) {
      // Look for artifact keys in the PR title
      const artifactKeys = this.findArtifact(context.payload.pull_request.title, config.rallyObjects)
      if (artifactKeys) { // validate each key we find
        return Promise.all(artifactKeys.map(artifactKey => {
          return this.validateArtifact(rallyClient, artifactKey, 'prTitle', context.payload.pull_request, config)
        }))
      } else {
        this.robot.log.debug('No artifact found in PR title')
      }
    }
  }

  async checkPRBody (context, config, rallyClient) {
    if (config.checkPRBody) {
      // Look for artifact keys in the PR body
      const artifactKeys = this.findArtifact(context.payload.pull_request.body, config.rallyObjects)
      if (artifactKeys) { // validate each key we find
        return Promise.all(artifactKeys.map(artifactKey => {
          return this.validateArtifact(rallyClient, artifactKey, 'prBody', context.payload.pull_request, config)
        }))
      } else {
        this.robot.log.debug('No artifact found in PR body')
      }
    }
  }

  async closeArtifactsFromPRBody (context, config, rallyClient) {
    if (config.mergeOnPRBody) {
      // Look for artifact keys in the PR body
      const artifactKeys = this.findPromotionArtifact(context.payload.pull_request.body, config.rallyObjects, ['completes'])
      if (artifactKeys) { // close on each key we find
        return Promise.all(artifactKeys.map(artifactKey => {
          return this.promoteArtifact(rallyClient, artifactKey, config)
        }))
      } else {
        this.robot.log.debug('No artifact found in PR body')
      }
    }
  }

  async checkPRLabels (context, config, rallyClient) {
    if (config.checkPRLabels) {
      // Create an empty array for storing all valid artifact ID's
      const artifactKeys = []
      // Check each label to see if it contains an artifact ID
      for (const label of context.payload.pull_request.labels) {
        const artifactKey = this.findArtifact(label.name, config.rallyObjects)
        if (artifactKey) {
          artifactKeys.push(...artifactKey)
        }
      }
      // Determine if we found any artifact ID's
      if (artifactKeys && artifactKeys.length > 0) { // Validate any found artifacts
        return Promise.all(artifactKeys.map(artifactKey => {
          return this.validateArtifact(rallyClient, artifactKey, 'prLabel', context.payload.pull_request, config)
        }))
      } else {
        this.robot.log.debug('No artifact found in PR labels')
      }
    }
  }

  async setStatusPending (context) {
    return context.github.checks.create(context.repo({
      name: 'rally/validator',
      head_branch: context.payload.pull_request.head.ref,
      head_sha: context.payload.pull_request.head.sha,
      status: 'in_progress',
      started_at: new Date(),
      output: {
        title: 'Rally validation is in progress...',
        summary: 'We\'re currently validating the status of any Rally artifacts associated with this pull request. Please stand by.'
      }
    }))
  }

  async setOverridePass (context) {
    const timeStart = new Date()
    return context.github.checks.create(context.repo({
      name: 'rally/validator',
      head_branch: context.payload.check_run.check_suite.head_branch,
      head_sha: context.payload.check_run.head_sha,
      status: 'completed',
      started_at: timeStart,
      conclusion: 'success',
      completed_at: new Date(),
      output: {
        title: 'Rally artifact validation manually overridden by @' + context.payload.sender.login,
        summary: 'Commit sign-off was manually approved by @' + context.payload.sender.login
      }
    }))
  }

  async setStatusPass (context, statusMessage = 'All Rally artifacts have been validated!') {
    const timeStart = new Date()
    return context.github.checks.create(context.repo({
      name: 'rally/validator',
      head_branch: context.payload.pull_request.head.ref,
      head_sha: context.payload.pull_request.head.sha,
      status: 'completed',
      started_at: timeStart,
      conclusion: 'success',
      completed_at: new Date(),
      output: {
        title: 'Rally artifacts have been validated',
        summary: statusMessage
      }
    }))
  }

  async setStatusFail (context, statusMessage = 'Please provide a valid Rally artifact') {
    const timeStart = new Date()
    return context.github.checks.create(context.repo({
      name: 'rally/validator',
      head_branch: context.payload.pull_request.head.ref,
      head_sha: context.payload.pull_request.head.sha,
      status: 'completed',
      started_at: timeStart,
      conclusion: 'failure',
      completed_at: new Date(),
      output: {
        title: 'Rally artifact validation failed',
        summary: statusMessage
      }
    }))
  }

  createNoConfigMessage () {
    let noConfigMessage = 'No config file exists in this repository. Please create a valid config file at `.github/probot-rally.yml`\n\nExample config file:\n\n'

    noConfigMessage += `---
    # Name of the GitHub Check
    checksName: rally/validator

    # Check PR Labels for Rally artifact
    checkPRLabels: true

    # Check PR Body for Rally artifact
    checkPRBody: true

    # Check PR Title for Rally artifact
    checkPRTitle: true

    # Check all commit messages for a Rally artifact
    checkCommitMessages: true

    # List of Rally statuses that an artifact must be in in order to pass
    artifactStatuses: ['Open', 'To Do', 'In Progress']

    # Comment on the PR in addition to the check message?
    commentOnPull: false"
    `
    return noConfigMessage
  }

  findArtifact (text, artifactTypes) {
    let artifacts = []

    // Get all unique artifact prefixes based on the requested artifactTypes
    let prefixes = []
    const prefixMapping = {
      defect: ['D', 'DE'],
      defectsuite: ['DS'],
      task: ['TA'],
      testcase: 'TC',
      hierarchicalrequirement: ['S', 'US'],
      userstory: ['S', 'US'],
      story: ['S', 'US']
    }
    artifactTypes.forEach((type) => {
      const newPrefixes = prefixMapping[type]
      prefixes = prefixes.concat(newPrefixes)
    })
    prefixes = [...new Set(prefixes)]

    prefixes.forEach(prefix => {
      const regexp = RegExp('\\b' + prefix + '[0-9]{1,10}\\b', 'gi')
      const artifactMatches = text.match(regexp)
      if (artifactMatches) {
        artifacts = artifacts.concat(artifactMatches)
      }
    })
    return artifacts
  }

  findPromotionArtifact (text, artifactTypes, promotionCommands) {
    let artifacts = []

    // Get all unique artifact prefixes based on the requested artifactTypes
    let prefixes = []
    const prefixMapping = {
      defect: ['D', 'DE'],
      defectsuite: ['DS'],
      task: ['TA'],
      testcase: 'TC',
      hierarchicalrequirement: ['S', 'US'],
      userstory: ['S', 'US'],
      story: ['S', 'US']
    }
    artifactTypes.forEach((type) => {
      const newPrefixes = prefixMapping[type]
      prefixes = prefixes.concat(newPrefixes)
    })
    prefixes = [...new Set(prefixes)]

    if (promotionCommands && promotionCommands.length > 0) {
      promotionCommands.forEach(command => {
        prefixes.forEach(prefix => {
          const regexp = RegExp('/' + command + ' ' + prefix + '[0-9]{1,10}\\b', 'gi')
          const matches = text.match(regexp)
          if (matches) {
            const artifactMatches = matches.map(match => {
              const artifactMatch = {
                command: command,
                artifact: match.substr(command.length + 2)
              }
              return artifactMatch
            })
            artifacts = artifacts.concat(artifactMatches)
          }
        })
      })
    }
    return artifacts
  }

  async rerunCheck (context) {
    const prContext = context
    let prNumber

    if (context.name === 'check_suite') {
      prNumber = context.payload.check_suite.pull_requests[0].number
      const appId = context.payload.check_suite.app.id
      if (appId !== process.env.APP_ID) {
        return
      }
    } else {
      prNumber = context.payload.check_run.check_suite.pull_requests[0].number
      const checkName = context.payload.check_run.name
      if (checkName !== 'rally/validator') {
        return
      }
    }

    const prResponse = await context.github.pulls.get({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: prNumber
    })
    prContext.payload.pull_request = prResponse.data

    this.handlePullRequest(prContext)
  }

  parseArtifact (artifactName) {
    const artifact = {}
    const typeMapping = {
      D: 'defect',
      DE: 'defect',
      DS: 'defectsuite',
      TA: 'task',
      TC: 'testcase',
      S: 'hierarchicalrequirement',
      US: 'hierarchicalrequirement'
    }

    artifact.prefix = artifactName.match(/([A-Z]{1,2})/i)[0]
    artifact.number = artifactName.match(/[1-9].*/)[0]
    artifact.rallyType = typeMapping[artifact.prefix]

    return artifact
  }

  async validateArtifact (rallyClient, key, property, pr, config) {
    try {
      if (key !== null && key !== undefined) {
        const githubArtifact = this.parseArtifact(key)
        const queryResponse = await rallyClient.query({
          type: githubArtifact.rallyType,
          start: 1,
          pageSize: 2,
          limit: 20,
          order: 'Rank',
          scope: {
            workspace: config.rally.workspace
          },
          fetch: ['FormattedID', 'Name', 'Description', 'ScheduleState', 'Project', 'Connections'],
          query: queryUtils.where('FormattedID', '=', githubArtifact.number),
          requestOptions: {}
        })

        let status
        let projectName
        let validState
        let statusIcon
        let isValid
        if (queryResponse.TotalResultCount === 0) {
          status = 'missing'
          projectName = 'missing'
          validState = 'failed'
        } else {
          const artifact = queryResponse.Results[0]
          status = artifact.ScheduleState
          projectName = artifact.Project._refObjectName
          isValid = (config.artifactStatuses.includes(status) && config.rallyProjects.includes(projectName))
          validState = isValid ? 'passed' : 'failed'
          statusIcon = isValid ? ':heavy_check_mark:' : ':heavy_exclamation_mark:'
        }

        const artifactStatus = { key: key, property: property, status: status, projectName: projectName, isValid: isValid, validState: validState, statusIcon: statusIcon, artifact: queryResponse.Results[0] }
        return artifactStatus
      }
    } catch (e) {
      this.robot.log.error(e)
      throw e
    }
  }

  async promoteArtifact (rallyClient, artifact, config) {
    try {
      const key = artifact.artifact
      if (key !== null && key !== undefined) {
        const githubArtifact = this.parseArtifact(key)
        console.log('Client:', rallyClient)
        const queryResponse = await rallyClient.query({
          type: githubArtifact.rallyType,
          start: 1,
          pageSize: 2,
          limit: 20,
          order: 'Rank',
          scope: {
            workspace: config.rally.workspace
          },
          fetch: ['FormattedID', 'Name', 'Description', 'ScheduleState', 'Project'],
          query: queryUtils.where('FormattedID', '=', githubArtifact.number),
          requestOptions: {}
        })
        console.log('Query Response:', queryResponse)
        if (queryResponse.TotalResultCount !== 0) {
          await this.setArtifactScheduleState(rallyClient, queryResponse.Results[0]._ref, 'Completed')
        }
      }
    } catch (e) {
      this.robot.log.error(e)
      throw e
    }
  }

  async updateRallyConnections (rallyClient, rallyArtifacts, pr, config) {
    const commitList = rallyArtifacts.commits.commitsWithArtifact.map(commit => commit.rally)
    const allArtifacts = [...commitList, ...rallyArtifacts.titleList, ...rallyArtifacts.bodyList, ...rallyArtifacts.labelList]
    const validArtifacts = allArtifacts.filter(artifact => artifact.isValid)

    // get a set of Artifacts with unique key value
    const uniqueArtifacts = []
    const map = new Map()
    for (const artifact of validArtifacts) {
      if (!map.has(artifact.key)) {
        map.set(artifact.key, true)
        uniqueArtifacts.push(artifact)
      }
    }

    // Get a list of all PRs for this artifact
    await uniqueArtifacts.forEach(async artifact => {
      const queryResponse = await rallyClient.query({
        ref: artifact.artifact.Connections._ref,
        start: 1,
        pageSize: 2,
        limit: 20,
        scope: {
          workspace: config.rally.workspace
        },
        fetch: ['Url'],
        requestOptions: {}
      })
      // Add this PR to the artifact if it hasn't already been added
      if (!queryResponse.Results.some(result => result.url === pr.html_url)) {
        this.createRallyPullRequest(rallyClient, artifact.artifact._ref, pr)
      }
    })
  }

  async createRallyPullRequest (rallyClient, ref, pr) {
    try {
      await rallyClient.create({
        type: 'pullrequest',
        data: {
          ExternalID: pr.number,
          ExternalFormattedId: pr.number,
          Artifact: ref,
          Name: pr.title,
          Url: pr.html_url
        },
        requestOptions: {}
      })
    } catch (e) {
      // Ignore Invalid key error. It's an uncaught error that should be handled in the Rally wrapper, but isn't.
      if (!e.toString().includes('Invalid key')) {
        this.robot.log.error(e)
        throw e
      }
    }
  }

  async setArtifactScheduleState (rallyClient, ref, state) {
    try {
      const validStates = ['Defined', 'In-Progress', 'Completed', 'Accepted']
      if (!validStates.includes(state)) {
        throw new Error('State:', state, 'is not a valid value')
      }
      const updateResponse = await rallyClient.update({
        ref: ref,
        data: {
          ScheduleState: state
        },
        requestOptions: {}
      })
      this.robot.log.debug('Update Response: ', updateResponse)
    } catch (e) {
      // Ignore Invalid key error. It's an uncaught error that should be handled in the Rally wrapper, but isn't.
      if (!e.toString().includes('Invalid key')) {
        this.robot.log.error(e)
        throw e
      }
    }
  }
}

// Load the Library
module.exports = RallyValidate