import type {
  AiOperation,
  AiProvider,
  AiProviderResponse,
  StructuredModelRequest,
} from './contracts'

export type FakeAiFixtureOutput =
  | unknown
  | ((request: StructuredModelRequest, callIndex: number) => unknown | Promise<unknown>)

export interface FakeAiFixture {
  operation: AiOperation
  output: FakeAiFixtureOutput
  modelId?: string
  requestId?: string
}

export interface FakeAiCall {
  index: number
  request: StructuredModelRequest
}

export interface FakeAiProviderOptions {
  providerId?: string
  modelId?: string
  fixtures?: readonly FakeAiFixture[]
}

/**
 * Deterministic AiProvider for unit/integration tests.
 *
 * Fixtures are consumed in declaration order per operation. Unexpected calls
 * fail immediately so a test cannot silently fall back to a real model.
 */
export class FakeAiProvider implements AiProvider {
  readonly id: string
  private readonly defaultModelId: string
  private readonly fixtureQueue: FakeAiFixture[]
  private readonly callLog: FakeAiCall[] = []

  constructor(options: FakeAiProviderOptions = {}) {
    this.id = options.providerId ?? 'fake-ai'
    this.defaultModelId = options.modelId ?? 'fake-model'
    this.fixtureQueue = [...(options.fixtures ?? [])]
  }

  async invokeStructured(request: StructuredModelRequest): Promise<AiProviderResponse> {
    const fixtureIndex = this.fixtureQueue.findIndex(fixture => fixture.operation === request.operation)
    if (fixtureIndex < 0) {
      throw new Error(`FakeAiProvider has no fixture for operation ${request.operation}`)
    }

    const [fixture] = this.fixtureQueue.splice(fixtureIndex, 1)
    const callIndex = this.callLog.length
    this.callLog.push({ index: callIndex, request })

    const output = typeof fixture.output === 'function'
      ? await fixture.output(request, callIndex)
      : fixture.output

    return {
      output,
      providerId: this.id,
      modelId: fixture.modelId ?? this.defaultModelId,
      requestId: fixture.requestId ?? `fake-request-${callIndex + 1}`,
    }
  }

  get calls(): readonly FakeAiCall[] {
    return this.callLog
  }

  requestsFor(operation: AiOperation): StructuredModelRequest[] {
    return this.callLog
      .filter(call => call.request.operation === operation)
      .map(call => call.request)
  }

  remainingFixtures(operation?: AiOperation): number {
    if (!operation) return this.fixtureQueue.length
    return this.fixtureQueue.filter(fixture => fixture.operation === operation).length
  }

  assertExhausted(): void {
    if (this.fixtureQueue.length === 0) return
    const pending = this.fixtureQueue.map(fixture => fixture.operation).join(', ')
    throw new Error(`FakeAiProvider still has unused fixtures: ${pending}`)
  }
}

export function fakeAi(fixtures: readonly FakeAiFixture[], options: Omit<FakeAiProviderOptions, 'fixtures'> = {}) {
  return new FakeAiProvider({ ...options, fixtures })
}
