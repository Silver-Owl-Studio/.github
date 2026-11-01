import * as YAML from 'yaml'

export interface dependencyAlert {
  alertState: string,
  ghsaId: string,
  cvss: number
}

export interface updatedDependency extends dependencyAlert {
  dependencyName: string,
  dependencyType: string,
  updateType: string,
  directory: string,
  packageEcosystem: string,
  targetBranch: string,
  prevVersion: string,
  newVersion: string,
  compatScore: number,
  maintainerChanges: boolean,
  dependencyGroup: string
}

export interface alertLookup {
    (dependencyName: string, dependencyVersion: string, directory: string): Promise<dependencyAlert>;
}

export interface scoreLookup {
    (dependencyName: string, previousVersion: string, newVersion: string, ecosystem: string): Promise<number>;
}

function branchNameToDirectoryName (chunks: string[], delimiter: string, updatedDependencies: any, dependencyGroup: string): string {
  // We can always slice after the first 2 pieces, because they will always contain "dependabot" followed by the name
  // of the package ecosystem. e.g. "dependabot/npm_and_yarn".
  const sliceStart = 2
  let sliceEnd = chunks.length

  // If the delimiter is "-", we assume the last piece of the branch name is a version number.
  if (delimiter === '-') {
    sliceEnd -= 1
  }

  if (dependencyGroup) {
    // After replacing "/" in the dependency group with the delimiter, which could also be "/", we count how many pieces
    // the dependency group would split into by the delimiter, and slicing that amount off the end of the branch name.
    // e.g. "eslint/plugins" and a delimiter of "-" would show up in the branch name as "eslint-plugins".
    sliceEnd -= dependencyGroup.replace('/', delimiter).split(delimiter).length

    return `/${chunks.slice(sliceStart, sliceEnd).join('/')}`
  }

  // If there is more than 1 dependency name being updated, we assume 1 piece of the branch name will be "and".
  if (updatedDependencies.length > 1) {
    sliceEnd -= 1
  }

  updatedDependencies.forEach(dependency => {
    // After replacing "/" in the dependency name with the delimiter, which could also be "/", we count how many pieces
    // the dependency name would split into by the delimiter, and slicing that amount off the end of the branch name.
    // e.g. "@types/twilio-video" and a delimiter of "-" would show up in the branch name as "types-twilio-video".
    sliceEnd -= dependency['dependency-name'].replace('/', delimiter).split(delimiter).length
  })

  return `/${chunks.slice(sliceStart, sliceEnd).join('/')}`
}

interface recoveredVersions {
  prev: string,
  next: string,
  updateType: string
}

// Grouped PRs carry one `Updates `name` from X to Y` line per member. Bind each pair to its YAML member by exact
// name. Any missing, extra, duplicate or unclassifiable evidence throws, so no partial group is ever returned.
function recoverNamedVersions (commitMessage: string, dependencies: any[]): recoveredVersions[] {
  const names: string[] = []
  dependencies.forEach(dependency => {
    const name = dependency?.['dependency-name']
    if (typeof name !== 'string' || name === '') {
      throw new Error('Grouped update metadata has a dependency without a valid name.')
    }
    if (names.includes(name)) {
      throw new Error(`Grouped update metadata lists '${name}' more than once.`)
    }
    names.push(name)
  })

  const pairs = new Map<string, { from: string, to: string }>()
  const candidates = commitMessage.match(/^Updates `.*$/gm) ?? []
  candidates.forEach(line => {
    const parsed = line.match(/^Updates `(?<name>[^`]+)` from (?<from>\d+\.\d+\.\d+) to (?<to>\d+\.\d+\.\d+)$/)
    if (!parsed?.groups) {
      throw new Error(`Unsupported grouped update version line: ${line}`)
    }
    if (pairs.has(parsed.groups.name)) {
      throw new Error(`Grouped update metadata has more than one version pair for '${parsed.groups.name}'.`)
    }
    pairs.set(parsed.groups.name, { from: parsed.groups.from, to: parsed.groups.to })
  })

  pairs.forEach((_pair, name) => {
    if (!names.includes(name)) {
      throw new Error(`Grouped update metadata has a version pair for unlisted dependency '${name}'.`)
    }
  })

  return dependencies.map((dependency, index) => {
    const pair = pairs.get(names[index])
    if (!pair) {
      throw new Error(`Grouped update metadata has no version pair for '${names[index]}'.`)
    }
    const updateType = dependency['update-type'] || calculateUpdateType(pair.from, pair.to)
    if (!updateType) {
      throw new Error(`Cannot classify the update for '${names[index]}'.`)
    }
    return { prev: pair.from, next: pair.to, updateType }
  })
}

export async function parse (commitMessage: string, body: string, branchName: string, mainBranch: string, lookup?: alertLookup, getScore?: scoreLookup): Promise<Array<updatedDependency>> {
  const bumpFragment = commitMessage.match(/^Bumps .* from (?<from>v?\d[^ ]*) to (?<to>v?\d[^ ]*)\.$/m)
  const updateFragment = commitMessage.match(/^Update .* requirement from \S*? ?(?<from>v?\d\S*) to \S*? ?(?<to>v?\d\S*)$/m)
  const yamlFragment = commitMessage.match(/^-{3}\n(?<dependencies>[\S|\s]*?)\n^\.{3}\n/m)
  const groupName = commitMessage.match(/dependency-group:\s(?<name>\S*)/m)
  const newMaintainer = !!body.match(/Maintainer changes/m)
  const lookupFn = lookup ?? (() => Promise.resolve({ alertState: '', ghsaId: '', cvss: 0 }))
  const scoreFn = getScore ?? (() => Promise.resolve(0))

  if (yamlFragment?.groups && branchName.startsWith('dependabot')) {
    const data = YAML.parse(yamlFragment.groups.dependencies)

    // Since we are on the `dependabot` branch (9 letters), the 10th letter in the branch name is the delimiter
    const delim = branchName[10]
    const chunks = branchName.split(delim)
    const prev = bumpFragment?.groups?.from ?? (updateFragment?.groups?.from ?? '')
    const next = bumpFragment?.groups?.to ?? (updateFragment?.groups?.to ?? '')
    const dependencyGroup = groupName?.groups?.name ?? ''

    if (data['updated-dependencies']) {
      const dependencies = data['updated-dependencies']

      // Named recovery: several members, no global Bumps/Update pair, and at least one member without an explicit
      // update-type. The whole candidate is validated here, before any lookup or score callback runs.
      const recovered = (!bumpFragment && !updateFragment && Array.isArray(dependencies) && dependencies.length > 1 &&
        dependencies.some(dependency => !dependency?.['update-type']))
        ? recoverNamedVersions(commitMessage, dependencies)
        : undefined

      const dirname = branchNameToDirectoryName(chunks, delim, dependencies, dependencyGroup)

      return await Promise.all(dependencies.map(async (dependency, index) => {
        const lastVersion = recovered ? recovered[index].prev : (index === 0 ? prev : '')
        const nextVersion = recovered ? recovered[index].next : (index === 0 ? next : '')
        const updateType = recovered ? recovered[index].updateType : (dependency['update-type'] || calculateUpdateType(lastVersion, nextVersion))
        return {
          dependencyName: dependency['dependency-name'],
          dependencyType: dependency['dependency-type'],
          updateType,
          directory: dirname,
          packageEcosystem: chunks[1],
          targetBranch: mainBranch,
          prevVersion: lastVersion,
          newVersion: nextVersion,
          compatScore: await scoreFn(dependency['dependency-name'], lastVersion, nextVersion, chunks[1]),
          maintainerChanges: newMaintainer,
          dependencyGroup,
          ...await lookupFn(dependency['dependency-name'], lastVersion, dirname)
        }
      }))
    }
  }

  return Promise.resolve([])
}

export function calculateUpdateType (lastVersion: string, nextVersion: string) {
  if (!lastVersion || !nextVersion || lastVersion === nextVersion) {
    return ''
  }

  const lastParts = lastVersion.replace('v', '').split('.')
  const nextParts = nextVersion.replace('v', '').split('.')

  if (lastParts[0] !== nextParts[0]) {
    return 'version-update:semver-major'
  }

  if (lastParts.length < 2 || nextParts.length < 2 || lastParts[1] !== nextParts[1]) {
    return 'version-update:semver-minor'
  }

  return 'version-update:semver-patch'
}
