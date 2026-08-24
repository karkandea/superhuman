export function normalizeComposerVerificationText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

export function composerTextMatches(expected, candidates) {
  const normalizedExpected = normalizeComposerVerificationText(expected)
  if (!normalizedExpected) return false
  return candidates.some(candidate => normalizeComposerVerificationText(candidate) === normalizedExpected)
}

export function composerVerificationLengths(expected, candidates) {
  const normalizedExpected = normalizeComposerVerificationText(expected)
  const actualLengths = candidates.map(candidate => normalizeComposerVerificationText(candidate).length)
  return {
    expectedChars: normalizedExpected.length,
    actualChars: actualLengths.length ? Math.max(...actualLengths) : 0,
  }
}
