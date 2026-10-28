import * as core from '@actions/core'
import * as updateMetadata from './update_metadata'
import * as Output from './output'

const FIXTURE = 'Bump the synthetic-group group with 2 updates\n\nUpdates `alpha-widget` from 1.4.1 to 1.4.2\nUpdates `beta-widget` from 2.6.0 to 2.7.0\n\n---\nupdated-dependencies:\n- dependency-name: alpha-widget\n  dependency-type: direct:development\n- dependency-name: beta-widget\n  dependency-type: direct:development\ndependency-group: synthetic-group\n...\n'

const HEAD = 'Bump the synthetic-group group with 2 updates\n\n'
const ALPHA_LINE = 'Updates `alpha-widget` from 1.4.1 to 1.4.2'
const BETA_LINE = 'Updates `beta-widget` from 2.6.0 to 2.7.0'
const ALPHA_YAML = '- dependency-name: alpha-widget\n  dependency-type: direct:development\n'
const BETA_YAML = '- dependency-name: beta-widget\n  dependency-type: direct:development\n'

// Every variant ends with the YAML terminator followed by the original final newline.
function build (updateLines: string[], members: string[]): string {
  return HEAD + updateLines.join('\n') + '\n\n---\nupdated-dependencies:\n' + members.join('') + 'dependency-group: synthetic-group\n...\n'
}

const BODY = ''
const BRANCH = 'dependabot/npm_and_yarn/synthetic-group'
const MAIN = 'main'

const EXPECTED = [
  {
    dependencyName: 'alpha-widget',
    dependencyType: 'direct:development',
    updateType: 'version-update:semver-patch',
    directory: '/',
    packageEcosystem: 'npm_and_yarn',
    targetBranch: 'main',
    prevVersion: '1.4.1',
    newVersion: '1.4.2',
    compatScore: 77,
    maintainerChanges: false,
    dependencyGroup: 'synthetic-group',
    alertState: 'SYNTHETIC_ALERT',
    ghsaId: 'GHSA-SYNTH-0001',
    cvss: 5.5
  },
  {
    dependencyName: 'beta-widget',
    dependencyType: 'direct:development',
    updateType: 'version-update:semver-minor',
    directory: '/',
    packageEcosystem: 'npm_and_yarn',
    targetBranch: 'main',
    prevVersion: '2.6.0',
    newVersion: '2.7.0',
    compatScore: 77,
    maintainerChanges: false,
    dependencyGroup: 'synthetic-group',
    alertState: 'SYNTHETIC_ALERT',
    ghsaId: 'GHSA-SYNTH-0001',
    cvss: 5.5
  }
]

describe('grouped version recovery', () => {
  let getAlert: jest.Mock
  let getScore: jest.Mock

  beforeEach(() => {
    jest.restoreAllMocks()

    jest.spyOn(core, 'info').mockImplementation(jest.fn())
    jest.spyOn(core, 'setOutput').mockImplementation(jest.fn())
    jest.spyOn(core, 'startGroup').mockImplementation(jest.fn())
    jest.spyOn(core, 'endGroup').mockImplementation(jest.fn())

    getAlert = jest.fn(async () => Promise.resolve({ alertState: 'SYNTHETIC_ALERT', ghsaId: 'GHSA-SYNTH-0001', cvss: 5.5 }))
    getScore = jest.fn(async () => Promise.resolve(77))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('builder reproduces the exact supplied fixture including the final newline', () => {
    expect(build([ALPHA_LINE, BETA_LINE], [ALPHA_YAML, BETA_YAML])).toBe(FIXTURE)
    expect(FIXTURE.endsWith('...\n')).toBe(true)
  })

  test('G1 exact synthetic two-member group recovers each own pair and type', async () => {
    const result = await updateMetadata.parse(FIXTURE, BODY, BRANCH, MAIN, getAlert, getScore)

    expect(result).toHaveLength(2)
    expect(result).toEqual(EXPECTED)
    expect(getAlert).toHaveBeenCalledWith('alpha-widget', '1.4.1', '/')
    expect(getAlert).toHaveBeenCalledWith('beta-widget', '2.6.0', '/')
    expect(getScore).toHaveBeenCalledWith('alpha-widget', '1.4.1', '1.4.2', 'npm_and_yarn')
    expect(getScore).toHaveBeenCalledWith('beta-widget', '2.6.0', '2.7.0', 'npm_and_yarn')

    Output.set(result)

    expect(core.startGroup).toHaveBeenCalledWith(expect.stringContaining('Outputting metadata for 2 updated dependencies'))
    expect(core.endGroup).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('update-type', 'version-update:semver-minor')
    expect(core.setOutput).toHaveBeenCalledWith('updated-dependencies-json', EXPECTED)
  })

  test('G2 reversed named Updates lines give the identical name-bound result in YAML order', async () => {
    const message = build([BETA_LINE, ALPHA_LINE], [ALPHA_YAML, BETA_YAML])
    const result = await updateMetadata.parse(message, BODY, BRANCH, MAIN, getAlert, getScore)

    expect(result).toHaveLength(2)
    expect(result).toEqual(EXPECTED)

    Output.set(result)

    expect(core.setOutput).toHaveBeenCalledWith('update-type', 'version-update:semver-minor')
    expect(core.setOutput).toHaveBeenCalledWith('updated-dependencies-json', EXPECTED)
  })

  const invalidVariants: Array<[string, string]> = [
    ['G3 missing beta-widget pair', build([ALPHA_LINE], [ALPHA_YAML, BETA_YAML])],
    ['G4a identical duplicate alpha-widget pair', build([ALPHA_LINE, ALPHA_LINE, BETA_LINE], [ALPHA_YAML, BETA_YAML])],
    ['G4b conflicting duplicate alpha-widget pair', build([ALPHA_LINE, 'Updates `alpha-widget` from 2.0.0 to 3.0.0', BETA_LINE], [ALPHA_YAML, BETA_YAML])],
    ['G5a beta-widget pair renamed to gamma-widget', build([ALPHA_LINE, 'Updates `gamma-widget` from 2.6.0 to 2.7.0'], [ALPHA_YAML, BETA_YAML])],
    ['G5b extra unmatched gamma-widget pair', build([ALPHA_LINE, BETA_LINE, 'Updates `gamma-widget` from 3.0.0 to 3.1.0'], [ALPHA_YAML, BETA_YAML])],
    ['G6 duplicate alpha-widget YAML member', build([ALPHA_LINE, BETA_LINE], [ALPHA_YAML, ALPHA_YAML, BETA_YAML])],
    ['G7a not-a-version source version', build(['Updates `alpha-widget` from not-a-version to 1.4.2', BETA_LINE], [ALPHA_YAML, BETA_YAML])],
    ['G7b identical old/new pair for a missing-type member', build(['Updates `alpha-widget` from 1.4.1 to 1.4.1', BETA_LINE], [ALPHA_YAML, BETA_YAML])]
  ]

  test.each(invalidVariants)('%s rejects the whole group before any callback', async (_name, message) => {
    await expect(updateMetadata.parse(message, BODY, BRANCH, MAIN, getAlert, getScore)).rejects.toBeInstanceOf(Error)

    expect(getAlert).not.toHaveBeenCalled()
    expect(getScore).not.toHaveBeenCalled()
  })
})
